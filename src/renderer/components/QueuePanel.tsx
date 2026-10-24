import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ChevronUp, Pause, Play, RotateCcw, Search, Trash2, X, Maximize2, Minimize2 } from 'lucide-react';
import type { ConnectionState, LogEntry, TransferJob } from '../../shared/contracts';
import { formatSize } from '../utils';
import './QueuePanel.css';

const labels:Record<string,string>={queued:'Wachtend',running:'Actief',paused:'Gepauzeerd',completed:'Voltooid',failed:'Mislukt',cancelled:'Geannuleerd',conflict:'Conflict'};
const overscan = 5;
interface VirtualItem { id:string; }
interface ItemPosition { id:string; top:number; height:number; }
interface Measurement { width:number; content:string; height:number; }
function itemAt(positions:ItemPosition[], top:number):number {
  let low=0,high=positions.length;
  while(low<high){const mid=(low+high)>>>1;if(positions[mid].top+positions[mid].height<=top)low=mid+1;else high=mid;}
  return Math.min(low,Math.max(0,positions.length-1));
}
function wrappedLines(text:string,characters:number):number {
  return text.split('\n').reduce((total,line)=>total+Math.max(1,Math.ceil(line.length/characters)),0);
}
const jobContent=(job:TransferJob)=>job.error||'';
const logContent=(log:LogEntry)=>log.message;
const estimateJob=(job:TransferJob,width:number)=>job.error ? Math.max(45,44+wrappedLines(job.error,Math.max(12,Math.floor(width*.3/5)))*12) : 45;
const estimateLog=(log:LogEntry,width:number)=>13+wrappedLines(log.message,Math.max(12,Math.floor((width-145)/6)))*15;

function MeasuredRow({id,index,total,top,content,onMeasure,children}:{id:string;index:number;total:number;top:number;content:string;onMeasure:(id:string,content:string,height:number)=>void;children:ReactNode}) {
  const ref=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const element=ref.current;if(!element)return;
    const measure=()=>onMeasure(id,content,element.getBoundingClientRect().height);
    const observer=new ResizeObserver(measure);observer.observe(element);measure();return()=>observer.disconnect();
  },[id,content,onMeasure]);
  return <div ref={ref} className="queue-virtual-row" data-virtual-id={id} role="listitem" aria-posinset={index+1} aria-setsize={total} tabIndex={-1} style={{top}}>{children}</div>;
}

/** Natural row heights preserve full messages; only the viewport and a small margin are mounted. */
function VirtualQueueList<T extends VirtualItem>({items,label,contentKey,estimateHeight,renderItem}:{items:T[];label:string;contentKey:(item:T)=>string;estimateHeight:(item:T,width:number)=>number;renderItem:(item:T)=>ReactNode}) {
  const viewportRef=useRef<HTMLDivElement>(null), measurements=useRef(new Map<string,Measurement>()), previousPositions=useRef<ItemPosition[]>([]);
  const previousScrollTop=useRef(0);
  const pendingFocus=useRef<{id:string;lastAction?:boolean}|null>(null);
  const [viewport,setViewport]=useState({top:0,height:200,width:1000}),[revision,setRevision]=useState(0),[focusedId,setFocusedId]=useState<string|null>(null);
  const readViewport=useCallback(()=>{
    const element=viewportRef.current;if(!element)return;
    const next={top:element.scrollTop,height:element.clientHeight,width:element.clientWidth};
    previousScrollTop.current=next.top;
    setViewport(old=>old.top===next.top&&old.height===next.height&&old.width===next.width?old:next);
  },[]);
  useLayoutEffect(()=>{
    const element=viewportRef.current;if(!element)return;
    const observer=new ResizeObserver(readViewport);observer.observe(element);readViewport();return()=>observer.disconnect();
  },[readViewport]);
  useEffect(()=>{
    const ids=new Set(items.map(item=>item.id));
    for(const id of measurements.current.keys())if(!ids.has(id))measurements.current.delete(id);
    if(focusedId&&!ids.has(focusedId)){setFocusedId(null);viewportRef.current?.focus({preventScroll:true});}
  },[items,focusedId]);
  const positions=useMemo(()=>{
    let top=0;
    return items.map(item=>{
      const measured=measurements.current.get(item.id);
      const height=measured?.width===viewport.width&&measured.content===contentKey(item)?measured.height:estimateHeight(item,viewport.width);
      const position={id:item.id,top,height};top+=height;return position;
    });
  },[items,viewport.width,revision,contentKey,estimateHeight]);
  const totalHeight=positions.length?positions.at(-1)!.top+positions.at(-1)!.height:0;
  useLayoutEffect(()=>{
    const element=viewportRef.current;if(!element)return;
    const previous=previousPositions.current;
    // Keep the message being read anchored when earlier heights change or new logs arrive.
    const oldTop=previousScrollTop.current;
    if(oldTop>0&&previous.length){
      const anchor=previous[itemAt(previous,oldTop)],next=positions.find(position=>position.id===anchor.id);
      if(next)element.scrollTop=Math.max(0,next.top+Math.min(oldTop-anchor.top,Math.max(0,next.height-1)));
    }
    previousPositions.current=positions;readViewport();
  },[positions,readViewport]);
  const onMeasure=useCallback((id:string,content:string,height:number)=>{
    if(height<=0)return;
    const existing=measurements.current.get(id);
    if(existing?.height===height&&existing.width===viewport.width&&existing.content===content)return;
    measurements.current.set(id,{height,width:viewport.width,content});setRevision(value=>value+1);
  },[viewport.width]);
  const first=itemAt(positions,viewport.top),last=itemAt(positions,viewport.top+viewport.height);
  const indices=new Set(Array.from({length:Math.max(0,Math.min(items.length,last+overscan+1)-Math.max(0,first-overscan))},(_,index)=>Math.max(0,first-overscan)+index));
  const focusedIndex=focusedId?items.findIndex(item=>item.id===focusedId):-1;
  if(focusedIndex>=0)indices.add(focusedIndex);
  useLayoutEffect(()=>{
    const pending=pendingFocus.current;if(!pending)return;
    const element=viewportRef.current;
    const row=Array.from(element?.querySelectorAll<HTMLElement>('[data-virtual-id]')||[]).find(candidate=>candidate.dataset.virtualId===pending.id);
    if(!row)return;
    const actions=Array.from(row.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    (pending.lastAction&&actions.length?actions.at(-1)!:row).focus({preventScroll:true});pendingFocus.current=null;
  });
  const focusIndex=(index:number,lastAction=false)=>{
    const target=items[index],position=positions[index],element=viewportRef.current;if(!target||!element)return;
    const row=Array.from(element.querySelectorAll<HTMLElement>('[data-virtual-id]')).find(candidate=>candidate.dataset.virtualId===target.id);
    if(row){
      pendingFocus.current=null;
      const actions=Array.from(row.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      (lastAction&&actions.length?actions.at(-1)!:row).focus({preventScroll:true});
    }else pendingFocus.current={id:target.id,lastAction};
    setFocusedId(target.id);
    if(position.top<element.scrollTop)element.scrollTop=position.top;
    else if(position.top+position.height>element.scrollTop+element.clientHeight)element.scrollTop=Math.max(position.top,position.top+position.height-element.clientHeight);
    readViewport();
  };
  const onKeyDown=(event:KeyboardEvent<HTMLDivElement>)=>{
    const target=event.target as HTMLElement,row=target.closest<HTMLElement>('[data-virtual-id]');
    const index=row?items.findIndex(item=>item.id===row.dataset.virtualId):-1;
    if(event.key==='Tab'&&row){
      const actions=Array.from(row.querySelectorAll<HTMLElement>('button:not(:disabled)'));
      if(!event.shiftKey&&(target===actions.at(-1)||target===row&&!actions.length)&&index<items.length-1){event.preventDefault();focusIndex(index+1);}
      else if(event.shiftKey&&(target===row||target===actions[0])&&index>0){event.preventDefault();focusIndex(index-1,true);}
      return;
    }
    if(target!==event.currentTarget&&target!==row)return;
    if(!['ArrowDown','ArrowUp','Home','End','PageDown','PageUp'].includes(event.key)||!items.length)return;
    event.preventDefault();
    const current=index>=0?index:first;
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='PageDown'?itemAt(positions,positions[current].top+viewport.height):event.key==='PageUp'?itemAt(positions,Math.max(0,positions[current].top-viewport.height)):current+(event.key==='ArrowDown'?1:-1);
    focusIndex(Math.max(0,Math.min(items.length-1,next)));
  };
  return <div className="queue-content queue-virtual-content" ref={viewportRef} role="list" aria-label={label} tabIndex={0} onScroll={readViewport} onKeyDown={onKeyDown} onFocusCapture={event=>setFocusedId((event.target as HTMLElement).closest<HTMLElement>('[data-virtual-id]')?.dataset.virtualId??null)} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setFocusedId(null);}}>
    {!items.length?<div className="queue-empty">{label==='Overdrachten'?'Geen overdrachten voor dit filter.':'Geen meldingen voor dit filter.'}</div>:<div className="queue-virtual-canvas" style={{height:totalHeight}}>{[...indices].sort((a,b)=>a-b).map(index=><MeasuredRow key={items[index].id} id={items[index].id} index={index} total={items.length} top={positions[index].top} content={contentKey(items[index])} onMeasure={onMeasure}>{renderItem(items[index])}</MeasuredRow>)}</div>}
  </div>;
}

export function QueuePanel({preparing,jobs,logs,connections,expanded,onToggle,onAction,height,onHide,onMaximize,maximized}:{preparing?:string;jobs:TransferJob[];logs:LogEntry[];connections:ConnectionState[];expanded:boolean;onToggle:()=>void;onAction:(action:'pause'|'resume'|'cancel'|'retry'|'clear'|'priority'|'raisePriority'|'lowerPriority',ids?:string[],priority?:number)=>void;height:number;onHide:()=>void;onMaximize:()=>void;maximized:boolean}) {
  const [tab,setTab]=useState('queue'),[filter,setFilter]=useState(''),[connectionFilter,setConnectionFilter]=useState('all'),[logLevel,setLogLevel]=useState('all');
  const connectionIds=useMemo(()=>[...new Set([...connections.map(c=>c.id),...jobs.map(j=>j.connectionId),...logs.flatMap(l=>l.connectionId?[l.connectionId]:[])])],[connections,jobs,logs]);
  const needle=filter.toLowerCase();
  const filteredJobs=useMemo(()=>jobs.filter(j=>(connectionFilter==='all'||j.connectionId===connectionFilter)&&(j.localPath+j.remotePath+(j.error||'')).toLowerCase().includes(needle)),[jobs,connectionFilter,needle]);
  const filteredLogs=useMemo(()=>logs.filter(l=>(logLevel==='all'||l.level===logLevel)&&(connectionFilter==='all'||l.connectionId===connectionFilter)&&l.message.toLowerCase().includes(needle)).reverse(),[logs,logLevel,connectionFilter,needle]);
  const active=filteredJobs.filter(j=>['queued','running','paused'].includes(j.status)),completed=filteredJobs.filter(j=>j.status==='completed').length;
  const resetKey=JSON.stringify([tab,needle,connectionFilter,logLevel]);
  const renderJob=(j:TransferJob)=><div className="job-row" data-job-id={j.id}>
    <span className={`job-direction ${j.direction}`}>{j.direction==='upload'?<ArrowUp size={15}/>:<ArrowDown size={15}/>}</span>
    <div className="job-name"><strong title={(j.direction==='upload'?j.localPath:j.remotePath).split(/[\\/]/).pop()}>{(j.direction==='upload'?j.localPath:j.remotePath).split(/[\\/]/).pop()}</strong><small title={j.remotePath}>{j.remotePath}</small>{j.error&&<small className="danger-text job-error">{j.error}</small>}</div>
    <span className={`job-status ${j.status}`}>{labels[j.status]}</span>
    <div className="job-progress"><div><span style={{width:`${j.size?Math.min(100,j.transferred/j.size*100):j.status==='completed'?100:0}%`}}/></div><small>{formatSize(j.transferred)} / {formatSize(j.size)}</small></div>
    <span className="job-speed">{j.status==='running'?`${formatSize(j.speed)}/s`:j.status==='completed'?<CheckCircle2 size={14}/>:''}<small>{j.remainingSeconds!==null&&j.status==='running'?`${Math.ceil(j.remainingSeconds)} sec`:''}</small></span>
    <div className="job-actions">
      {j.status==='paused'?<button className="icon-button" title="Hervatten" onClick={()=>onAction('resume',[j.id])}><Play size={13}/></button>:['running','queued'].includes(j.status)?<button className="icon-button" title="Pauzeren" onClick={()=>onAction('pause',[j.id])}><Pause size={13}/></button>:['failed','cancelled','conflict'].includes(j.status)?<button className="icon-button" title="Opnieuw proberen" onClick={()=>onAction('retry',[j.id])}><RotateCcw size={13}/></button>:null}
      {['queued','paused'].includes(j.status)&&<><button className="icon-button" title="Hogere prioriteit" disabled={(j.priority??50)>=100} onClick={()=>onAction('raisePriority',[j.id])}><ArrowUp size={13}/></button><button className="icon-button" title="Lagere prioriteit" disabled={(j.priority??50)<=0} onClick={()=>onAction('lowerPriority',[j.id])}><ArrowDown size={13}/></button></>}
      {['completed','cancelled','failed','conflict'].includes(j.status)?<button className="icon-button" title="Uit wachtrij verwijderen" onClick={()=>onAction('clear',[j.id])}><Trash2 size={13}/></button>:<button className="icon-button" title="Annuleren" onClick={()=>onAction('cancel',[j.id])}><X size={13}/></button>}
    </div>
  </div>;
  const renderLog=(l:LogEntry)=><div className={`log-row ${l.level}`} data-log-id={l.id}><time>{new Date(l.time).toLocaleTimeString('nl-NL')}</time><span>{l.level==='error'?'FOUT':l.level==='warning'?'LET OP':l.level==='debug'?'DEBUG':'INFO'}</span><p>{l.message}</p></div>;
  return <section className={`queue-panel ${expanded?'expanded':''} ${maximized?'maximized':''}`} style={{height:maximized?'100%':expanded?height:37}}>
    <div className="queue-heading">
      <button className={`panel-tab ${tab==='queue'?'active':''}`} aria-pressed={tab==='queue'} onClick={()=>{setTab('queue');if(!expanded)onToggle();}}>Overdrachtswachtrij <span className="badge">{active.length}</span></button>
      <button className={`panel-tab ${tab==='logs'?'active':''}`} aria-pressed={tab==='logs'} onClick={()=>{setTab('logs');if(!expanded)onToggle();}}>Activiteitenlog <span className="badge">{filteredLogs.filter(l=>l.level==='error').length||''}</span></button>
      <div className="spacer"/>{preparing&&!expanded&&<span role="status">Overdracht voorbereiden…</span>}<span className="muted small">{completed>0&&`${completed} voltooid`}</span>
      <button className="icon-button" title="Getoonde overdrachten pauzeren" onClick={()=>onAction('pause',active.map(j=>j.id))} disabled={!active.length}><Pause size={13}/></button>
      <button className="icon-button" title="Getoonde overdrachten hervatten" onClick={()=>onAction('resume',filteredJobs.filter(j=>j.status==='paused').map(j=>j.id))} disabled={!filteredJobs.some(j=>j.status==='paused')}><Play size={13}/></button>
      <button className="icon-button" title="Afgeronde overdrachten wissen" onClick={()=>onAction('clear',filteredJobs.filter(j=>['completed','failed','cancelled','conflict'].includes(j.status)).map(j=>j.id))}><Trash2 size={13}/></button>
      <button className="icon-button" title={maximized?'Wachtrij herstellen':'Wachtrij maximaliseren'} onClick={onMaximize}>{maximized?<Minimize2 size={13}/>:<Maximize2 size={13}/>}</button>
      <button className="icon-button" title="Wachtrij verbergen" onClick={onHide}><X size={13}/></button>
      <button className="icon-button" title={expanded?'Paneel inklappen':'Paneel uitklappen'} onClick={onToggle}>{expanded?<ChevronDown size={15}/>:<ChevronUp size={15}/>}</button>
    </div>
    {preparing&&expanded&&<div className="queue-preparing" role="status" aria-live="polite">{preparing}</div>}
    {expanded&&<><div className="queue-filter">
      <select aria-label="Wachtrijverbinding filteren" value={connectionFilter} onChange={e=>setConnectionFilter(e.target.value)}><option value="all">Alle verbindingen</option>{connectionIds.map(id=><option value={id} key={id}>{connections.find(c=>c.id===id)?.profile.name||id}</option>)}</select>
      {tab==='logs'&&<select aria-label="Logniveau filteren" value={logLevel} onChange={e=>setLogLevel(e.target.value)}><option value="all">Alle niveaus</option><option value="error">Fouten</option><option value="warning">Waarschuwingen</option><option value="info">Informatie</option><option value="debug">Debug</option></select>}
      <Search size={13}/><input aria-label="Wachtrij of log doorzoeken" placeholder={tab==='queue'?'Zoek een overdracht…':'Doorzoek activiteiten…'} value={filter} onChange={e=>setFilter(e.target.value)}/><span className="muted">{tab==='queue'?`${filteredJobs.length} overdrachten`:`${filteredLogs.length} meldingen`}</span>
    </div>{tab==='queue'?<VirtualQueueList key={resetKey} items={filteredJobs} label="Overdrachten" contentKey={jobContent} estimateHeight={estimateJob} renderItem={renderJob}/>:<VirtualQueueList key={resetKey} items={filteredLogs} label="Activiteitenmeldingen" contentKey={logContent} estimateHeight={estimateLog} renderItem={renderLog}/>}</>}
  </section>;
}
