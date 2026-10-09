import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/language/html/monaco.contribution';
import 'monaco-editor/esm/vs/language/css/monaco.contribution';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution';
import type { AppSettings } from '../../shared/contracts';
import { language } from '../utils';

(window as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorkerUrl(_moduleId: string, label: string) {
    const file = label === 'html' || label === 'handlebars' || label === 'razor' ? 'html'
      : label === 'css' || label === 'scss' || label === 'less' ? 'css'
      : label === 'json' ? 'json'
      : label === 'javascript' || label === 'typescript' ? 'ts' : 'editor';
    return new URL(`./${file}.worker.js`, location.href).href;
  }
};
monaco.editor.defineTheme('ftp-studio', {
  base: 'vs-dark', inherit: true,
  rules: [{ token: 'tag', foreground: '7aaef5' }, { token: 'attribute.name', foreground: 'bc9df4' },
    { token: 'attribute.value', foreground: 'abd58b' }, { token: 'comment', foreground: '657284' }],
  colors: { 'editor.background': '#141a23', 'editorLineNumber.foreground': '#475369',
    'editorLineNumber.activeForeground': '#bac4d3', 'editor.lineHighlightBackground': '#1b2330',
    'editor.selectionBackground': '#294768', 'editorCursor.foreground': '#a4c7ff',
    'editorIndentGuide.background1': '#253043' }
});
interface CachedModel { model: monaco.editor.ITextModel; view?: monaco.editor.ICodeEditorViewState | null; }
const models = new Map<string, CachedModel>();
/** Dormant tabs keep their model, undo history and view until the document is closed. */
export function retainDocumentModels(ids: ReadonlySet<string>): void {
  for (const [id, cached] of models) if (!ids.has(id)) { cached.model.dispose(); models.delete(id); }
}
const value = (model: monaco.editor.ITextModel) => model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true);
const editableText = (text: string) => text.startsWith('\uFEFF') ? text.slice(1) : text;
export interface CodeEditorHandle { insert(text: string): void; reveal(start: number, end?: number): void; revealLine(line: number): void; }
interface EditorProps {
  documentId: string; path: string; content: string; eol: 'LF' | 'CRLF'; settings: AppSettings;
  onChange: (content: string) => void; onCursor: (offset: number, line: number, column: number) => void; onSave: () => void;
}
export const CodeEditor = forwardRef<CodeEditorHandle, EditorProps>((p, ref) => {
  const container = useRef<HTMLDivElement>(null), editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const model = useRef<monaco.editor.ITextModel | null>(null), callbacks = useRef(p); callbacks.current = p;
  const theme = p.settings.theme === 'light' || p.settings.theme === 'system' && !matchMedia('(prefers-color-scheme: dark)').matches ? 'vs' : 'ftp-studio';
  useImperativeHandle(ref, () => ({
    insert(text) { const ed = editor.current, range = ed?.getSelection(); if (ed && range) { ed.executeEdits('snippet', [{ range, text, forceMoveMarkers: true }]); ed.focus(); } },
    revealLine(line) { const ed = editor.current; if (ed) { ed.setPosition({ lineNumber: line, column: 1 }); ed.revealLineInCenter(line); ed.focus(); } },
    reveal(start, end) { const m = model.current, ed = editor.current; if (m && ed) { const bom = value(m).startsWith('\uFEFF') ? 1 : 0; const a = m.getPositionAt(Math.max(0,start-bom)), b = m.getPositionAt(Math.max(0,(end??start)-bom)); ed.setSelection(new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column)); ed.revealLineInCenter(a.lineNumber); } }
  }), []);
  useEffect(() => {
    if (!container.current) return;
    const ed = monaco.editor.create(container.current, { theme, automaticLayout: true, minimap: { enabled: false },
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace', fontSize: callbacks.current.settings.editorFontSize,
      lineNumbers: 'on', scrollBeyondLastLine: false, padding: { top: 14, bottom: 14 }, renderLineHighlight: 'line',
      tabSize: 2, wordWrap: callbacks.current.settings.wordWrap ? 'on' : 'off', fixedOverflowWidgets: true });
    editor.current = ed;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave());
    const cursor = ed.onDidChangeCursorPosition(e => { const m = ed.getModel(); if (m) callbacks.current.onCursor(m.getOffsetAt(e.position)+(value(m).startsWith('\uFEFF')?1:0), e.position.lineNumber, e.position.column); });
    return () => { const current=models.get(callbacks.current.documentId);if(current)current.view=ed.saveViewState();cursor.dispose();ed.setModel(null);ed.dispose();editor.current=null;model.current=null; };
  }, []);
  useEffect(() => {
    const ed = editor.current; if (!ed) return;
    let cached = models.get(p.documentId);
    if (!cached || cached.model.isDisposed()) {
      const m = monaco.editor.createModel(p.content, language(p.path), monaco.Uri.parse(`ftpstudio://document/${encodeURIComponent(p.documentId)}/${encodeURIComponent(p.path)}`));
      m.setEOL(p.eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      cached = { model: m }; models.set(p.documentId, cached);
    } else if (value(cached.model) !== p.content) {
      cached.model.pushEditOperations([], [{ range: cached.model.getFullModelRange(), text: editableText(p.content) }], () => null);
    }
    const current = cached, m = current.model; ed.setModel(m); model.current = m;
    if (current.view) ed.restoreViewState(current.view);
    const sub = m.onDidChangeContent(() => callbacks.current.onChange(value(m)));
    return () => { if(editor.current===ed)current.view=ed.saveViewState(); sub.dispose(); if(editor.current===ed)ed.setModel(null); if (model.current === m) model.current = null; };
  }, [p.documentId, p.path]);
  useEffect(() => {
    const m = model.current; if (!m || value(m) === p.content) return;
    const ed = editor.current, selection = ed?.getSelection();
    ed?.executeEdits('source-patch', [{ range: m.getFullModelRange(), text: editableText(p.content) }]);
    if (selection) ed?.setSelection(selection);
  }, [p.content]);
  useEffect(() => { editor.current?.updateOptions({ fontSize: p.settings.editorFontSize, wordWrap: p.settings.wordWrap ? 'on' : 'off' }); monaco.editor.setTheme(theme); }, [p.settings.editorFontSize, p.settings.wordWrap, theme]);
  return <div className="monaco-host" ref={container} aria-label="Broncode-editor"/>;
});
