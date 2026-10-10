import { describe, expect, it, vi } from 'vitest';
import { buildSourceMap } from '../src/core/source';
import { collectCssSources, inspectionRevision, localPathKey, localDocumentForPath, linkedStylesheets, matchingCssRules, patchInspectedCss, stylesheetPath, type InspectorDocument } from '../src/renderer/cssInspector';

const document = (content: string, id = 'html', path = '/site/index.html'): InspectorDocument => ({ id, path, content });
const selected = (doc: InspectorDocument) => buildSourceMap(doc.content).nodes.find(n => n.tag === 'p')!.id;

describe('selected element CSS sources', () => {
  it('maps inline, internal and dirty external sources to exact owner locations', () => {
    const html = document('<!doctype html>\r\n<html><head>\r\n<style media="screen">/* keep */\r\n.card { color: red; }</style><link rel="stylesheet" href="css/main.css?v=1" media="(min-width: 600px)"></head><body><p class="card" style="padding: 2px">Text</p></body></html>');
    const external = { ...document('/* unsaved */\r\n.card { color: blue; }', 'css', '/site/css/main.css'), dirty: true };
    const links = linkedStylesheets(html, '/site');
    const { sources, issues } = collectCssSources(html, selected(html), [external], links);
    expect(issues).toEqual([]);
    expect(sources.map(s => s.kind)).toEqual(['inline', 'internal', 'external']);
    expect(sources[0].rule.declarations[0].value).toBe('2px');
    expect(sources[1].context).toEqual(['media="screen"']);
    expect(sources[1].line).toBe(4);
    expect(html.content.slice(sources[1].offset)).toMatch(/^\.card/);
    expect(sources[2].documentId).toBe('css');
    expect(sources[2].rule.declarations[0].value).toBe('blue');
    expect(sources[2].line).toBe(2);
    expect(sources[2].context).toEqual(['media="(min-width: 600px)"']);
  });
  it('keeps duplicate selectors, nested media contexts and distinct linked occurrences', () => {
    const html = document('<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="a.css" media="print"><p>x</p>');
    const external = document('.x{color:red}@media screen{.x{color:blue}}', 'css', '/site/a.css');
    const { sources } = collectCssSources(html, selected(html), [external], linkedStylesheets(html, '/site'));
    expect(sources).toHaveLength(4);
    expect(new Set(sources.map(s => s.id)).size).toBe(4);
    expect(sources[3].context).toEqual(['media="print"', '@media screen']);
  });
  it('does not interpret templates, remote documents or base URLs as local stylesheet paths', () => {
    const dynamic = document('<?php echo "secret"; ?><p style="color:red">x</p>');
    expect(collectCssSources(dynamic, selected(dynamic), [], []).sources).toEqual([]);
    const base = document('<base href="https://example.test/"><link rel="stylesheet" href="a.css"><p>x</p>');
    expect(linkedStylesheets(base, '/site')[0].path).toBeNull();
    expect(linkedStylesheets({ ...document('<link rel="stylesheet" href="a.css">'), remote: {} }, '/site')[0].path).toBeNull();
    const template = document('<template><style>.x{color:red}</style></template><p>x</p>');
    expect(collectCssSources(template, selected(template), [], []).sources).toEqual([]);
  });
  it.each(['color:red} .other{color:blue', '@media screen { color: red }'])('refuses unsupported inline declaration blocks: %s', style => {
    const html = document(`<p style="${style}">x</p>`);
    const result = collectCssSources(html, selected(html), [], []);
    expect(result.sources).toEqual([]);
    expect(result.issues).toContain('De inline style bevat geen veilig, enkel declaratieblok; gebruik de broncode.');
  });
  it('reports unloaded, malformed and imported CSS instead of claiming complete coverage', () => {
    const html = document('<style>.a{color:</style><link rel="stylesheet" href="missing.css"><style>@import "nested.css";.x{color:red}</style><p>x</p>');
    const { issues } = collectCssSources(html, selected(html), [], linkedStylesheets(html, '/site'));
    expect(issues.some(i => i.includes('nog niet geladen'))).toBe(true);
    expect(issues.some(i => i.includes('@import'))).toBe(true);
    expect(issues.some(i => i.includes('CssSyntaxError'))).toBe(true);
  });
});

describe('literal stylesheet paths', () => {
  it.each([
    ['css/main.css?v=1#x', '/site/pages/css/main.css'],
    ['/css/main.css', '/site/css/main.css'],
    ['../shared/a%20b.css', '/site/shared/a b.css'],
  ])('resolves %s within the project', (href, path) => expect(stylesheetPath('/site/pages/index.html', '/site', href)).toBe(path));
  it.each(['https://remote.test/a.css', '//remote.test/a.css', '../../secret.css', '%2e%2e/%2e%2e/secret.css', '%2f%2fhost/a.css', 'file:///tmp/a.css', '#x', 'bad%zz.css', 'a%00.css', 'a%5cb.css'])('rejects unsafe/nonlocal link %s', href => expect(stylesheetPath('/site/pages/index.html', '/site', href)).toBeNull());
  it('normalizes Windows project paths while refusing sibling roots', () => {
    expect(stylesheetPath('C:\\site\\pages\\index.html', 'C:\\site', '../css/main.css')).toBe('C:\\site\\css\\main.css');
    expect(stylesheetPath('C:\\site\\pages\\index.html', 'C:\\site', '../../site-other/a.css')).toBeNull();
  });
});

describe('conservative selector matching', () => {
  it('retains only matching static selectors, with exact document match counts', () => {
    const html = document('<style>.card{color:red}.other{color:blue}@media print{main > .card{display:none}}</style><p>x</p>');
    const { sources } = collectCssSources(html, selected(html), [], []);
    const matches = matchingCssRules(sources, selector => ({ selected: selector !== '.other', count: selector === '.card' ? 3 : 1 }));
    expect(matches.map(m => [m.source.rule.selector, m.count])).toEqual([['.card', 3], ['main > .card', 1]]);
    expect(matches[1].source.context).toEqual(['@media print']);
  });
  it('does not report runtime pseudo states, nesting, scopes or invalid selectors as exact matches', () => {
    const html = document('<style>.a:hover{color:red}.a{.b{color:blue}}@scope (.a){.b{color:green}}[]{color:black}</style><p>x</p>');
    const { sources } = collectCssSources(html, selected(html), [], []);
    const matcher = vi.fn((selector: string) => { if (selector === '[]') throw new Error('Invalid selector'); return { selected: false, count: 0 }; });
    const result = matchingCssRules(sources, matcher);
    expect(result).toHaveLength(4);
    expect(result.every(m => m.status === 'unknown' && m.count === null)).toBe(true);
    expect(matcher.mock.calls.map(c => c[0])).toEqual(['.a', '[]']);
  });
});

describe('reviewed CSS source edits', () => {
  it('patches internal CSS bytes without rewriting HTML, quotes, CRLF or priority comments', () => {
    const html = document('\uFEFF<!doctype html>\r\n<html><head><style>/*keep*/ .x{color:red /*before*/ !important /*after*/;}</style></head><body><p>x</p></body></html>\r\n');
    const { sources } = collectCssSources(html, selected(html), [], []);
    const result = patchInspectedCss(html.content, sources[0], { property: 'color', value: 'blue' });
    expect(result).toBe(html.content.replace('color:red', 'color:blue'));
  });
  it('escapes an inline style attribute and preserves every byte outside that attribute', () => {
    const html = document("<p  title='keep' style='color:red; content:&quot;x&quot;'>Text</p>");
    const { sources } = collectCssSources(html, selected(html), [], []);
    const result = patchInspectedCss(html.content, sources[0], { property: 'color', value: 'blue' });
    expect(result).toBe('<p  title=\'keep\' style="color:blue; content:&quot;x&quot;">Text</p>');
  });
  it('edits only the selected repeated declaration in an unsaved external document', () => {
    const html = document('<link rel="stylesheet" href="a.css"><p>x</p>');
    const css = { ...document('/* unsaved */ .x{color:red; color:blue;}\r\n', 'css', '/site/a.css'), dirty: true };
    const { sources } = collectCssSources(html, selected(html), [css], linkedStylesheets(html, '/site'));
    expect(() => patchInspectedCss(css.content, sources[0], { property: 'color', value: 'green' })).toThrow(/meermaals/);
    const result = patchInspectedCss(css.content, sources[0], { property: 'color', value: 'green', declarationId: sources[0].rule.declarations[1].id });
    expect(result).toBe(css.content.replace('color:blue', 'color:green'));
    expect(css.content).toContain('/* unsaved */');
  });
  it('rejects stale reviewed edits and style-closing markup injection', () => {
    const html = document('<style>.x{content:"old"}</style><p>x</p>');
    const { sources } = collectCssSources(html, selected(html), [], []);
    expect(() => patchInspectedCss(html.content + '\n', sources[0], { property: 'content', value: '"new"' })).toThrow(/bron is gewijzigd/);
    expect(() => patchInspectedCss(html.content, sources[0], { property: 'content', value: '"</style><script>bad</script>"' })).toThrow(/style-blok/);
    expect(() => patchInspectedCss(html.content, sources[0], { property: 'content', value: '"<?php unsafe ?>"' })).toThrow();
  });
});

describe('isolated preview asset consistency', () => {
  it('uses the same canonical stylesheet path and keeps SVG fragments separate from filesystem reads', async () => {
    const { resolvePreviewAsset } = await import('../src/renderer/preview');
    expect(resolvePreviewAsset('/site/pages/index.html', '/site', '../css/main.css?v=2#part')).toEqual({ path: '/site/css/main.css', fragment: '#part' });
    expect(resolvePreviewAsset('C:\\site\\index.html', 'C:\\site', 'icons/symbols.svg?x=1#tick')).toEqual({ path: 'C:\\site\\icons\\symbols.svg', fragment: '#tick' });
    for (const href of ['https://example.test/a.css', '//example.test/a.css', '%2e%2e/secret.css', 'javascript:bad', 'file:///secret', '#local']) expect(resolvePreviewAsset('/site/index.html', '/site', href)).toBeNull();
  });
  it('keeps stylesheet media conditions and does not activate disabled or alternate sheets', async () => {
    const { stylesheetPreviewPolicy } = await import('../src/renderer/preview');
    expect(stylesheetPreviewPolicy({ rel: 'StyleSheet', media: 'print and (min-width: 600px)' })).toEqual({ load: true, media: 'print and (min-width: 600px)' });
    const inactive: Record<string, string>[] = [{ rel: 'stylesheet', disabled: '' }, { rel: 'alternate stylesheet', title: 'Other' }, { rel: 'preload' }, { rel: 'stylesheet', type: 'text/plain' }];
    for (const attrs of inactive) expect(stylesheetPreviewPolicy(attrs).load).toBe(false);
  });
});


describe('CSS ownership and preview revision guards', () => {
  it('refuses root-relative and relative stylesheet resolution for an HTML document outside the active project', async () => {
    const { resolvePreviewAsset } = await import('../src/renderer/preview');
    const html = document('<link rel="stylesheet" href="/css/main.css"><p>x</p>', 'old', '/old/index.html');
    expect(stylesheetPath(html.path, '/new', '/css/main.css')).toBeNull();
    expect(stylesheetPath(html.path, '/new', '../new/css/main.css')).toBeNull();
    expect(linkedStylesheets(html, '/new')[0].path).toBeNull();
    expect(resolvePreviewAsset(html.path, '/new', '/img/a.png')).toBeNull();
  });
  it('reuses a dirty Windows buffer despite case and slash variants', () => {
    const html = document('<link rel="stylesheet" href="Styles/Main.css"><p>x</p>', 'html', 'C:\\site\\index.html');
    const clean = document('.x{color:red}', 'disk', 'C:\\site\\Styles\\Main.css');
    const dirty = { ...document('/* unsaved */ .x{color:blue}', 'dirty', 'c:/site/styles/main.css'), dirty: true };
    expect(localPathKey(clean.path)).toBe(localPathKey(dirty.path));
    expect(localDocumentForPath([clean, dirty], clean.path)?.id).toBe('dirty');
    const result = collectCssSources(html, selected(html), [clean, dirty], linkedStylesheets(html, 'C:\\site'));
    expect(result.sources[0].documentId).toBe('dirty');
    expect(result.sources[0].rule.declarations[0].value).toBe('blue');
    expect(localPathKey('/site/A.css')).not.toBe(localPathKey('/site/a.css'));
  });
  it('blocks ambiguous changed Windows buffers instead of choosing a competing source', () => {
    const first = { ...document('.x{color:red}', 'first', 'C:\\site\\a.css'), dirty: true };
    const second = { ...document('.x{color:blue}', 'second', 'c:/SITE/A.css'), dirty: true };
    expect(localDocumentForPath([first, second], first.path)).toBeUndefined();
    const html = document('<link rel="stylesheet" href="a.css"><p>x</p>', 'html', 'C:\\site\\index.html');
    const result = collectCssSources(html, selected(html), [first, second], linkedStylesheets(html, 'C:\\site'));
    expect(result.sources).toEqual([]);
    expect(result.issues[0]).toContain('meerdere gewijzigde buffers');
  });
  it('changes the preview identity for equal-length source replacements, tabs, Save As and project changes', () => {
    const html = document('<p class="old">x</p>');
    const revision = inspectionRevision(html, 'project', '/site');
    const changes: Array<[InspectorDocument, string, string]> = [
      [{ ...html, content: '<p class="new">x</p>' }, 'project', '/site'],
      [{ ...html, id: 'other' }, 'project', '/site'],
      [{ ...html, path: '/site/sub/index.html' }, 'project', '/site'],
      [html, 'other-project', '/site'], [html, 'project', '/other'],
      [{ ...html, remote: {} }, 'project', '/site'],
    ];
    for (const args of changes) expect(inspectionRevision(...args)).not.toBe(revision);
    expect(inspectionRevision({ ...html }, 'project', '/site')).toBe(revision);
  });
});
