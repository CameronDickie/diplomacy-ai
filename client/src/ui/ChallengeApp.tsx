import { useEffect,useMemo,useState } from 'react';
import { TERRITORIES, type ChallengeAction,type ChallengeAttemptView,type ChallengeCard,type ChallengeLimits,type PublicPhaseReport,type Unit } from '@diplomacy/shared';
import { useChallenge } from '../hooks/useChallenge.js';
import { MapGraph } from './MapGraph.js';
import { territoryName } from '../lib/game.js';

export function ChallengeApp(){
  const game=useChallenge(),a=game.attempt,card=a?.challenge??game.cards[0];
  const [selected,setSelected]=useState<string|null>(null),[choices,setChoices]=useState<Record<string,string>>({});
  const [retreats,setRetreats]=useState<Record<string,string>>({}),[builds,setBuilds]=useState<Record<string,string>>({}),[disbands,setDisbands]=useState<string[]>([]);
  const [replay,setReplay]=useState<{reports:PublicPhaseReport[];index:number;after:boolean;reference:boolean}|null>(null),[confirmAbandon,setConfirmAbandon]=useState(false);
  const [clock,setClock]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{setChoices({});setRetreats({});setBuilds({});setDisbands([]);setSelected(null);setReplay(null);setConfirmAbandon(false);},[a?.id,a?.phaseId,game.auth.user?.id]);
  const board=a?.board??card?.board;
  const report=replay?.reports[replay.index];
  const shown=report?(replay!.after?report.after:report.before):board;
  const mapState=useMemo(()=>shown?{units:shown.units,territories:Object.fromEntries(TERRITORIES.map(t=>[t.id,{id:t.id,isSupplyCenter:t.isSupplyCenter,owner:shown.territoryOwners[t.id]}]))}:null,[shown]);
  const own=board?.units.filter(u=>u.power===card?.humanPower)??[];
  const selectedUnit=own.find(u=>u.territory===selected&&!u.mustRetreat)??null;
  const editable=Boolean(a&&a.lifecycle==='ACTIVE'&&a.execution==='ACCEPTING'&&!game.busy&&!replay);
  const options=game.legal?.options??[];
  const defaultOrder=(u:Unit)=>options.find(o=>o.unitTerritory===u.territory&&o.order.type==='HOLD')?.id??'';
  const chosenOrders=own.filter(u=>!u.mustRetreat).map(u=>options.find(o=>o.id===(choices[u.id]??defaultOrder(u)))?.order).filter(o=>o!==undefined);
  const buildDelta=board&&card?TERRITORIES.filter(t=>t.isSupplyCenter&&board.territoryOwners[t.id]===card.humanPower).length-own.length:0;
  const homes=TERRITORIES.filter(t=>t.homePower===card?.humanPower&&board?.territoryOwners[t.id]===card?.humanPower&&!board?.units.some(u=>u.territory===t.id));
  function activity(){void game.activity();}
  function submission():ChallengeAction|null{
    if(!a)return null;
    if(a.board.phase==='ORDERS')return {phase:'ORDERS',orderIds:chosenOrders.map(o=>o.id)};
    if(a.board.phase==='RETREATS')return {phase:'RETREATS',retreats:Object.fromEntries(own.filter(u=>u.mustRetreat).map(u=>{const raw=retreats[u.id];const [territory,coast]=raw?.split('/')??[];return [u.id,territory?{territory,coast:coast||null}:null];}))} as ChallengeAction;
    return {phase:'BUILDS',builds:Object.entries(builds).filter(([,v])=>!!v).map(([territory,v])=>{const [type,coast]=v.split('/');return {territory,type,coast:coast||null};}),disbands} as ChallengeAction;
  }
  const complete=a?.board.phase!=='ORDERS'||(!!game.legal&&chosenOrders.length===own.filter(u=>!u.mustRetreat).length);
  return <main className="challenge-shell">
    <header className="challenge-header"><div><p className="eyebrow">DIPLOMACY · SCENARIO LAB</p><h1>{card?.title??'Diplomacy challenges'}</h1><p>Small objectives. Seven powers. Every order matters.</p></div>
      <nav aria-label="Project links"><a href="/legal.html">Credits & licenses</a><a href="https://github.com/CameronDickie/diplomacy-ai" target="_blank" rel="noreferrer">Source code</a></nav></header>
    {game.error&&<div className="challenge-alert" role="alert">{game.error}<button onClick={game.clearError}>Dismiss</button>{!game.loaded&&<button onClick={()=>window.location.reload()}>Retry</button>}</div>}
    {!game.loaded&&!game.error&&<p>Loading the challenge…</p>}
    <div className="challenge-layout">
      <aside className="challenge-brief">
        <span className="challenge-badge">Development pilot · {replay?(replay.reference?'Reference replay':'Your replay'):'Offline practice'}</span>
        <h2>Your mission</h2><p>{card?.objectiveText}</p>
        <p>Own the supply center after a settled Fall turn, no later than Fall {card?.deadlineYear}. Moving there in Spring is not enough.</p>
        <div className="challenge-achievement"><strong>Early capture</strong><span>Complete by Fall {card?.earlyAchievementYear}.</span></div>
        <p>{card?.opponentLabel}. No paid model is used in this practice mode.</p>
        {!a||a.lifecycle!=='ACTIVE'?<button className="primary" disabled={!game.auth.authenticated||game.busy||!card} onClick={()=>card&&void game.start(card)}>Start practice</button>:<>
          <div className="challenge-phase">{a.board.year} {a.board.season} · {a.board.phase}</div>
          <p role="status">{a.execution==='ACCEPTING'?'Your move':a.execution==='RECOVERING'?'Your orders are saved. Processing needs recovery.':'Your orders are saved. Resolving this phase…'}</p>
          {a.execution==='RECOVERING'&&<button onClick={()=>void game.recover()} disabled={game.busy}>Recover saved phase</button>}
          {clock>=a.idleWarnAt&&<div className="challenge-alert">Your attempt expires after inactivity. <button onClick={()=>void game.activity(true)}>I’m still here</button></div>}
          {confirmAbandon?<div><p>End this attempt? Its saved result will remain available.</p><button onClick={()=>void game.abandon()} disabled={game.busy}>End attempt</button><button onClick={()=>setConfirmAbandon(false)}>Keep playing</button></div>:<button className="subtle" onClick={()=>setConfirmAbandon(true)}>Abandon attempt</button>}
        </>}
        {!game.auth.authenticated&&<p>Sign in with Google or GitHub to save your attempt. The reference replay needs no account.</p>}
        {a&&a.lifecycle!=='ACTIVE'&&<Outcome attempt={a}/>}
        <button onClick={()=>game.demo&&setReplay({reports:game.demo.reports,index:0,after:false,reference:true})} disabled={!game.demo||replay?.reference}>Watch reference replay</button>
        {card&&<Guide card={card} limits={game.limits} open={(!a||a.lifecycle!=='ACTIVE')&&!replay&&window.matchMedia('(min-width:651px)').matches}/>}
        {game.history.length>0&&<section><h2>Your attempts</h2>{game.history.map(item=><button className="attempt-history" key={item.id} onClick={()=>void game.resume(item.id)} disabled={game.busy}>{item.challenge.title}<small>{item.lifecycle} · {item.board.year} {item.board.season}</small></button>)}</section>}
      </aside>
      <section className="challenge-board" aria-label="Challenge board">
        <a className="map-attribution" href="/legal.html">Map: Godip contributors · GPL-3.0</a>
        <MapGraph gameState={mapState} selectedTerritory={replay?null:selected} selectedUnit={replay?null:selectedUnit}
          validTargets={selectedUnit?options.filter(o=>o.unitTerritory===selectedUnit.territory&&o.order.type==='MOVE').map(o=>o.order.targetTerritory!):[]}
          pendingOrders={report?.phase==='ORDERS'?report.resolvedOrders:replay?[]:chosenOrders}
          onSelectTerritory={territory=>{if(!replay&&own.some(u=>u.territory===territory)){setSelected(territory);activity();}}} onClearSelection={()=>setSelected(null)}/>
        {replay&&report&&<div className="challenge-replay" aria-label="Replay controls"><strong>{replay.reference?'Reference replay':'Your attempt'} · {report.year} {report.season} {report.phase.toLowerCase()} · {replay.after?'Result':'Before'}</strong>
          <button disabled={replay.index===0&&!replay.after} onClick={()=>setReplay(r=>r&&({...r,...(r.after?{after:false}:{index:r.index-1,after:true})}))}>Previous</button>
          <button disabled={replay.index===replay.reports.length-1&&replay.after} onClick={()=>setReplay(r=>r&&({...r,...(!r.after?{after:true}:{index:r.index+1,after:false})}))}>Next</button>
          <button onClick={()=>setReplay(null)}>{a?.lifecycle==='ACTIVE'?'Return to your attempt':'Return to board'}</button></div>}
      </section>
      <aside className="challenge-orders"><h2>{replay?'Replay':`${card?.humanPower??''} orders`}</h2>
        {replay?<><p>{replay.reference?'A recorded example run of this scenario, the same for every visitor. It is not your game and uses no AI model.':'Saved phases from your own attempt. Only you can see them.'}</p>
          <p>Recorded orders and resolved positions. A legal order can still fail when another power contests it.</p>
          {a?.lifecycle==='ACTIVE'&&<p role="status">Your attempt is untouched while you watch: its board and any orders you have chosen are waiting where you left them.</p>}</>:!a?<p>Start a practice attempt to enter orders. Select a unit on the map or use its menu here.</p>:<>
          {a.lifecycle==='ACTIVE'&&<>
          <p>Choose from rules-engine legal actions. Legal means allowed, not guaranteed to succeed.</p>
          {a.acceptedAction&&a.execution!=='ACCEPTING'&&<div><p>Your submission is locked while this phase resolves.</p>{a.acceptedAction.phase==='ORDERS'&&<ul>{a.acceptedAction.orderIds.map(id=><li key={id}>{id.split('|').join(' · ')}</li>)}</ul>}</div>}
          {a.board.phase==='ORDERS'&&own.filter(u=>!u.mustRetreat).map(u=><label key={u.id} className={selected===u.territory?'selected-order':''}>
            <button className="unit-selector" onClick={()=>{setSelected(u.territory);activity();}}>{u.type} · {territoryName(u.territory)}</button>
            <select aria-label={`Order for ${u.territory}`} disabled={!editable||!game.legal} value={choices[u.id]??defaultOrder(u)} onChange={e=>{setChoices(v=>({...v,[u.id]:e.target.value}));activity();}}>
              {!game.legal&&<option value="">{a.execution==='ACCEPTING'?'Loading legal choices…':'Orders saved'}</option>}
              {options.filter(o=>o.unitTerritory===u.territory).map(o=><option key={o.id} value={o.id}>{o.description}</option>)}
            </select></label>)}
          {a.board.phase==='RETREATS'&&own.filter(u=>u.mustRetreat).map(u=><label key={u.id}>Retreat from {u.territory}<select disabled={!editable} value={retreats[u.id]??''} onChange={e=>{setRetreats(v=>({...v,[u.id]:e.target.value}));activity();}}><option value="">Disband</option>
            {u.retreatOptions.flatMap(t=>u.retreatCoasts[t]?.length?u.retreatCoasts[t]!.map(c=>`${t}/${c}`):[t]).map(d=><option key={d} value={d}>{d}</option>)}</select></label>)}
          {a.board.phase==='BUILDS'&&<><p>{buildDelta>=0?`Up to ${buildDelta} builds. Unused builds are waived.`:`Choose ${-buildDelta} units to disband.`}</p>
            {buildDelta>0?homes.map(h=><label key={h.id}>Build in {h.name}<select disabled={!editable} value={builds[h.id]??''} onChange={e=>{setBuilds(v=>({...v,[h.id]:e.target.value}));activity();}}><option value="">No build</option><option value="ARMY">Army</option>{h.type!=='LAND'&&(h.coasts.length?h.coasts.map(c=><option key={c} value={`FLEET/${c}`}>Fleet · {c} coast</option>):<option value="FLEET">Fleet</option>)}</select></label>):own.map(u=><label className="disband-choice" key={u.id}><input type="checkbox" disabled={!editable||buildDelta===0} checked={disbands.includes(u.id)} onChange={e=>{setDisbands(v=>e.target.checked?[...v,u.id]:v.filter(id=>id!==u.id));activity();}}/>{u.type} {u.territory}</label>)}</>}
          {own.length===0&&<p>No units need your orders this phase. Continue to see the next result.</p>}
          <button className="primary" disabled={!editable||!complete} onClick={()=>{const action=submission();if(action)void game.submit(action);}}>{game.busy?'Saving…':a.execution==='ACCEPTING'?'Submit orders':'Orders saved'}</button>
          </>}
          {a.lifecycle!=='ACTIVE'&&<p>This attempt has ended. Review its saved phases below.</p>}
          {game.reports.length>0&&<section><h2>Phase reports</h2>{game.reports.map((r,i)=><button className="attempt-history" key={r.id} onClick={()=>setReplay({reports:game.reports,index:i,after:true,reference:false})}>{r.year} {r.season} · {r.phase}</button>)}</section>}
        </>}
      </aside>
    </div>
  </main>;
}
function Outcome({attempt}:{attempt:ChallengeAttemptView}){
  const score=attempt.score;
  return <section className="challenge-outcome" aria-label="Attempt result"><h2>{score?.outcome==='SUCCESS'?'Objective complete':attempt.lifecycle==='EXPIRED'?'Attempt expired':attempt.lifecycle==='ABANDONED'?'Attempt abandoned':score?.outcome==='FAILURE'?'Challenge finished':'Attempt stopped'}</h2>
    {score?.completedYear&&<p>Fall {score.completedYear}</p>}{score?.achievementIds.includes('EARLY_CAPTURE')&&<strong>Achievement: Early capture</strong>}
    <p>This was offline practice. Your phase reports are saved below.</p></section>;
}
function Guide({card,limits,open}:{card:ChallengeCard;limits:ChallengeLimits|null;open:boolean}){
  const power=card.humanPower[0]+card.humanPower.slice(1).toLowerCase(),n=(count:number,noun:string)=>`${count} ${noun}${count===1?'':'s'}`;
  // The parent re-renders every second; keep the reader's own toggle until play starts or ends.
  const [shown,setShown]=useState(open);
  useEffect(()=>setShown(open),[open]);
  return <details className="challenge-guide" open={shown} onToggle={e=>setShown(e.currentTarget.open)}><summary>How this challenge works</summary>
    <h3>Goal and ending</h3>
    <p>You play {power}. You succeed the moment {power} owns the target supply center once a Fall turn has fully settled. If Fall {card.deadlineYear} settles without it, the challenge ends unsuccessfully.</p>
    <p>Supply centers change hands only after Fall. “Settled” means any retreats from that Fall have been resolved first, so a unit forced out of the center does not count.</p>
    <p>Finish by Fall {card.earlyAchievementYear} to also earn the Early capture achievement.</p>
    <h3>Legal is not successful</h3>
    <p>The order menus list only moves the rules engine allows. Whether an order succeeds depends on what every other power does in the same turn: a legal move can still bounce or be cut.</p>
    <h3>Opponents</h3>
    <p>Practice opponents hold every turn and use no AI model. Opponents played by GPT-6 Luna, paid for by the site owner, are not available yet.</p>
    <p>When sponsored play is offered it will run on a fixed budget. If that budget runs out or play is paused, you will be told and no new sponsored attempts will start; the replay and your saved results stay available. Luna opponents are never silently swapped for practice opponents.</p>
    {limits&&<><h3>Limits</h3>
    <p>{n(limits.maxActivePerAccount,'active attempt')} per account and {n(limits.dailyStartLimit,'start')} per account per UTC day; an abandoned start still counts. The site runs at most {n(limits.maxActiveAttempts,'attempt')} at once. There is no queue: if it is full, try again later.</p>
    <p>You are warned after {limits.idleWarnMinutes} minutes without an action and the attempt expires at {limits.idleExpireMinutes}. Only your own actions count; leaving the page open does not. Expired and finished attempts stay readable.</p></>}
    <h3>Privacy</h3>
    <p>Signing in stores your Google or GitHub account identifier and display name, and accounts are never linked by email. Your attempts are visible only to you. The site operator can view attempt boards, settled reports and capacity to run the service.</p>
    <p className="muted">Development pilot: an AI-generated test scenario. A public daily schedule has not been announced.</p>
  </details>;
}
