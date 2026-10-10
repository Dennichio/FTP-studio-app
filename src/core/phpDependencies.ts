import { discoverDependencies } from './source';

/** Static inspection only: PHP is never evaluated and the input is never modified. */
export interface PhpDependencies {
  /** Literal file paths relative to the containing file. These are not URLs. */
  references: string[];
  /** Generic diagnostics deliberately omit source text and possible secrets. */
  warnings: string[];
  /** PHP is replaced by markers so callers can inspect surrounding static markup. */
  staticMarkup: string;
}
interface Token { kind: 'word' | 'string' | 'symbol'; value: string; dynamic?: boolean; }
const identifier = /^[a-zA-Z_\x80-\uffff][a-zA-Z_\d\x80-\uffff]*/;
const includeWords = /^(?:include|include_once|require|require_once)$/i;

/** A deliberately small lexical reader, not a PHP parser or runtime. */
function quoted(source: string, start: number, depth = 0): { end: number; value: string; dynamic: boolean } | undefined {
  if (depth > 64) return;
  const quote = source[start];
  let value = '', dynamic = quote === '`';
  for (let i = start + 1; i < source.length;) {
    const c = source[i];
    if (c === quote) return { end: i + 1, value, dynamic };
    if (c === '\\') {
      if (i + 1 >= source.length) return;
      const next = source[i + 1];
      if (quote === "'") value += next === "'" || next === '\\' ? next : `\\${next}`;
      else if ('\\"$'.includes(next)) value += next;
      // Complex escape encodings are intentionally not interpreted as filenames.
      else { value += `\\${next}`; dynamic = true; }
      i += 2; continue;
    }
    if (quote !== "'" && (c === '{' && source[i + 1] === '$' || c === '$' && source[i + 1] === '{')) {
      dynamic = true;
      let nesting = 1;
      i += 2;
      for (; i < source.length && nesting;) {
        if ('\'"`'.includes(source[i])) {
          const nested = quoted(source, i, depth + 1);
          if (!nested) return;
          i = nested.end;
        } else if (source.startsWith('/*', i)) {
          const end = source.indexOf('*/', i + 2); if (end < 0) return; i = end + 2;
        } else if (source.startsWith('//', i) || source[i] === '#') {
          const end = source.indexOf('\n', i + 1); if (end < 0) return; i = end + 1;
        } else if (source.startsWith('<<<', i)) return;
        else { if (source[i] === '{') nesting++; if (source[i] === '}') nesting--; i++; }
      }
      if (nesting) return;
      continue;
    }
    if (quote !== "'" && c === '$') dynamic = true;
    value += c; i++;
  }
}

function lexBlock(source: string, start: number): { end: number; tokens: Token[]; malformed: boolean } {
  const tokens: Token[] = [];
  const bad = () => ({ end: source.length, tokens: [], malformed: true });
  for (let i = start; i < source.length;) {
    const c = source[i];
    if (source.startsWith('?>', i)) return { end: i + 2, tokens, malformed: false };
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2); if (end < 0) return bad(); i = end + 2; continue;
    }
    if (source.startsWith('//', i) || c === '#' && source[i + 1] !== '[') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r' && !source.startsWith('?>', i)) i++;
      continue;
    }
    if ('\'"`'.includes(c)) {
      const string = quoted(source, i); if (!string) return bad();
      tokens.push({ kind: 'string', value: string.value, dynamic: string.dynamic }); i = string.end; continue;
    }
    if (source.startsWith('<<<', i)) {
      const opening = /^<<<[ \t]*(?:'([a-zA-Z_]\w*)'|"([a-zA-Z_]\w*)"|([a-zA-Z_]\w*))[ \t]*\r?\n/.exec(source.slice(i));
      if (!opening) return bad();
      const label = opening[1] ?? opening[2] ?? opening[3];
      const body = i + opening[0].length;
      const closing = new RegExp(`^[ \\t]*${label}(?![a-zA-Z_\\d\\x80-\\uffff])`, 'gm');
      closing.lastIndex = body;
      const match = closing.exec(source); if (!match) return bad();
      tokens.push({ kind: 'string', value: '', dynamic: true }); i = match.index + match[0].length; continue;
    }
    const word = identifier.exec(source.slice(i));
    if (word) {
      // A compiler halt makes the remainder opaque data, potentially containing
      // arbitrary quotes, PHP tags or include-looking text.
      if (word[0].toLowerCase() === '__halt_compiler') return { end: source.length, tokens, malformed: false };
      tokens.push({ kind: 'word', value: word[0] }); i += word[0].length; continue;
    }
    const operator = ['?->', '->', '::'].find(value => source.startsWith(value, i));
    tokens.push({ kind: 'symbol', value: operator ?? c }); i += operator?.length ?? 1;
  }
  return { end: source.length, tokens, malformed: false };
}

function literalExpression(tokens: Token[], start: number): { end: number; path: string } | undefined {
  let at = start, directory = false, firstAtom = true;
  function expression(depth: number): string | undefined {
    if (depth > 64) return;
    const atom = (): string | undefined => {
      const token = tokens[at]; if (!token) return;
      if (token.value === '(' && token.kind === 'symbol') {
        at++; const nested = expression(depth + 1);
        if (nested === undefined || tokens[at]?.value !== ')') return;
        at++; return nested;
      }
      if (token.kind === 'string' && !token.dynamic) { firstAtom = false; at++; return token.value; }
      if (token.kind === 'word' && token.value.toLowerCase() === '__dir__' && !directory && firstAtom) {
        directory = true; firstAtom = false; at++; return '';
      }
    };
    let value = atom(); if (value === undefined) return;
    while (tokens[at]?.value === '.' && tokens[at]?.kind === 'symbol') {
      at++; const next = atom(); if (next === undefined) return; value += next;
    }
    return value;
  }
  const value = expression(0);
  if (value === undefined) return;
  // __DIR__ is an absolute base, not a URL root. Only an explicit separator can
  // be converted to a path relative to the current file without guessing.
  if (directory && !value.startsWith('/')) return;
  return { end: at, path: directory ? `.${value}` : value };
}

export function discoverPhpDependencies(source: string): PhpDependencies {
  const references = new Set<string>(), warnings = new Set<string>(), markup: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const opening = source.indexOf('<?', cursor);
    if (opening < 0) { markup.push(source.slice(cursor)); break; }
    markup.push(source.slice(cursor, opening));
    const standard = /^<\?php(?=\s|$)/i.exec(source.slice(opening));
    const echo = source.startsWith('<?=', opening);
    if (!standard && !echo) {
      warnings.add('Korte of onbekende PHP-opening: resterende afhankelijkheden vereisen handmatige selectie.');
      markup.push('{PHP}'); break;
    }
    const block = lexBlock(source, opening + (standard?.[0].length ?? 3));
    markup.push('{PHP}'); cursor = block.end;
    if (block.malformed) {
      warnings.add('Onvolledige PHP-string, commentaar of heredoc: afhankelijkheden vereisen handmatige selectie.');
      break;
    }
    for (let i = 0; i < block.tokens.length; i++) {
      const token = block.tokens[i];
      if (token.kind !== 'word' || !includeWords.test(token.value)) continue;
      // Method names, variables and qualified names are not include operators.
      if (['$', '->', '?->', '::', '\\'].includes(block.tokens[i - 1]?.value)) continue;
      const parsed = literalExpression(block.tokens, i + 1);
      if (!parsed || parsed.end < block.tokens.length && block.tokens[parsed.end].value !== ';') {
        warnings.add('Dynamische of niet-ondersteunde PHP-include: selecteer het benodigde bestand handmatig.');
        continue;
      }
      const reference = parsed.path;
      if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(reference) || /[\\\u0000-\u001f\u007f]/.test(reference)) {
        warnings.add('Absolute, externe of onveilige PHP-includepad niet automatisch geselecteerd.');
        continue;
      }
      references.add(reference);
    }
  }
  return { references: [...references], warnings: [...warnings], staticMarkup: markup.join('') };
}

export interface DependencyReferences {
  fileReferences: string[];
  urlReferences: string[];
  warnings: string[];
}

/** Keep filesystem literals separate from URL references through resolution. */
export function collectDependencyReferences(content: string, language = 'html'): DependencyReferences {
  const phpLanguage = /^(?:php\d*|phtml|inc)$/i.test(language);
  if (phpLanguage || /<\?(?:php\b|=)/i.test(content)) {
    const parsed = discoverPhpDependencies(content);
    return { fileReferences: parsed.references, urlReferences: discoverDependencies(parsed.staticMarkup, phpLanguage ? 'html' : language), warnings: parsed.warnings };
  }
  return { fileReferences: [], urlReferences: discoverDependencies(content, language), warnings: [] };
}
