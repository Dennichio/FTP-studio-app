import { Children, cloneElement, isValidElement, useId, useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
export function Modal({ title, children, onClose, wide = false, footer }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; footer?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null), closeRef=useRef(onClose);closeRef.current=onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(box.current?.querySelectorAll<HTMLElement>('input,button,select,textarea,summary,a[href],[tabindex]') || [])
      .filter(element => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
    focusable()[0]?.focus();
    const listener = (event: KeyboardEvent) => {
      const layers = document.querySelectorAll('.modal-backdrop');
      if (layers[layers.length - 1] !== box.current?.parentElement) return;
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const items = focusable(), first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); box.current?.focus(); return; }
      const current = document.activeElement as HTMLElement | null;
      if (!current || !items.includes(current)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (event.shiftKey && current === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && current === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', listener);
    return () => { window.removeEventListener('keydown', listener); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={box}><header><h2>{title}</h2><button className="icon-button" title="Sluiten" onClick={onClose}><X size={18}/></button></header><div className="modal-body">{children}</div>{footer && <footer>{footer}</footer>}</div></div>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const labelId = useId(), hintId = `${labelId}-hint`;
  const annotate = (children: ReactNode): ReactNode => Children.map(children, child => {
    if (!isValidElement<{ children?: ReactNode; 'aria-label'?: string; 'aria-labelledby'?: string; 'aria-describedby'?: string }>(child) || typeof child.type !== 'string') return child;
    if (['input', 'select', 'textarea'].includes(child.type)) return cloneElement(child, {
      ...(!child.props['aria-label'] && !child.props['aria-labelledby'] ? { 'aria-labelledby': labelId } : {}),
      ...(hint ? { 'aria-describedby': [child.props['aria-describedby'], hintId].filter(Boolean).join(' ') } : {}),
    });
    return child.props.children ? cloneElement(child, {}, annotate(child.props.children)) : child;
  });
  return <label className="field"><span id={labelId}>{label}</span>{annotate(children)}{hint && <small id={hintId}>{hint}</small>}</label>;
}
export function Check({ label, checked, onChange }: {label:string;checked:boolean;onChange:(value:boolean)=>void}) { return <label className="check"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}/><span>{label}</span></label>; }
