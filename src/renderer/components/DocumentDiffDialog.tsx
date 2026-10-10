import { useEffect, useId, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { ArrowDown, ArrowUp, FileClock, FileText } from 'lucide-react';
import type { AppSettings, DocumentComparison } from '../../shared/contracts';
import { formatSize, language } from '../utils';
import { Modal } from './Modal';
// CodeEditor owns the shared worker routing, language contributions and theme.
import './CodeEditor';
import './DocumentDiffDialog.css';

export interface DocumentDiffDialogProps {
  documentName: string;
  path: string;
  localContent: string;
  comparison: DocumentComparison;
  settings: AppSettings;
  onClose: () => void;
}

function contentEol(content: string): 'LF' | 'CRLF' {
  return /\r\n|\n/.exec(content)?.[0] === '\r\n' ? 'CRLF' : 'LF';
}
function formatDescription(content: string, eol: 'LF' | 'CRLF'): string {
  const mixed = /\r\n/.test(content) && /(^|[^\r])\n/.test(content) || /\r(?!\n)/.test(content);
  return `${mixed ? 'Gemengde regelafbrekingen' : eol} · UTF-8 ${content.startsWith('\uFEFF') ? 'met' : 'zonder'} BOM`;
}
const visibleText = (content: string) => content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

export function DocumentDiffDialog({ documentName, path, localContent, comparison, settings, onClose }: DocumentDiffDialogProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelId = useId();
  const [differenceCount, setDifferenceCount] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const theme = settings.theme === 'light' || settings.theme === 'system' && !systemDark ? 'vs' : 'ftp-studio';
  const savedLabel = comparison.source === 'remote' ? 'Opgeslagen serverversie' : 'Opgeslagen schijfversie';
  const editorEol = contentEol(localContent);
  const metadataDifferent = localContent !== comparison.content && visibleText(localContent) === visibleText(comparison.content);
  const checkedDate = new Date(comparison.checkedAt);

  useEffect(() => {
    const preference = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(preference.matches);
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!host.current) return;
    let original: monaco.editor.ITextModel | undefined;
    let modified: monaco.editor.ITextModel | undefined;
    let diff: monaco.editor.IStandaloneDiffEditor | undefined;
    let listener: monaco.IDisposable | undefined;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      listener?.dispose();
      diff?.setModel(null);
      diff?.dispose();
      original?.dispose();
      modified?.dispose();
      if (editor.current === diff) editor.current = null;
    };
    setError('');
    setDifferenceCount(null);
    try {
      const resource = encodeURIComponent(modelId);
      const filename = encodeURIComponent(documentName);
      original = monaco.editor.createModel(comparison.content, language(comparison.path), monaco.Uri.parse(`ftpstudio-diff://snapshot/${resource}/saved/${filename}`));
      modified = monaco.editor.createModel(localContent, language(path), monaco.Uri.parse(`ftpstudio-diff://snapshot/${resource}/editor/${filename}`));
      // Monaco stores BOM separately. createModel retains it; choosing the
      // snapshot's line endings keeps copy/selection consistent on each side.
      original.setEOL(comparison.eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      modified.setEOL(editorEol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      diff = monaco.editor.createDiffEditor(host.current, {
        theme, automaticLayout: true, renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false,
        enableSplitViewResizing: false, readOnly: true, domReadOnly: true, originalEditable: false,
        originalAriaLabel: savedLabel, modifiedAriaLabel: 'Uw editorversie',
        readOnlyMessage: { value: 'Deze vergelijking is alleen-lezen. Selecteer en kopieer tekst met Ctrl+C.' },
        renderMarginRevertIcon: false, renderGutterMenu: false, diffCodeLens: false,
        ignoreTrimWhitespace: false, hideUnchangedRegions: { enabled: false },
        minimap: { enabled: false }, fontSize: settings.editorFontSize,
        fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
        wordWrap: settings.wordWrap ? 'on' : 'off', diffWordWrap: settings.wordWrap ? 'on' : 'off',
        lineNumbers: 'on', scrollBeyondLastLine: false, contextmenu: false,
        padding: { top: 12, bottom: 12 }, fixedOverflowWidgets: true,
      });
      editor.current = diff;
      const instance = diff;
      listener = instance.onDidUpdateDiff(() => {
        if (!disposed) setDifferenceCount(instance.getLineChanges()?.length ?? null);
      });
      instance.setModel({ original, modified });
      instance.getOriginalEditor().updateOptions({ ariaLabel: savedLabel });
      instance.getModifiedEditor().updateOptions({ ariaLabel: 'Uw editorversie' });
    } catch {
      dispose();
      setError('De vergelijking kon niet worden weergegeven. Sluit dit venster en probeer het opnieuw.');
    }
    return dispose;
  }, [modelId, documentName, path, localContent, comparison.content, comparison.path, comparison.eol, comparison.source]);

  useEffect(() => {
    monaco.editor.setTheme(theme);
    const instance = editor.current;
    // Diff option updates also recalculate the child editors' accessibility
    // labels; retain them when updating appearance preferences.
    const options: monaco.editor.IStandaloneDiffEditorConstructionOptions = { fontSize: settings.editorFontSize, wordWrap: settings.wordWrap ? 'on' : 'off', diffWordWrap: settings.wordWrap ? 'on' : 'off', originalAriaLabel: savedLabel, modifiedAriaLabel: 'Uw editorversie' };
    instance?.updateOptions(options);
    instance?.getOriginalEditor().updateOptions({ ariaLabel: savedLabel });
    instance?.getModifiedEditor().updateOptions({ ariaLabel: 'Uw editorversie' });
  }, [theme, settings.editorFontSize, settings.wordWrap, savedLabel]);

  const summary = differenceCount === null ? 'Verschillen berekenen…'
    : differenceCount ? `${differenceCount} ${differenceCount === 1 ? 'verschil' : 'verschillen'}`
    : localContent === comparison.content ? 'Versies zijn gelijk.'
    : metadataDifferent ? 'Tekst is gelijk; regelafbrekingen of BOM verschillen.' : 'Geen tekstverschillen gemarkeerd.';
  return <Modal title={`Bestand vergelijken · ${documentName}`} wide onClose={onClose} footer={<button onClick={onClose}>Sluiten</button>}>
    <section className="document-diff" aria-label="Bestandsvergelijking">
      <div className="document-diff-meta">
        <p className="document-diff-path" title={comparison.path}><FileText size={14}/><span>{comparison.path}</span></p>
        <p className="document-diff-checked"><FileClock size={13}/><span>Gecontroleerd op <time dateTime={checkedDate.toISOString()}>{checkedDate.toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'medium' })}</time></span></p>
        <div className="document-diff-navigation">
          <span role="status">{error || summary}</span>
          <button disabled={!differenceCount || !!error} onClick={() => editor.current?.goToDiff('previous')}><ArrowUp size={13}/>Vorig verschil</button>
          <button disabled={!differenceCount || !!error} onClick={() => editor.current?.goToDiff('next')}><ArrowDown size={13}/>Volgend verschil</button>
        </div>
      </div>
      <div className="document-diff-headings">
        <div><strong>{savedLabel}</strong><small>{formatDescription(comparison.content, comparison.eol)} · {formatSize(comparison.snapshot.size)}</small></div>
        <div><strong>Uw editorversie</strong><small>Inclusief niet-opgeslagen wijzigingen · {formatDescription(localContent, editorEol)}</small></div>
      </div>
      <div className="document-diff-editor" ref={host} aria-label="Alleen-lezen vergelijking"/>
      <p className="document-diff-hint">Selecteer tekst in beide versies en kopieer met Ctrl+C.</p>
    </section>
  </Modal>;
}
