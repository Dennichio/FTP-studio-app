import { describe, it, expect } from 'vitest';
import { applyCssPatch, applySourcePatch, buildCssSourceMap, buildSourceMap, buildVisualDocument, discoverDependencies, findSourceNode } from '../src/core/source';

function select(source: string, tag: string, nth = 0) {
  const map = buildSourceMap(source);
  return { nodeId: map.nodes.filter(n => n.tag === tag)[nth].id, expectedSourceHash: map.sourceHash };
}
describe('source-preserving HTML editing', () => {
  it('maps the explicit full-document hierarchy after a UTF-8 BOM without shifting offsets', () => {
    const source = '\uFEFF<!doctype html>\r\n<html>\r\n<head><title>Test</title></head>\r\n<body>\r\n<main id="outer"><p title=\'oud\'>Tekst</p></main>\r\n</body>\r\n</html>\r\n';
    const map = buildSourceMap(source);
    expect(map.issues).toEqual([]);
    expect(map.editable).toBe(true);
    const node = (tag: string) => map.nodes.find(n => n.tag === tag)!;
    expect(map.roots).toEqual([node('html').id]);
    expect(node('html').children).toEqual([node('head').id, node('body').id]);
    expect(node('body').children).toEqual([node('main').id]);
    expect(node('main').parentId).toBe(node('body').id);
    expect(node('p').parentId).toBe(node('main').id);
    for (const n of map.nodes) {
      expect(n.start).toBe(source.indexOf(`<${n.tag}`));
      expect(n.id).toBe(`n${n.start}`);
      expect(source.slice(n.closeStart, n.end)).toBe(`</${n.tag}>`);
    }
    const changed = applySourcePatch(source, { ...select(source, 'p'), type: 'setAttribute', name: 'title', value: 'nieuw' });
    expect(Buffer.from(changed)).toEqual(Buffer.from(source.replace("title='oud'", 'title="nieuw"')));
    const preview = buildVisualDocument(source);
    expect(preview.replace(/ data-ftp-node="n\d+"/g, '')).toBe(source);
    expect(preview).toContain(`<html data-ftp-node="${node('html').id}">`);
    expect(() => applySourcePatch(source.slice(1), { ...select(source, 'p'), type: 'remove' })).toThrow(/bron is gewijzigd/);
  });
  it('preserves BOM, CRLF and interior U+FEFF text during a source move', () => {
    const block = '<p title=\'origineel\'>A\uFEFFB</p>';
    const source = '\uFEFF<!doctype html>\r\n<html><head><title>Test</title></head><body>\r\n<main>' + block + '</main>\r\n<section></section>\r\n</body></html>\r\n';
    const map = buildSourceMap(source);
    const moved = applySourcePatch(source, { ...select(source, 'p'), type: 'move', targetId: map.nodes.find(n => n.tag === 'section')!.id, position: 'inside' });
    expect(Buffer.from(moved)).toEqual(Buffer.from(source.replace(block, '').replace('<section></section>', `<section>${block}</section>`)));
    expect(buildSourceMap(moved).editable).toBe(true);
    expect(buildSourceMap(source.replace('<body>', '<body>\uFEFF')).nodes.find(n => n.tag === 'main')?.start).toBe(source.indexOf('<main>') + 1);
  });
  it('inserts static building blocks while preserving original source bytes', () => {
    const source = '<!doctype html>\r\n<html><head><title>Test</title></head><body class="existing"><p>Origineel</p></body></html>';
    const block = '<section class="columns"><div>Links</div><div>Rechts</div></section>';
    expect(applySourcePatch(source, { ...select(source, 'body'), type: 'insert', html: block, position: 'inside' })).toBe(source.replace('</body>', block + '</body>'));
    expect(() => applySourcePatch(source, { ...select(source, 'body'), type: 'insert', html: '<script>alert(1)</script>', position: 'inside' })).toThrow();
    expect(() => applySourcePatch(source, { ...select(source, 'body'), type: 'insert', html: '<?php echo 1; ?>', position: 'inside' })).toThrow();
  });
  it('retains every byte outside targeted text and escapes markup', () => {
    const source = "<!DOCTYPE html>\r\n<section  class='x' data-old = 'a'><!--keep--><p title='t'>Oud &amp; goed</p>\r\n<img src = 'a.png' /></section>";
    const changed = applySourcePatch(source, { ...select(source, 'p'), type: 'setText', text: '<nieuw> & ok' });
    expect(changed).toBe(source.replace('Oud &amp; goed', '&lt;nieuw&gt; &amp; ok'));
    expect(findSourceNode(buildSourceMap(source), source.indexOf('Oud'))?.tag).toBe('p');
  });
  it('changes only one attribute span, preserving other spacing and quotes', () => {
    const source = "<p  class = 'a' title='b'>ok</p>";
    expect(applySourcePatch(source, { ...select(source, 'p'), type: 'setAttribute', name: 'title', value: '"<&' })).toBe("<p  class = 'a' title=\"&quot;&lt;&amp;\">ok</p>");
  });
  it('rejects stale selections even if the same offset still exists', () => {
    const source = '<p>abc</p>';
    expect(() => applySourcePatch('<p>def</p>', { ...select(source, 'p'), type: 'setText', text: 'stale' })).toThrow(/bron is gewijzigd/);
  });
  it.each([
    '<?php echo "?> <p>unsafe</p>"; ?><p>static</p>',
    "<?php $text = <<<'TXT'\n?>\n<p>unsafe</p>\nTXT; ?><p>static</p>",
    '<p><?= $value ?></p>', '<p>{{ value }}</p>', '<p>{% value %}</p>',
  ])('blocks dynamic documents without assuming a PHP lexer: %s', source => {
    const map = buildSourceMap(source);
    expect(map.editable).toBe(false);
    if (map.nodes.length) expect(() => applySourcePatch(source, { type: 'remove', nodeId: map.nodes[0].id, expectedSourceHash: map.sourceHash })).toThrow();
    expect(buildVisualDocument(source)).not.toContain('unsafe');
  });
  it('protects script/style blocks and containing subtrees from destructive edits', () => {
    const source = '<div><script>console.log("a")</script><p>x</p></div>';
    expect(() => applySourcePatch(source, { ...select(source, 'script'), type: 'setText', text: 'bad' })).toThrow();
    expect(() => applySourcePatch(source, { ...select(source, 'div'), type: 'remove' })).toThrow(/beschermde/);
    expect(applySourcePatch(source, { ...select(source, 'p'), type: 'setText', text: 'y' })).toBe(source.replace('<p>x', '<p>y'));
  });
  it('refuses malformed, foster-parented and implicit closing markup', () => {
    for (const source of ['<div><span>oops</div></span>', '<table><p>x</p></table>', '<main><table><p>x</p></table></main>']) {
      const map = buildSourceMap(source);
      expect(map.editable).toBe(false);
      expect(map.nodes.every(node => !node.editable)).toBe(true);
      expect(() => applySourcePatch(source, { type: 'remove', nodeId: map.nodes[0].id, expectedSourceHash: map.sourceHash })).toThrow();
    }
    const source = '<ul><li>one<li>two</ul>';
    expect(() => applySourcePatch(source, { ...select(source, 'li'), type: 'remove' })).toThrow();
  });
  it('moves nested blocks in both directions without rewriting whitespace or text', () => {
    const source = '<main>\n<section id="a"><p>A</p></section>\n<section id="b"><p>B</p></section>\n</main>';
    const map = buildSourceMap(source), sections = map.nodes.filter(n => n.tag === 'section');
    const forward = applySourcePatch(source, { type: 'move', nodeId: sections[0].id, targetId: sections[1].id, position: 'inside', expectedSourceHash: map.sourceHash });
    expect(forward).toBe('<main>\n\n<section id="b"><p>B</p><section id="a"><p>A</p></section></section>\n</main>');
    const backward = applySourcePatch(source, { type: 'move', nodeId: sections[1].id, targetId: sections[0].id, position: 'before', expectedSourceHash: map.sourceHash });
    expect(backward).toBe('<main>\n<section id="b"><p>B</p></section><section id="a"><p>A</p></section>\n\n</main>');
    expect(() => applySourcePatch(source, { type: 'move', ...select(source, 'section'), targetId: map.nodes.find(n => n.tag === 'p')!.id, position: 'inside' })).toThrow();
  });
  it('duplicates/removes exact spans and refuses nested text replacement', () => {
    const source = '<div> <p x = "a">A</p> </div>';
    expect(applySourcePatch(source, { ...select(source, 'p'), type: 'duplicate' })).toBe('<div> <p x = "a">A</p><p x = "a">A</p> </div>');
    expect(applySourcePatch(source, { ...select(source, 'p'), type: 'remove' })).toBe('<div>  </div>');
    expect(() => applySourcePatch(source, { ...select(source, 'div'), type: 'setText', text: 'erase' })).toThrow();
  });
  it('instrumentation uses source offsets, replaces hostile existing IDs, preserves source', () => {
    const source = "<p data-ftp-node='fake'>x</p><img src='a'/>";
    const preview = buildVisualDocument(source);
    expect(preview).toBe('<p data-ftp-node="n0">x</p><img src=\'a\' data-ftp-node="n29"/>');
    expect(source).toBe("<p data-ftp-node='fake'>x</p><img src='a'/>");
  });
  it('blocks executable attribute changes', () => {
    const source = '<a href="x">x</a>';
    for (const [name, value] of [['onclick', 'alert(1)'], ['href', 'java\nscript:alert(1)'], ['srcdoc', '<script>x</script>']]) {
      expect(() => applySourcePatch(source, { ...select(source, 'a'), type: 'setAttribute', name, value })).toThrow();
    }
  });
});

describe('CSS rule mapping and byte patches', () => {
  it('preserves existing important priority while changing a property value', () => {
    for (const css of ['.a {color:red !important;}', '.a {color:red ! /*keep*/ important;}', '.a {color:red /*before*/ !important /*after*/;}']) {
      const map = buildCssSourceMap(css);
      const changed = applyCssPatch(css, { expectedSourceHash: map.sourceHash, ruleId: map.rules[0].id, property: 'color', value: 'blue' });
      expect(changed).toBe(css.replace('red', 'blue'));
      expect(buildCssSourceMap(changed).rules[0].declarations[0].important).toBe(true);
    }
  });
  const source = '/* keep */\r\n.card { color : red; padding: 2px }\r\n@media (max-width: 600px) {\r\n  .card {color: blue !important; color: green;}\r\n}\r\n';
  it('distinguishes duplicate selectors, media contexts and declaration ranges', () => {
    const map = buildCssSourceMap(source);
    expect(map.editable).toBe(true);
    expect(map.rules).toHaveLength(2);
    expect(map.rules[1].context).toEqual(['@media (max-width: 600px)']);
    expect(source.slice(map.rules[0].start, map.rules[0].end)).toBe('.card { color : red; padding: 2px }');
    const red = map.rules[0].declarations[0];
    expect(source.slice(red.start, red.end)).toBe('color : red;');
    expect(applyCssPatch(source, { expectedSourceHash: map.sourceHash, ruleId: map.rules[0].id, property: 'color', value: 'orange' })).toBe(source.replace('color : red;', 'color : orange;'));
  });
  it('requires an exact declaration when a property is repeated', () => {
    const map = buildCssSourceMap(source), rule = map.rules[1];
    expect(() => applyCssPatch(source, { expectedSourceHash: map.sourceHash, ruleId: rule.id, property: 'color', value: 'black' })).toThrow(/meermaals/);
    expect(applyCssPatch(source, { expectedSourceHash: map.sourceHash, ruleId: rule.id, declarationId: rule.declarations[1].id, property: 'color', value: 'black' })).toBe(source.replace('color: green;', 'color: black;'));
  });
  it('preserves closing braces, Unicode and CRLF when removing a final declaration', () => {
    const css = '/* 🎨 */\r\n@supports (display: grid) { @media screen { .x {color:red} } }\r\n';
    const map = buildCssSourceMap(css), rule = map.rules[0];
    expect(rule.context).toEqual(['@supports (display: grid)', '@media screen']);
    expect(css.slice(rule.start, rule.end)).toBe('.x {color:red}');
    expect(css.slice(rule.declarations[0].start, rule.declarations[0].end)).toBe('color:red');
    expect(applyCssPatch(css, { expectedSourceHash: map.sourceHash, ruleId: rule.id, property: 'color', value: null })).toBe(css.replace('color:red', ''));
  });
  it('inserts a property after an unterminated declaration without joining values', () => {
    const css = '.x { color: red }';
    const map = buildCssSourceMap(css);
    const result = applyCssPatch(css, { expectedSourceHash: map.sourceHash, ruleId: map.rules[0].id, property: 'padding', value: '4px' });
    expect(buildCssSourceMap(result).rules[0].declarations.map(d => [d.property, d.value])).toEqual([['color', 'red'], ['padding', '4px']]);
  });
  it('rejects stale rules, malformed CSS, and escaping into another rule', () => {
    const map = buildCssSourceMap(source), op = { expectedSourceHash: map.sourceHash, ruleId: map.rules[0].id, property: 'color', value: 'red' };
    expect(() => applyCssPatch(source + '\n', op)).toThrow(/bron is gewijzigd/);
    expect(buildCssSourceMap('.a { color: red').editable).toBe(false);
    expect(() => applyCssPatch(source, { ...op, value: 'red} b{color:blue' })).toThrow();
    expect(() => applyCssPatch(source, { ...op, value: 'red; background:blue' })).toThrow();
  });
});

describe('literal dependency discovery', () => {
  it('finds linked HTML resources, srcsets, inline CSS and module imports', () => {
    const source = '<link href="css/main.css"><img src="a.png" srcset="b.png 1x, c.png 2x"><style>@import "base.css";.x{background:url(\'d.png\')}</style><script type="module">import x from "./app.js";</script>';
    expect(discoverDependencies(source)).toEqual(['css/main.css', 'a.png', 'b.png', 'c.png', 'd.png', 'base.css', './app.js']);
  });
  it('finds CSS imports and JS literal imports while leaving URL resolution to caller', () => {
    expect(discoverDependencies('@import "a.css"; .a {background:url(../img/a.png?v=2)}', 'css')).toEqual(['../img/a.png?v=2', 'a.css']);
    expect(discoverDependencies('export {x} from "./x.js"; import("./lazy.js"); new URL("./a.svg", import.meta.url);', 'js')).toEqual(['./x.js', './lazy.js', './a.svg']);
  });
  it('does not infer dependencies from comments, quoted fake imports or PHP heredocs', () => {
    expect(discoverDependencies('/* import "./secret.js"; */ const text = "import \\\'./private.js\\\'"; import "./real.js";', 'js')).toEqual(['./real.js']);
    expect(discoverDependencies('/* .x{background:url(secret.png)} */ .x{content:"url(private.png)";background:url(real.png)}', 'css')).toEqual(['real.png']);
    expect(discoverDependencies("<?php $x = <<<'TXT'\n?>\n<img src='private.png'>\nTXT; ?>", 'php')).toEqual([]);
  });
});
