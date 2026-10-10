import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, LockKeyhole } from 'lucide-react';
import type { SourceNode } from '../../core/source';
import './DomTree.css';

export interface DomTreeProps {
  nodes: SourceNode[];
  roots: string[];
  selectedId: string;
  sourceHash: string;
  documentId: string;
  editable: boolean;
  onSelect: (node: SourceNode) => void;
  onDrop: (event: DragEvent<HTMLElement>, node: SourceNode) => void;
}
interface TreeState { revision: string; collapsed: Set<string>; focusedId: string; }
interface VisibleNode { node: SourceNode; level: number; position: number; siblings: number; }
const structuralTags = new Set('html head body base meta link title'.split(' '));
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const dragType = 'application/x-ftp-node';
const nodeLabel = (node: SourceNode) => `‹${node.tag}›${node.attributes.id ? ` #${node.attributes.id}` : ''}${node.classes.length ? ` .${node.classes.join(' .')}` : ''}`;

export function DomTree({ nodes, roots, selectedId, sourceHash, documentId, editable, onSelect, onDrop }: DomTreeProps) {
  const revision = `${documentId}\0${sourceHash}`;
  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const protectedSubtrees = useMemo(() => {
    const blocked = new Set<string>();
    for (const node of nodes) {
      if (node.editable) continue;
      let id: string | undefined = node.id;
      while (id && !blocked.has(id)) { blocked.add(id); id = byId.get(id)?.parentId; }
    }
    return blocked;
  }, [nodes, byId]);
  const firstId = roots.find(id => byId.has(id)) ?? '';
  const [state, setState] = useState<TreeState>(() => ({ revision, collapsed: new Set(), focusedId: selectedId || firstId }));
  const current = state.revision === revision ? state : { revision, collapsed: new Set<string>(), focusedId: selectedId || firstId };
  const rows = useRef(new Map<string, HTMLDivElement>());
  const dragged = useRef<{ node: SourceNode; revision: string } | null>(null);

  useEffect(() => {
    dragged.current = null;
    setState(previous => previous.revision === revision ? previous : { revision, collapsed: new Set(), focusedId: selectedId || firstId });
  }, [revision]);

  // A new selection from the code editor or canvas reveals its ancestors. A
  // user collapse survives unrelated renders and repeated unchanged selection.
  useEffect(() => {
    if (!selectedId || !byId.has(selectedId)) return;
    const ancestors = new Set<string>();
    let parentId = byId.get(selectedId)?.parentId;
    while (parentId && !ancestors.has(parentId)) {
      ancestors.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    setState(previous => {
      const collapsed = new Set(previous.revision === revision ? previous.collapsed : []);
      for (const ancestor of ancestors) collapsed.delete(ancestor);
      return { revision, collapsed, focusedId: selectedId };
    });
  }, [selectedId, revision]);

  const visible: VisibleNode[] = [];
  const visited = new Set<string>();
  const visit = (ids: string[], level: number) => {
    const siblings = ids.filter(id => byId.has(id));
    siblings.forEach((id, position) => {
      const node = byId.get(id)!;
      if (visited.has(id)) return;
      visited.add(id);
      visible.push({ node, level, position: position + 1, siblings: siblings.length });
      if (!current.collapsed.has(id)) visit(node.children, level + 1);
    });
  };
  visit(roots, 1);
  const focusId = visible.some(row => row.node.id === current.focusedId) ? current.focusedId : visible[0]?.node.id;

  const update = (change: (draft: TreeState) => TreeState) => setState(previous => change(previous.revision === revision ? previous : { revision, collapsed: new Set(), focusedId: firstId }));
  const focus = (id: string) => {
    update(previous => ({ ...previous, focusedId: id }));
    rows.current.get(id)?.focus();
    rows.current.get(id)?.scrollIntoView({ block: 'nearest' });
  };
  const toggle = (node: SourceNode, expand?: boolean) => {
    const opening = expand ?? current.collapsed.has(node.id);
    update(previous => {
      const collapsed = new Set(previous.collapsed);
      if (opening) collapsed.delete(node.id); else collapsed.add(node.id);
      return { ...previous, collapsed, focusedId: node.id };
    });
    rows.current.get(node.id)?.focus();
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>, node: SourceNode) => {
    const index = visible.findIndex(row => row.node.id === node.id);
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') focus(visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))].node.id);
    else if (event.key === 'Home') focus(visible[0].node.id);
    else if (event.key === 'End') focus(visible[visible.length - 1].node.id);
    else if (event.key === 'ArrowLeft') {
      if (node.children.length && !current.collapsed.has(node.id)) toggle(node, false);
      else if (node.parentId && visible.some(row => row.node.id === node.parentId)) focus(node.parentId);
    } else if (event.key === 'ArrowRight') {
      if (node.children.length && current.collapsed.has(node.id)) toggle(node, true);
      else {
        const child = node.children.find(id => visible.some(row => row.node.id === id));
        if (child) focus(child);
      }
    } else onSelect(node);
  };
  const movable = (node: SourceNode) => editable && node.editable && !structuralTags.has(node.tag)
    && !protectedSubtrees.has(node.id);
  const acceptsDrop = (node: SourceNode) => editable && node.editable && !voidTags.has(node.tag)
    && (!structuralTags.has(node.tag) || node.tag === 'body')
    && !(dragged.current?.revision === revision && node.start >= dragged.current.node.start && node.end <= dragged.current.node.end);

  return <div role="tree" aria-label="DOM-structuur" className="dom-tree">
    {!visible.length && <p className="muted">Geen bronelementen beschikbaar.</p>}
    {visible.map(({ node, level, position, siblings }) => {
      const branch = node.children.some(id => byId.has(id));
      const expanded = branch && !current.collapsed.has(node.id);
      const protectedNode = !editable || !node.editable;
      const label = nodeLabel(node);
      return <div key={node.id} ref={element => { if (element) rows.current.set(node.id, element); else rows.current.delete(node.id); }}
        role="treeitem" aria-label={label} aria-level={level} aria-posinset={position} aria-setsize={siblings}
        aria-expanded={branch ? expanded : undefined} aria-selected={node.id === selectedId}
        tabIndex={node.id === focusId ? 0 : -1} data-node-id={node.id}
        className={`dom-node dom-tree-row${node.id === selectedId ? ' active' : ''}${protectedNode ? ' protected' : ''}`}
        style={{ paddingLeft: 4 + (level - 1) * 12 }}
        title={`${label} · bronpositie ${node.start}${protectedNode ? ' · Beschermd element' : ''}`}
        onFocus={() => update(previous => previous.focusedId === node.id ? previous : { ...previous, focusedId: node.id })}
        onClick={() => { focus(node.id); onSelect(node); }} onKeyDown={event => keyDown(event, node)}
        draggable={movable(node)}
        onDragStart={event => {
          if (!movable(node)) { event.preventDefault(); return; }
          dragged.current = { node, revision };
          event.dataTransfer.setData(dragType, JSON.stringify({ documentId, sourceHash, nodeId: node.id }));
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => { dragged.current = null; }}
        onDragOver={event => {
          if (event.dataTransfer.types.includes(dragType) && acceptsDrop(node)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
        }}
        onDrop={event => {
          event.preventDefault(); event.stopPropagation();
          if (event.dataTransfer.types.includes(dragType) && acceptsDrop(node)) onDrop(event, node);
          dragged.current = null;
        }}>
        {branch ? <button type="button" className="dom-tree-toggle" tabIndex={-1} aria-label={`${label} ${expanded ? 'inklappen' : 'uitklappen'}`}
          onClick={event => { event.stopPropagation(); toggle(node); }} onMouseDown={event => event.preventDefault()}>
          {expanded ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
        </button> : <span className="dom-tree-toggle-placeholder" aria-hidden="true"/>}
        <span className="dom-tree-tag">‹{node.tag}›</span>
        <small className="dom-tree-identity">{node.attributes.id ? `#${node.attributes.id}` : ''}{node.classes.length ? ` .${node.classes.join(' .')}` : ''}</small>
        {protectedNode && <LockKeyhole size={10} aria-label="Beschermd element" className="dom-tree-lock"/>}
      </div>;
    })}
  </div>;
}
