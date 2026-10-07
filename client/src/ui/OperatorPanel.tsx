import { useEffect,useMemo,useRef,useState } from 'react';
import { TERRITORIES,type OperatorAttemptDetail,type OperatorAttemptRow,type OperatorOverview } from '@diplomacy/shared';
import { challengeRequest } from '../hooks/useChallenge.js';
import { MapGraph } from './MapGraph.js';

const usd=(nano:number)=>`$${(nano/1e9).toFixed(4)}`;
const short=(id:string)=>id.length>10?`${id.slice(0,8)}…`:id;
const ago=(at:number,now:number)=>{const s=Math.max(0,Math.round((now-at)/1000));return s<90?`${s}s ago`:s<5400?`${Math.round(s/60)}m ago`:`${Math.round(s/3600)}h ago`;};

/** Owner-only view. Everything shown comes from /api/operator, which re-checks the operator on every request. */
export function OperatorPanel(){
  const [overview,setOverview]=useState<OperatorOverview|null>(null),[detail,setDetail]=useState<OperatorAttemptDetail|null>(null);
  const [step,setStep]=useState<number|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState<string|null>(null);
  const [clock,setClock]=useState(Date.now());const watching=useRef<string|null>(null);
  async function load(){
    try{setOverview(await challengeRequest<OperatorOverview>('/operator/overview'));setClock(Date.now());}
    catch(e){setError((e as Error).message);}
  }
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),5000);return()=>clearInterval(timer);},[]);
  async function act(key:string,path:string,body:unknown){
    // Destructive controls need a second, explicit click on the same control.
    if(confirm!==key){setConfirm(key);return;}
    setConfirm(null);setBusy(true);setError('');
    try{await challengeRequest(path,body);await load();if(watching.current)await watch(watching.current);}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function watch(id:string){
    watching.current=id;setError('');
    try{const next=await challengeRequest<OperatorAttemptDetail>(`/operator/attempts/${id}`);if(watching.current===id){setDetail(next);setStep(null);}}
    catch(e){setError((e as Error).message);}
  }
  const report=detail&&step!==null?detail.reports[step]:undefined,shown=report?report.after:detail?.board;
  const mapState=useMemo(()=>shown?{units:shown.units,territories:Object.fromEntries(TERRITORIES.map(t=>[t.id,{id:t.id,isSupplyCenter:t.isSupplyCenter,owner:shown.territoryOwners[t.id]}]))}:null,[shown]);
  if(!overview)return <section className="operator-panel"><p role="status">{error||'Loading operator view…'}</p></section>;
  const o=overview,paidLabel=!o.paidConfigured?`Not enabled in this deployment${o.paid.stopped?' · switch is set to stopped':''}`:o.paid.stopped?`Stopped (pause #${o.paid.episode})`:'Running';
  const actions=(a:OperatorAttemptRow)=><>
    <button onClick={()=>void watch(a.id)}>Watch</button>
    {a.lifecycle==='ACTIVE'&&<button disabled={busy} onClick={()=>void act(`stop:${a.id}`,`/operator/attempts/${a.id}/stop`,{})}>{confirm===`stop:${a.id}`?'Confirm stop':'Stop'}</button>}
    <button disabled={busy} onClick={()=>void act(`ban:${a.playerId}`,`/operator/players/${a.playerId}/ban`,{banned:!a.playerBanned})}>{confirm===`ban:${a.playerId}`?(a.playerBanned?'Confirm unban':'Confirm ban'):(a.playerBanned?'Unban account':'Ban account')}</button></>;
  return <section className="operator-panel" aria-label="Operator controls">
    {error&&<div className="challenge-alert" role="alert">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}
    <div className="operator-tiles">
      <div><h2>Capacity</h2><strong>{o.activeAttempts} / {o.maxActiveAttempts}</strong><span>active attempts</span></div>
      <div><h2>Sponsored play</h2><strong>{paidLabel}</strong>
        <button disabled={busy} onClick={()=>void act('paid','/operator/paid',{stopped:!o.paid.stopped})}>{confirm==='paid'?(o.paid.stopped?'Confirm resume':'Confirm stop'):(o.paid.stopped?'Resume paid calls':'Stop new paid calls')}</button>
        <span>Stopping blocks every new provider call, including queued and recovered work. It never changes a budget.</span></div>
      <div><h2>Budget</h2><dl>
        <dt>Available</dt><dd>{usd(o.funding.availableNanousd)} of {usd(o.funding.ceilingNanousd)}</dd>
        <dt>Settled (all time)</dt><dd>{usd(o.funding.settledNanousd)}</dd>
        <dt>Reserved (in flight)</dt><dd>{usd(o.funding.reservedNanousd)}</dd>
        <dt>Unknown liability</dt><dd>{usd(o.funding.unknownLiabilityNanousd)}</dd>
        <dt>Per-attempt cap</dt><dd>{usd(o.funding.attemptCapNanousd)}</dd>
        <dt>Recent calls</dt><dd>{o.spend.calls} · {o.spend.inputTokens} in / {o.spend.outputTokens} out tokens</dd></dl>
        <span>Funds are added only by an explicit grant on the server. Nothing here refills on its own.</span></div>
      <div><h2>Notifications</h2><strong>{o.notifyMode==='outbox'?'Local outbox (nothing is emailed)':'Resend'}</strong>
        <span>{o.outbox.counts.PENDING+o.outbox.counts.SENDING} waiting · {o.outbox.counts.SENT} delivered · {o.outbox.counts.FAILED} failed</span></div>
    </div>
    <h2>Attempts</h2>
    {o.attempts.length===0?<p>No attempts are stored.</p>:<div className="operator-table" role="table" aria-label="Attempts">
      {o.attempts.map(a=><div role="row" key={a.id} className={detail?.attempt.id===a.id?'selected':''}>
        <span role="cell"><strong>{a.lifecycle}</strong> · {a.execution} · {a.mode==='SPONSORED'?'sponsored':'practice'}</span>
        <span role="cell">{a.challengeId} v{a.challengeVersion} · {a.year} {a.season} {a.phase}</span>
        <span role="cell">Attempt {short(a.id)} · account {short(a.playerId)} ({a.playerProvider}){a.playerBanned?' · banned':''}</span>
        <span role="cell">Active {ago(a.lastActivityAt,clock)}</span>
        <span role="cell" className="operator-actions">{actions(a)}</span></div>)}</div>}
    {detail&&mapState&&<div className="operator-spectate"><h2>Watching attempt {short(detail.attempt.id)}</h2>
      <p>{report?`${report.year} ${report.season} ${report.phase.toLowerCase()} · result`:`Current board · ${detail.board.year} ${detail.board.season} ${detail.board.phase}`} · {detail.score?`${detail.score.outcome}`:'no score yet'} · cost {usd(detail.funding.settledNanousd)} settled, {usd(detail.funding.heldNanousd)} held</p>
      <div className="operator-steps"><button disabled={step===null} onClick={()=>setStep(null)}>Current</button>
        {detail.reports.map((r,i)=><button key={r.id} disabled={step===i} onClick={()=>setStep(i)}>{r.year} {r.season} {r.phase}</button>)}
        <button onClick={()=>{watching.current=null;setDetail(null);}}>Close</button></div>
      <div className="operator-map"><MapGraph gameState={mapState} selectedTerritory={null} selectedUnit={null} validTargets={[]} pendingOrders={report?.phase==='ORDERS'?report.resolvedOrders:[]} onSelectTerritory={()=>{}} onClearSelection={()=>{}}/></div></div>}
    <h2>Recent notifications</h2>
    {o.outbox.recent.length===0?<p>None recorded.</p>:<ul className="operator-list">{o.outbox.recent.map(m=><li key={m.id}><strong>{m.kind==='ATTEMPT_STARTED'?'Attempt started':'Credit request'}</strong> · {m.state}{m.channel?` via ${m.channel}`:''} · {m.attempts} tries{m.lastError?` · last error ${m.lastError}`:''} · {new Date(m.createdAt).toISOString()}</li>)}</ul>}
    <h2>Recent operator actions</h2>
    {o.audit.length===0?<p>None recorded.</p>:<ul className="operator-list">{o.audit.map((x,i)=><li key={i}>{new Date(x.at).toISOString()} · {x.action}{x.target?` · ${short(x.target)}`:''}</li>)}</ul>}
  </section>;
}
