import { parse, type DefaultTreeAdapterMap } from 'parse5';
import postcss, { type Rule, type Declaration, type Document } from 'postcss';

/** Offsets are UTF-16 offsets, matching Monaco and String.slice. No DOM serialization is used. */
export interface SourceNode {
  id: string; tag: string; classes: string[]; attributes: Record<string, string>;
  start: number; end: number; openEnd: number; closeStart: number;
  parentId?: string; children: string[]; editable: boolean;
}
export interface SourceMap {
  sourceHash: string; nodes: SourceNode[]; roots: string[]; issues: string[]; editable: boolean;
}
type LocatedNode = DefaultTreeAdapterMap['element'];
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const protectedTags = new Set('script style template noscript iframe object embed svg math'.split(' '));
const structuralTags = new Set('html head body base meta link title'.split(' '));
const dynamicPattern = /<\?|<%|\{\{|\{%|\{\#/;
const dynamicAttribute = /^(?:v-|x-|wire:|:|@|\[|\()/i;

/** This revision token detects stale editor selections; it is not an authentication hash. */
export function sourceHash(source: string): string {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < source.length; i++) {
    a = Math.imul(a ^ source.charCodeAt(i), 0x01000193);
    b = Math.imul(b ^ source.charCodeAt(i), 0x85ebca6b);
  }
  return `${source.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

function parseSource(source: string) {
  const issues: string[] = [];
  // PHP, ASP and template delimiters intentionally block the whole document. This also
  // covers PHP close delimiters embedded in quoted strings and heredocs: no PHP lexer
  // is assumed and no apparently static fragment is treated as safe to edit.
  if (dynamicPattern.test(source)) issues.push('Dynamische PHP-/templatebron: visueel bewerken is geblokkeerd; gebruik de code-editor.');
  // parse5 receives an already decoded string and treats a leading BOM as body
  // text, unlike the browser's byte decoder. Mask only that signature for parsing;
  // one UTF-16 space keeps every source/attribute offset and the original bytes intact.
  const parserSource = source.startsWith('\uFEFF') ? ` ${source.slice(1)}` : source;
  const document = parse(parserSource, { sourceCodeLocationInfo: true, onParseError(error) {
    if (error.code !== 'missing-doctype') issues.push(`HTML moet eerst worden hersteld: ${error.code}.`);
  } });
  const nodes: SourceNode[] = [];
  const originals = new Map<string, LocatedNode>();
  const lastSiblingEnd = new Map<string | undefined, number>();
  const roots: string[] = [];
  function visit(node: DefaultTreeAdapterMap['node'], parent?: SourceNode, protectedParent = false) {
    let nextParent = parent;
    let blocked = protectedParent;
    if ('tagName' in node) {
      if (node.attrs.some(attr => dynamicAttribute.test(attr.name))) issues.push('Dynamische template-attributen: gebruik de code-editor.');
      blocked ||= protectedTags.has(node.tagName) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml';
      const loc = node.sourceCodeLocation;
      if (loc?.startTag) {
        const mapped: SourceNode = {
          id: `n${loc.startOffset}`, tag: node.tagName,
          classes: (node.attrs.find(a => a.name === 'class')?.value ?? '').split(/\s+/).filter(Boolean),
          attributes: Object.fromEntries(node.attrs.map(a => [a.name, a.value])),
          start: loc.startOffset, end: loc.endOffset, openEnd: loc.startTag.endOffset,
          closeStart: loc.endTag?.startOffset ?? loc.endOffset,
          parentId: parent?.id, children: [],
          editable: !blocked && (!!loc.endTag || voidTags.has(node.tagName)),
        };
        if (parent && (mapped.start < parent.openEnd || mapped.end > parent.closeStart)) {
          issues.push('De HTML-parser heeft elementen verplaatst; herstel eerst de HTML-structuur.');
        }
        if (mapped.start < (lastSiblingEnd.get(parent?.id) ?? 0)) {
          issues.push('De HTML-parser heeft elementen verplaatst; herstel eerst de HTML-structuur.');
        }
        lastSiblingEnd.set(parent?.id, mapped.end);
        if (!loc.endTag && !voidTags.has(node.tagName)) {
          issues.push('Een element heeft geen expliciete sluit-tag; herstel eerst de HTML-structuur.');
        }
        nodes.push(mapped); originals.set(mapped.id, node);
        if (parent) parent.children.push(mapped.id); else roots.push(mapped.id);
        nextParent = mapped;
      }
      if (node.tagName === 'template' && 'content' in node) visit(node.content as DefaultTreeAdapterMap['node'], nextParent, true);
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child, nextParent, blocked);
  }
  visit(document);
  if (issues.length) for (const node of nodes) node.editable = false;
  return { map: { sourceHash: sourceHash(source), nodes, roots, issues: [...new Set(issues)], editable: !issues.length } satisfies SourceMap, originals };
}

export function buildSourceMap(source: string): SourceMap { return parseSource(source).map; }
export function findSourceNode(map: SourceMap, offset: number): SourceNode | undefined {
  return map.nodes.filter(n => n.start <= offset && offset < n.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
}

/** Instrumentation only, NOT sanitization. Display exclusively in the isolated preview. */
export function buildVisualDocument(source: string): string {
  const { map, originals } = parseSource(source);
  // Do not expose PHP source in a browser or pretend to render server-side templates.
  if (dynamicPattern.test(source) || map.issues.some(issue => issue.startsWith('Dynamische'))) return '<!doctype html><html><body><p>PHP-/templatevoorbeeld vereist de ingestelde lokale server. Visueel bewerken is geblokkeerd.</p></body></html>';
  const patches: Array<{ start: number; end: number; text: string }> = [];
  for (const node of map.nodes) {
    const old = originals.get(node.id)?.sourceCodeLocation?.attrs?.['data-ftp-node'];
    if (old) patches.push({ start: old.startOffset, end: old.endOffset, text: `data-ftp-node="${node.id}"` });
    else {
      const match = /\/?\s*>$/.exec(source.slice(node.start, node.openEnd));
      if (match) patches.push({ start: node.start + match.index, end: node.start + match.index, text: ` data-ftp-node="${node.id}"` });
    }
  }
  return patchRanges(source, patches);
}

export type SourceOperation = { expectedSourceHash: string; nodeId: string } & (
  { type: 'setText'; text: string } |
  { type: 'setAttribute'; name: string; value: string | null } |
  { type: 'insert'; html: string; position: 'before' | 'after' | 'inside' } |
  { type: 'duplicate' } |
  { type: 'remove' } |
  { type: 'move'; targetId: string; position: 'before' | 'after' | 'inside' }
);
function patchRanges(source: string, patches: Array<{ start: number; end: number; text: string }>): string {
  let result = source;
  for (const p of patches.sort((a, b) => b.start - a.start)) result = result.slice(0, p.start) + p.text + result.slice(p.end);
  return result;
}
function escapeText(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttribute(value: string): string { return escapeText(value).replace(/"/g, '&quot;'); }
function checkRevision(source: string, expected: string) {
  if (!expected || expected !== sourceHash(source)) throw new Error('De bron is gewijzigd. Selecteer het element of de CSS-regel opnieuw.');
}
export function applySourcePatch(source: string, operation: SourceOperation): string {
  checkRevision(source, operation.expectedSourceHash);
  const { map, originals } = parseSource(source);
  if (!map.editable) throw new Error(map.issues.join('\n'));
  const node = map.nodes.find(n => n.id === operation.nodeId);
  if (!node?.editable) throw new Error('Dit element is beschermd of heeft geen expliciete sluit-tag. Bewerk de broncode.');
  let result = source;
  const replace = (start: number, end: number, text: string) => source.slice(0, start) + text + source.slice(end);
  if (operation.type === 'setText') {
    if (voidTags.has(node.tag) || node.children.length || source.slice(node.openEnd, node.closeStart).includes('<')) throw new Error('Tekstbewerking is alleen veilig voor een element met uitsluitend tekst.');
    result = replace(node.openEnd, node.closeStart, escapeText(operation.text));
  } else if (operation.type === 'setAttribute') {
    const name = operation.name.toLowerCase();
    if (!/^[a-z_][a-z\d_.:-]*$/.test(name) || /^(on|data-ftp-node$|srcdoc$)/i.test(name)) throw new Error('Dit attribuut kan niet visueel worden bewerkt.');
    if (operation.value !== null && /^(?:href|src|action|formaction|poster|data|xlink:href)$/.test(name) && /^[\u0000-\u0020]*(?:javascript|vbscript|data)\s*:/i.test(operation.value.replace(/[\r\n\t]/g, ''))) throw new Error('Actieve URL-schema’s zijn niet toegestaan in de visuele editor.');
    const attr = originals.get(node.id)?.sourceCodeLocation?.attrs?.[name];
    const text = operation.value === null ? '' : `${name}="${escapeAttribute(operation.value)}"`;
    if (attr) result = replace(attr.startOffset, attr.endOffset, text);
    else if (operation.value !== null) {
      const ending = /\/?\s*>$/.exec(source.slice(node.start, node.openEnd));
      if (!ending) throw new Error('De openingstag kan niet veilig worden aangepast.');
      result = replace(node.start + ending.index, node.start + ending.index, ` ${text}`);
    }
  } else if (operation.type === 'insert') {
    if (operation.html.length > 100000) throw new Error('Het in te voegen blok is te groot.');
    const fragment = buildSourceMap(operation.html);
    if (!fragment.editable || !fragment.nodes.length || fragment.nodes.some(n => !n.editable || structuralTags.has(n.tag))) throw new Error('Voeg uitsluitend geldige statische HTML-blokken in, zonder scripts of documentstructuur.');
    if (fragment.nodes.some(n => Object.entries(n.attributes).some(([name, value]) => /^on|^srcdoc$/i.test(name) || /^(?:href|src|action|formaction|poster|data|xlink:href)$/i.test(name) && /^[\u0000-\u0020]*(?:javascript|vbscript|data)\s*:/i.test(value.replace(/[\r\n\t]/g, ''))))) throw new Error('Actieve scripts of URL-schema’s zijn niet toegestaan in bouwblokken.');
    if (operation.position === 'inside' && (voidTags.has(node.tag) || structuralTags.has(node.tag) && node.tag !== 'body')) throw new Error('In dit element kan geen blok worden geplaatst.');
    if (operation.position !== 'inside' && structuralTags.has(node.tag)) throw new Error('Blokken naast de documentstructuur zijn niet toegestaan.');
    const at = operation.position === 'before' ? node.start : operation.position === 'after' ? node.end : node.closeStart;
    result = replace(at, at, operation.html);
  } else {
    if (structuralTags.has(node.tag)) throw new Error('De documentstructuur kan alleen in de code-editor worden gewijzigd.');
    if (map.nodes.some(n => n.start >= node.start && n.end <= node.end && !n.editable)) throw new Error('Dit blok bevat beschermde of impliciet gesloten elementen.');
    if (operation.type === 'remove') result = replace(node.start, node.end, '');
    else if (operation.type === 'duplicate') result = replace(node.end, node.end, source.slice(node.start, node.end));
    else {
      const target = map.nodes.find(n => n.id === operation.targetId);
      if (!target?.editable || target.id === node.id || (target.start >= node.start && target.end <= node.end)) throw new Error('Deze verplaatsing heeft geen veilig doel.');
      if (operation.position === 'inside' && (voidTags.has(target.tag) || structuralTags.has(target.tag) && target.tag !== 'body')) throw new Error('In dit element kan geen blok worden geplaatst.');
      const at = operation.position === 'before' ? target.start : operation.position === 'after' ? target.end : target.closeStart;
      if (at > node.start && at < node.end) throw new Error('Een element kan niet in zichzelf worden verplaatst.');
      result = patchRanges(source, [{ start: node.start, end: node.end, text: '' }, { start: at, end: at, text: source.slice(node.start, node.end) }]);
    }
  }
  const after = buildSourceMap(result);
  if (!after.editable) throw new Error('De wijziging zou ongeldige of dynamische HTML maken; bron is behouden.');
  return result;
}

export interface CssDeclaration { id: string; property: string; value: string; important: boolean; start: number; end: number; }
export interface CssRule { id: string; selector: string; context: string[]; start: number; end: number; declarations: CssDeclaration[]; }
export interface CssSourceMap { sourceHash: string; rules: CssRule[]; issues: string[]; editable: boolean; }
function cssRange(node: Rule | Declaration) {
  const start = node.source?.start?.offset, end = node.source?.end?.offset;
  if (start === undefined || end === undefined) throw new Error('CSS-bronpositie ontbreekt.');
  // PostCSS source offsets delimit a half-open range, just like String.slice.
  return { start, end };
}
function parseCss(source: string) {
  const root = postcss.parse(source, { from: undefined });
  const rules: CssRule[] = [];
  const originals = new Map<string, Rule>();
  root.walkRules(rule => {
    const range = cssRange(rule), context: string[] = [];
    for (let parent: Rule['parent'] | Document = rule.parent; parent; parent = parent.parent) if (parent.type === 'atrule') context.unshift(`@${parent.name} ${parent.params}`);
    const mapped: CssRule = { id: `c${range.start}`, selector: rule.selector, context, ...range, declarations: [] };
    for (const child of rule.nodes) if (child.type === 'decl') {
      const span = cssRange(child);
      mapped.declarations.push({ id: `d${span.start}`, property: child.prop, value: child.value, important: !!child.important, ...span });
    }
    rules.push(mapped); originals.set(mapped.id, rule);
  });
  return { root, rules, originals };
}
export function buildCssSourceMap(source: string): CssSourceMap {
  try {
    if (/<\?|<%|\{\{|\{%/.test(source)) throw new Error('Dynamische CSS kan niet visueel worden bewerkt.');
    return { sourceHash: sourceHash(source), rules: parseCss(source).rules, issues: [], editable: true };
  } catch (error) { return { sourceHash: sourceHash(source), rules: [], issues: [String(error)], editable: false }; }
}
export interface CssOperation { expectedSourceHash: string; ruleId: string; property: string; value: string | null; declarationId?: string; }
export function applyCssPatch(source: string, operation: CssOperation): string {
  checkRevision(source, operation.expectedSourceHash);
  const map = buildCssSourceMap(source);
  if (!map.editable) throw new Error(map.issues.join('\n'));
  const rule = map.rules.find(r => r.id === operation.ruleId);
  if (!rule || !/^(?:--[\w-]+|-?[a-zA-Z][\w-]*)$/.test(operation.property)) throw new Error('Ongeldige CSS-regel of eigenschap.');
  const matches = rule.declarations.filter(d => d.property === operation.property);
  if (!operation.declarationId && matches.length > 1) throw new Error('Deze eigenschap komt meermaals voor. Selecteer de exacte declaratie.');
  const decl = operation.declarationId ? rule.declarations.find(d => d.id === operation.declarationId && d.property === operation.property) : matches[0];
  if (operation.declarationId && !decl) throw new Error('De CSS-declaratie bestaat niet meer.');
  let valueHasPriority = false;
  if (operation.value !== null) {
    const trialRoot = parseCss(`a{${operation.property}:${operation.value}}`).root;
    const trial = trialRoot.first;
    if (!operation.value.trim() || trialRoot.nodes.length !== 1 || trial?.type !== 'rule' || trial.nodes.length !== 1 || trial.nodes[0].type !== 'decl' || trial.nodes[0].prop !== operation.property) throw new Error('Voer één geldige CSS-waarde in.');
    valueHasPriority = !!trial.nodes[0].important;
    if (/<\?|<%|\{\{|\{%/.test(operation.value)) throw new Error('Dynamische CSS is beschermd.');
  }
  let result: string;
  if (decl) {
    if (operation.value === null) result = source.slice(0, decl.start) + source.slice(decl.end);
    else {
      const raw = source.slice(decl.start, decl.end);
      const match = /^([\w-]+\s*:\s*)([\s\S]*?)(\s*;?)$/.exec(raw);
      if (!match) throw new Error('Deze CSS-declaratie vereist handmatige bronbewerking.');
      // Comments are CSS whitespace around the priority marker. Preserve that
      // suffix as source bytes, including comments before/after !important.
      const priority = decl.important && !valueHasPriority ? (/((?:\s|\/\*[\s\S]*?\*\/)*!(?:\s|\/\*[\s\S]*?\*\/)*important(?:\s|\/\*[\s\S]*?\*\/)*)$/i.exec(match[2])?.[1] || ' !important') : '';
      result = source.slice(0, decl.start + match[1].length) + operation.value + priority + match[3] + source.slice(decl.end);
    }
  } else if (operation.value === null) return source;
  else {
    const close = rule.end - 1;
    const last = rule.declarations.at(-1);
    const separator = last && !source.slice(last.start, last.end).trimEnd().endsWith(';') ? ';' : '';
    // Insert at the end, retaining all existing formatting bytes and nested at-rules.
    result = source.slice(0, close) + `${separator}\n  ${operation.property}: ${operation.value};\n` + source.slice(close);
  }
  if (!buildCssSourceMap(result).editable) throw new Error('De wijziging zou ongeldige CSS maken; bron is behouden.');
  return result;
}

/** Literal static references only. Callers resolve paths and enforce project boundaries. */
export function discoverDependencies(content: string, fileKind = 'html'): string[] {
  const refs = new Set<string>();
  const add = (value: string | undefined) => { if (value && !/[<{]/.test(value)) refs.add(value.trim()); };
  const css = (text: string) => {
    // Token alternatives consume comments and strings so text resembling url(...)
    // inside them cannot cause an unrelated file to be scheduled for publishing.
    const urls = (value: string) => {
      for (const m of value.matchAll(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\(\s*(?:"([^"\\\n]*)"|'([^'\\\n]*)'|([^\s)'";\\]+))\s*\)/gi)) add(m[1] ?? m[2] ?? m[3]);
    };
    try {
      const root = postcss.parse(text, { from: undefined });
      root.walkDecls(decl => urls(decl.value));
      root.walkAtRules('import', rule => {
        urls(rule.params);
        const quoted = /^\s*(?:"([^"\\\n]+)"|'([^'\\\n]+)')/.exec(rule.params);
        if (quoted) add(quoted[1] ?? quoted[2]);
      });
    } catch { /* Malformed/dynamic CSS needs manual dependency selection. */ }
  };
  const js = (text: string) => {
    type Token = { kind: 'word' | 'string' | 'punct'; value: string };
    const tokens: Token[] = [];
    // This intentionally recognizes a small literal module grammar rather than
    // evaluating code. Escaped paths and template imports are not inferred.
    for (let i = 0; i < text.length;) {
      const c = text[i];
      if (/\s/.test(c)) { i++; continue; }
      if (text.startsWith('//', i)) { const end = text.indexOf('\n', i + 2); i = end < 0 ? text.length : end; continue; }
      if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); if (end < 0) return; i = end + 2; continue; }
      if (c === '"' || c === "'") {
        let end = i + 1, escaped = false;
        for (; end < text.length && text[end] !== c; end++) if (text[end] === '\\') { escaped = true; end++; }
        if (end >= text.length) return;
        tokens.push({ kind: 'string', value: escaped ? '' : text.slice(i + 1, end) }); i = end + 1; continue;
      }
      // Backticks and regex literals require a full JS parser to distinguish all
      // nested grammar. Stop at that boundary; retain only earlier literal refs.
      if (c === '`' || c === '/') break;
      const word = /^[a-zA-Z_$][\w$]*/.exec(text.slice(i));
      if (word) { tokens.push({ kind: 'word', value: word[0] }); i += word[0].length; }
      else { tokens.push({ kind: 'punct', value: c }); i++; }
    }
    const is = (i: number, value: string) => tokens[i]?.value === value;
    const literal = (i: number) => tokens[i]?.kind === 'string' ? tokens[i].value : undefined;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].kind !== 'word' || is(i - 1, '.')) continue;
      if (is(i, 'import') || is(i, 'require')) {
        if (is(i + 1, '(') && literal(i + 2) && is(i + 3, ')')) add(literal(i + 2));
        else if (is(i, 'import') && literal(i + 1)) add(literal(i + 1));
      }
      if ((is(i, 'import') && !is(i + 1, '(') && !is(i + 1, '.')) || is(i, 'export')) {
        for (let j = i + 1; j < tokens.length && !is(j, ';'); j++) {
          if (is(j, 'from') && literal(j + 1)) { add(literal(j + 1)); break; }
          if (is(j, 'import') || is(j, 'export')) break;
        }
      }
      if (is(i, 'new') && is(i + 1, 'URL') && is(i + 2, '(') && literal(i + 3) && is(i + 4, ',') && is(i + 5, 'import') && is(i + 6, '.') && is(i + 7, 'meta') && is(i + 8, '.') && is(i + 9, 'url') && is(i + 10, ')')) add(literal(i + 3));
    }
  };
  if (/^(?:css|scss|sass|less)$/i.test(fileKind)) css(content);
  else if (/^(?:js|javascript|mjs|cjs|ts|jsx|tsx)$/i.test(fileKind)) js(content);
  else {
    // Never infer files from code that an HTML parser could mistake for markup in
    // a PHP string/heredoc. PHP/template dependencies require explicit selection.
    if (/<\?|<%|\{\{|\{%/.test(content)) return [];
    const document = parse(content);
    const visit = (node: DefaultTreeAdapterMap['node']) => {
      if ('tagName' in node) {
        for (const attr of node.attrs) {
          if (['src', 'href', 'poster', 'data', 'background'].includes(attr.name)) add(attr.value);
          if (attr.name === 'srcset' && !/data:/i.test(attr.value)) for (const candidate of attr.value.split(',')) add(candidate.trim().split(/\s+/)[0]);
          if (attr.name === 'style') css(`a{${attr.value}}`);
        }
        if (node.tagName === 'style' || node.tagName === 'script') {
          const text = node.childNodes.filter(n => n.nodeName === '#text').map(n => (n as DefaultTreeAdapterMap['textNode']).value).join('');
          if (node.tagName === 'style') css(text); else js(text);
        }
      }
      if ('childNodes' in node) node.childNodes.forEach(visit);
    };
    visit(document);
  }
  return [...refs].filter(Boolean);
}
