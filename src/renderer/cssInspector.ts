import postcss from 'postcss';
import { applyCssPatch, applySourcePatch, buildCssSourceMap, buildSourceMap, buildVisualDocument, sourceHash, type CssOperation, type CssRule } from '../core/source';
import { joinPath, parentPath, relativeTo } from './utils';

export interface InspectorDocument { id: string; path: string; content: string; dirty?: boolean; remote?: unknown; }
export interface StylesheetLink { href: string; path: string | null; context: string[]; reason?: string; }
export interface CssRuleSource {
  id: string; documentId: string; path: string; sourceHash: string; css: string; cssHash: string;
  kind: 'inline' | 'internal' | 'external'; rule: CssRule; line: number; offset: number;
  contentStart?: number; contentEnd?: number; nodeId?: string; context: string[]; unsupported?: string;
}
export interface RuleMatch { source: CssRuleSource; status: 'matched' | 'unknown'; count: number | null; reason?: string; }
export type SelectorMatcher = (selector: string) => { selected: boolean; count: number };

/** Windows local buffers share an identity regardless of slash style or drive/path casing. */
export function localPathKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}
export function localDocumentForPath<T extends InspectorDocument>(documents: T[], path: string): T | undefined {
  const matches = documents.filter(d => !d.remote && localPathKey(d.path) === localPathKey(path));
  const dirty = matches.filter(d => d.dirty);
  if (new Set(dirty.map(d => d.content)).size > 1) return undefined;
  return dirty[0] ?? matches[0];
}
export function inspectionRevision(document: InspectorDocument, projectId: string, root: string): string {
  return sourceHash(JSON.stringify([document.id, document.path, document.content, !!document.remote, projectId, root]));
}

/** Resolve only literal local URLs contained by the project; queries do not name files. */
export function stylesheetPath(documentPath: string, root: string, href: string): string | null {
  if (relativeTo(localPathKey(root), localPathKey(documentPath)) === null) return null;
  if (!href.trim() || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(href.trim())) return null;
  let value: string;
  try { value = decodeURIComponent(href.trim().split(/[?#]/, 1)[0]); } catch { return null; }
  if (!value || /[\x00-\x1f\\]/.test(value) || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(value)) return null;
  const candidate = joinPath(value.startsWith('/') ? root : parentPath(documentPath), value);
  const relative = relativeTo(root, candidate);
  return relative === null ? null : joinPath(root, relative).replace(/[\\/]/g, root.includes('\\') ? '\\' : '/');
}
export function linkedStylesheets(document: InspectorDocument, root: string): StylesheetLink[] {
  const map = buildSourceMap(document.content);
  const hasBase = map.nodes.some(n => n.tag === 'base' && n.attributes.href !== undefined);
  return map.nodes.filter(n => n.tag === 'link' && n.attributes.rel?.toLowerCase().split(/\s+/).includes('stylesheet') && n.attributes.href)
    .map(n => {
      const path = hasBase || document.remote ? null : stylesheetPath(document.path, root, n.attributes.href);
      const context = n.attributes.media ? [`media="${n.attributes.media}"`] : [];
      if ('disabled' in n.attributes || n.attributes.rel.toLowerCase().split(/\s+/).includes('alternate')) context.push('Uitgeschakelde of alternatieve stylesheet');
      return { href: n.attributes.href, path, context, reason: path ? undefined : hasBase ? 'Een base-URL vereist handmatige broncontrole.' : 'Geen lokale stylesheet binnen dit project.' };
    });
}
export function collectCssSources(document: InspectorDocument, selectedId: string, externals: InspectorDocument[], links: StylesheetLink[]): { sources: CssRuleSource[]; issues: string[] } {
  const map = buildSourceMap(document.content), sources: CssRuleSource[] = [], issues: string[] = [];
  if (!map.editable) return { sources, issues: ['De HTML-bron is beschermd; CSS-koppelingen worden niet als bewerkbaar aangeboden.'] };
  const add = (owner: InspectorDocument, css: string, kind: CssRuleSource['kind'], key: string, offset: number, extra: Partial<CssRuleSource> = {}) => {
    const cssMap = buildCssSourceMap(css);
    if (!cssMap.editable) { issues.push(`${owner.path}: ${cssMap.issues.join(' ')}`); return; }
    if (kind === 'inline') {
      const root = postcss.parse(css), wrapper = root.first;
      if (root.nodes.length !== 1 || wrapper?.type !== 'rule' || wrapper.selector !== 'a' || wrapper.nodes.some(n => n.type !== 'decl' && n.type !== 'comment')) { issues.push('De inline style bevat geen veilig, enkel declaratieblok; gebruik de broncode.'); return; }
    }
    if (/@import\b/i.test(css)) issues.push(`${owner.path}: @import-regels worden niet gevolgd; open deze bronbestanden handmatig.`);
    for (const rule of cssMap.rules) {
      const nested = cssMap.rules.some(parent => parent.start < rule.start && parent.end > rule.end);
      const ruleOffset = kind === 'inline' ? offset : offset + rule.start;
      sources.push({ ...extra, id: `${key}:${rule.id}`, documentId: owner.id, path: owner.path, sourceHash: sourceHash(owner.content), css, cssHash: cssMap.sourceHash,
        kind, rule, offset: ruleOffset, line: owner.content.slice(0, ruleOffset).split('\n').length, context: [...(extra.context ?? []), ...rule.context],
        unsupported: nested ? 'Geneste CSS vereist controle in de broncode.' : undefined });
    }
  };
  const selected = map.nodes.find(n => n.id === selectedId);
  if (selected?.editable && selected.attributes.style !== undefined) add(document, `a{${selected.attributes.style}}`, 'inline', selected.id, selected.start, { nodeId: selected.id });
  for (const node of map.nodes.filter(n => n.tag === 'style')) {
    let parent = map.nodes.find(n => n.id === node.parentId);
    let protectedContainer = false;
    while (parent) { if (['template', 'noscript', 'svg', 'math'].includes(parent.tag)) protectedContainer = true; parent = map.nodes.find(n => n.id === parent!.parentId); }
    if (protectedContainer) { issues.push('CSS in een template of beschermd element is overgeslagen.'); continue; }
    if (node.attributes.type && node.attributes.type.toLowerCase() !== 'text/css') { issues.push('Een style-blok met een ander type dan text/css is overgeslagen.'); continue; }
    add(document, document.content.slice(node.openEnd, node.closeStart), 'internal', node.id, node.openEnd, { contentStart: node.openEnd, contentEnd: node.closeStart, context: node.attributes.media ? [`media="${node.attributes.media}"`] : [] });
  }
  for (const [index, link] of links.entries()) {
    if (!link.path) { issues.push(`${link.href}: ${link.reason}`); continue; }
    const external = localDocumentForPath(externals, link.path);
    if (!external) { issues.push(externals.some(d => !d.remote && localPathKey(d.path) === localPathKey(link.path!)) ? `${link.href}: meerdere gewijzigde buffers; kies eerst één bronversie.` : `${link.href}: nog niet geladen.`); continue; }
    add(external, external.content, 'external', `${external.id}:${index}`, 0, { context: link.context });
  }
  return { sources, issues: [...new Set(issues)] };
}
/** Native selector matching against inert source DOM; no script execution or computed cascade claims. */
export function browserSelectorMatcher(source: string, selectedId: string): SelectorMatcher {
  const map = buildSourceMap(source);
  const document = new DOMParser().parseFromString(buildVisualDocument(source).replace(/^\uFEFF/, ' '), 'text/html');
  let selected: Element | undefined;
  for (const element of document.querySelectorAll('[data-ftp-node]')) {
    const node = map.nodes.find(n => n.id === element.getAttribute('data-ftp-node'));
    if (!node) continue;
    if (node.id === selectedId) selected = element;
    const original = node.attributes['data-ftp-node'];
    if (original === undefined) element.removeAttribute('data-ftp-node'); else element.setAttribute('data-ftp-node', original);
  }
  return selector => ({ selected: !!selected?.matches(selector), count: document.querySelectorAll(selector).length });
}
export function matchingCssRules(sources: CssRuleSource[], matches: SelectorMatcher): RuleMatch[] {
  const result: RuleMatch[] = [];
  for (const source of sources) {
    if (source.kind === 'inline') { result.push({ source, status: 'matched', count: 1 }); continue; }
    // Pseudo states/elements and nesting depend on runtime or parent CSS context.
    // Do not label those as inactive just because this inert document does not match.
    if (source.unsupported || /[:&]/.test(source.rule.selector) || source.context.some(c => /^@(scope|(?:-\w+-)?keyframes)\b/i.test(c))) {
      result.push({ source, status: 'unknown', count: null, reason: source.unsupported ?? 'Pseudoselector, CSS-scope of animatieregel: overeenkomst niet vastgesteld.' }); continue;
    }
    try {
      const match = matches(source.rule.selector);
      if (match.selected) result.push({ source, status: 'matched', count: match.count });
    } catch { result.push({ source, status: 'unknown', count: null, reason: 'Deze selector wordt niet ondersteund door de inspector.' }); }
  }
  return result;
}
/** A reviewed edit remains tied to its exact document revision and exact declaration. */
export function patchInspectedCss(content: string, source: CssRuleSource, operation: Pick<CssOperation, 'property' | 'value' | 'declarationId'>): string {
  if (sourceHash(content) !== source.sourceHash) throw new Error('De bron is gewijzigd. Selecteer de CSS-regel opnieuw.');
  const changed = applyCssPatch(source.css, { ...operation, expectedSourceHash: source.cssHash, ruleId: source.rule.id });
  if (source.kind === 'external') return changed;
  if (source.kind === 'inline') return applySourcePatch(content, { type: 'setAttribute', nodeId: source.nodeId!, expectedSourceHash: source.sourceHash, name: 'style', value: changed.slice(2, -1) });
  if (/<\/style\b/i.test(changed)) throw new Error('Deze waarde zou het style-blok kunnen sluiten. Bewerk de broncode.');
  const result = content.slice(0, source.contentStart!) + changed + content.slice(source.contentEnd!);
  if (!buildSourceMap(result).editable) throw new Error('Deze CSS-wijziging zou de HTML-structuur veranderen.');
  return result;
}
