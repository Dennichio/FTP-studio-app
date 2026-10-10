import { describe, expect, it } from 'vitest';
import { collectDependencyReferences, discoverPhpDependencies } from '../src/core/phpDependencies';
import { discoverDependencies } from '../src/core/source';

describe('static PHP dependency inspection', () => {
  it('discovers literal include variants and static concatenations without changing source', () => {
    const source = `\ufeff<html>\r\n<?php\r\ninclude 'one.php'; require_once("two.php");\r\nINCLUDE_ONCE ('three' . '.php'); require 'one.php'; ?>\r\n</html>`;
    const before = Buffer.from(source);
    expect(discoverPhpDependencies(source).references).toEqual(['one.php', 'two.php', 'three.php']);
    expect(discoverPhpDependencies(source).warnings).toEqual([]);
    expect(Buffer.from(source)).toEqual(before);
  });

  it('resolves __DIR__ as a file-relative base, including parentheses', () => {
    const result = discoverPhpDependencies(`<?php require __DIR__ . '/inc/a.php'; require_once(__DIR__ . '/../b.php'); include (__DIR__) . '/c.php'; include __DIR__ . 'wrong.php';`);
    expect(result.references).toEqual(['./inc/a.php', './../b.php', './c.php']);
    expect(result.warnings).toHaveLength(1);
  });

  it('ignores include-looking HTML, comments, strings, variables and member names', () => {
    const result = discoverPhpDependencies(`<p>include 'html.php';</p><?php
      // require 'comment.php';
      # include 'hash.php';
      /* require_once 'block.php'; ?> */
      $text = "require 'string.php'; ?>";
      $include('variable.php'); $a->include('method.php'); A::require('static.php');
      include /* comment */ 'real.php';
    ?>`);
    expect(result.references).toEqual(['real.php']);
    expect(result.warnings).toEqual([]);
  });

  it('handles escaped quotes without treating string contents as code', () => {
    const source = String.raw`<?php $text = 'can\'t; include "fake.php";'; include 'it\'s.php'; include "quoted\"name.php"; include "\$literal.php";`;
    expect(discoverPhpDependencies(source).references).toEqual(["it's.php", 'quoted"name.php', '$literal.php']);
  });

  it('never guesses dynamic expressions or evaluates calls', () => {
    const result = discoverPhpDependencies(`<?php
      include $name;
      require 'prefix/' . $name;
      include "views/$name.php";
      require dirname(__FILE__) . '/file.php';
      require ('one.php') . suffix();
      include getenv('SECRET');
      require 'safe.php';
    `);
    expect(result.references).toEqual(['safe.php']);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).not.toContain('SECRET');
  });

  it('keeps interpolated quoted expressions opaque', () => {
    const result = discoverPhpDependencies(`<?php $s = "{$a['require fake.php']}"; $t = "\${call("include 'fake.php';")}"; include 'safe.php';`);
    expect(result.references).toEqual(['safe.php']);
    expect(result.warnings).toEqual([]);
  });

  it('ignores heredoc/nowdoc bodies, including fake close tags and markup', () => {
    const source = `<?php $a = <<<'BODY'\ninclude 'fake.php'; ?> <img src="secret.txt">\nBODY;\n$b = <<<"OTHER"\nrequire "another.php"; ?>\n  OTHER;\nrequire 'real.php'; ?><img src="real.png">`;
    const result = discoverPhpDependencies(source);
    expect(result.references).toEqual(['real.php']);
    expect(discoverDependencies(result.staticMarkup)).toEqual(['real.png']);
  });

  it('ends line comments at a PHP closing tag', () => {
    const result = discoverPhpDependencies(`<?php // ignore include 'fake.php'; ?><img src="real.png"><?php include 'real.php'; ?>`);
    expect(result.references).toEqual(['real.php']);
    expect(discoverDependencies(result.staticMarkup)).toEqual(['real.png']);
  });

  it.each([
    `<?php include 'safe.php'; /* unterminated ?> <img src="secret.txt">`,
    `<?php include 'unterminated; ?> <img src="secret.txt">`,
    `<?php $s = <<<'BODY'\ninclude 'fake.php'; ?> <img src="secret.txt">`,
    `<? include 'unknown.php'; ?> <img src="secret.txt">`,
  ])('fails closed on malformed or unknown PHP boundaries: %s', source => {
    const result = discoverPhpDependencies(source);
    expect(result.references).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(discoverDependencies(result.staticMarkup)).toEqual([]);
  });

  it('omits absolute, external, Windows and control-character paths', () => {
    const result = discoverPhpDependencies(String.raw`<?php include '/etc/passwd'; require 'https://example.test/a.php'; include 'C:\private.php'; include 'a\b.php'; include "a\x00.php"; include '';`);
    expect(result.references).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('preserves URL-special filenames and sensitive paths for the caller security filters', () => {
    const result = discoverPhpDependencies(`<?php include 'foo%20bar.php'; require 'name#literal.php'; require 'name?literal.php'; include '../.env'; include 'config/secrets.php';`);
    expect(result.references).toEqual(['foo%20bar.php', 'name#literal.php', 'name?literal.php', '../.env', 'config/secrets.php']);
  });

  it('masks PHP without turning dynamic attribute suffixes into static dependencies', () => {
    const result = discoverPhpDependencies(`<link href="style.css"><img src="<?php echo $prefix; ?>secret.png"><?php echo '<img src="fake.png">'; ?><style>a{background:url(real.png)}</style>`);
    expect(discoverDependencies(result.staticMarkup)).toEqual(['style.css', 'real.png']);
  });

  it('does not scan compiler-halt payloads or backtick commands', () => {
    const result = discoverPhpDependencies("<?php $x = `echo include 'fake.php';`; include 'real.php'; __halt_compiler(); include 'payload.php'; ?><img src=secret.txt>");
    expect(result.references).toEqual(['real.php']);
    expect(discoverDependencies(result.staticMarkup)).toEqual([]);
  });
});


describe('dependency reference kinds', () => {
  it('separates filesystem literals from surrounding markup URLs', () => {
    expect(collectDependencyReferences(`<?php require 'literal%20name.php'; ?><img src="image%20name.png?v=1">`, 'php')).toEqual({
      fileReferences: ['literal%20name.php'], urlReferences: ['image%20name.png?v=1'], warnings: [],
    });
  });
  it('recognizes PHP in HTML and leaves ordinary CSS/JS discovery intact', () => {
    expect(collectDependencyReferences(`<?php require 'header.php'; ?><link href="a.css">`, 'html').fileReferences).toEqual(['header.php']);
    expect(collectDependencyReferences('a{background:url(a.png)}', 'css').urlReferences).toEqual(['a.png']);
    expect(collectDependencyReferences(`import './a.js';`, 'js').urlReferences).toEqual(['./a.js']);
  });
});
