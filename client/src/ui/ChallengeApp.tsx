import { useEffect,useMemo,useState } from 'react';
import { ADJACENCY, TERRITORIES, type ChallengeAction,type ChallengeAttemptView,type ChallengeCard,type ChallengeLimits,type PublicPhaseReport,type Unit } from '@diplomacy/shared';
import { useChallenge } from '../hooks/useChallenge.js';
import { MapGraph } from './MapGraph.js';
import { OperatorPanel } from './OperatorPanel.js';
import { PlaytestPanel } from './PlaytestPanel.js';
import { adjacentTerritories,territoryName } from '../lib/game.js';

export function ChallengeApp(){
  const game=useChallenge(),a=game.attempt,card=a?.challenge??game.cards[0];
  const [selected,setSelected]=useState<string|null>(null),[choices,setChoices]=useState<Record<string,string>>({});
  const [retreats,setRetreats]=useState<Record<string,string>>({}),[builds,setBuilds]=useState<Record<string,string>>({}),[disbands,setDisbands]=useState<string[]>([]);
  const [replay,setReplay]=useState<{reports:PublicPhaseReport[];index:number;after:boolean;reference:boolean;exhibition?:string}|null>(null),[confirmAbandon,setConfirmAbandon]=useState(false),[confirmDelete,setConfirmDelete]=useState(false);
  const [clock,setClock]=useState(Date.now()),[operatorView,setOperatorView]=useState(false);
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{setChoices({});setRetreats({});setBuilds({});setDisbands([]);setSelected(null);setReplay(null);setConfirmAbandon(false);},[a?.id,a?.phaseId,game.auth.user?.id]);
  useEffect(()=>setConfirmDelete(false),[game.auth.user?.id]);
  const board=a?.board??card?.board;
  const report=replay?.reports[replay.index];
  const shown=report?(replay!.after?report.after:report.before):board;
  const mapState=useMemo(()=>shown?{units:shown.units,territories:Object.fromEntries(TERRITORIES.map(t=>[t.id,{id:t.id,isSupplyCenter:t.isSupplyCenter,owner:shown.territoryOwners[t.id]}]))}:null,[shown]);
  const own=board?.units.filter(u=>u.power===card?.humanPower)??[];
  const selectedUnit=own.find(u=>u.territory===selected&&!u.mustRetreat)??null;
  const editable=Boolean(a&&a.lifecycle==='ACTIVE'&&a.execution==='ACCEPTING'&&!game.busy&&!replay);
  // The rules engine lists a move to a place only a convoy can reach twice, as a plain move and as "via convoy".
  // They are the same order; showing both made convoys look inconsistent, so only the explicit one is offered.
  const options=useMemo(()=>{
    const all=game.legal?.options??[],explicit=new Set(all.filter(o=>o.id.split('|')[1]==='MOVE_VIA_CONVOY').map(o=>`${o.unitTerritory}>${o.id.split('|')[2]}`));
    return all.filter(o=>{const [,type,target]=o.id.split('|'),unit=board?.units.find(u=>u.territory===o.unitTerritory&&u.power===card?.humanPower);
      return !(type==='MOVE'&&explicit.has(`${o.unitTerritory}>${target}`)&&unit&&!adjacentTerritories(unit).includes(target.split('/')[0] as never));});
  },[game.legal,board,card?.humanPower]);
  const defaultOrder=(u:Unit)=>options.find(o=>o.unitTerritory===u.territory&&o.order.type==='HOLD')?.id??'';
  const chosenOrders=own.filter(u=>!u.mustRetreat).map(u=>options.find(o=>o.id===(choices[u.id]??defaultOrder(u)))?.order).filter(o=>o!==undefined);
  const buildDelta=board&&card?TERRITORIES.filter(t=>t.isSupplyCenter&&board.territoryOwners[t.id]===card.humanPower).length-own.length:0;
  const homes=TERRITORIES.filter(t=>t.homePower===card?.humanPower&&board?.territoryOwners[t.id]===card?.humanPower&&!board?.units.some(u=>u.territory===t.id));
  // What the player actually submitted last turn and how each order resolved, from the public report.
  const lastOrders=useMemo(()=>{const r=[...game.reports].reverse().find(x=>x.phase==='ORDERS');return r&&r.phase==='ORDERS'&&card?{when:`${title(r.season)} ${r.year}`,orders:r.resolvedOrders.filter(o=>o.power===card.humanPower)}:null;},[game.reports,card?.humanPower]);
  // A convoy needs a fleet at sea beside the army; until then the rules engine offers none, which is easy to mistake for a fault.
  const convoyHint=Boolean(board?.phase==='ORDERS'&&game.legal&&own.some(u=>u.type==='ARMY')&&own.some(u=>u.type==='FLEET')&&!options.some(o=>o.order.type==='CONVOY'));
  // An army only crosses by convoy if a fleet is ordered to carry it. When exactly one of the player's fleets can,
  // choosing the army's convoy move sets that fleet's order too; with several possible fleets the warning below asks.
  function choose(u:Unit,id:string){
    setChoices(v=>{
      const next={...v,[u.id]:id},[,type,target]=id.split('|');
      if(type==='MOVE_VIA_CONVOY'){
        const carriers=options.filter(o=>o.id.split('|')[1]==='CONVOY'&&o.id.split('|')[2]===u.territory&&o.id.split('|')[3]===target);
        // Several fleets may be able to take part in some route. The one that can do it alone touches both
        // the army's coast and the destination; if exactly one fleet qualifies, it is the obvious carrier.
        const touches=(sea:string,land:string)=>{const f=ADJACENCY[sea as keyof typeof ADJACENCY]?.fleet;return (Array.isArray(f)?f:Object.values(f??{}).flat()).includes(land.split('/')[0] as never);};
        const all=[...new Set(carriers.map(o=>o.unitTerritory))],direct=all.filter(sea=>touches(sea,u.territory)&&touches(sea,target));
        const pick=direct.length===1?direct[0]:all.length===1?all[0]:null,fleet=pick?own.find(x=>x.territory===pick):undefined;
        if(fleet)next[fleet.id]=carriers.find(o=>o.unitTerritory===pick)!.id;
      }
      return next;
    });
  }
  const chosenIds=own.filter(u=>!u.mustRetreat).map(u=>choices[u.id]??defaultOrder(u)).filter(Boolean).map(id=>id.split('|'));
  const convoyWarnings=board?.phase==='ORDERS'?[
    ...chosenIds.filter(([unit,type,target])=>type==='MOVE_VIA_CONVOY'&&!chosenIds.some(([,t,army,to])=>t==='CONVOY'&&army===unit&&to===target))
      .map(([unit,,target])=>`${territoryName(unit as Parameters<typeof territoryName>[0])} is ordered to ${territoryName(target.split('/')[0] as Parameters<typeof territoryName>[0])} by convoy, but none of your fleets is ordered to convoy it there. Set a fleet to "convoys ${unit} to ${target}", or the move will fail.`),
    ...chosenIds.filter(([,type,army,to])=>type==='CONVOY'&&own.some(u=>u.territory===army)&&!chosenIds.some(([unit,t,target])=>unit===army&&t==='MOVE_VIA_CONVOY'&&target===to))
      .map(([fleet,,army,to])=>`${territoryName(fleet.split('/')[0] as Parameters<typeof territoryName>[0])} is ordered to convoy ${army} to ${to}, but that army is not ordered to move there by convoy.`),
  ]:[];
  // Some phases ask nothing of the player (another power's retreat, a winter with no change). They still need
  // a click to move on, so the sidebar says what the phase is and why there is nothing to choose.
  const nothingToDo=Boolean(board&&(board.phase==='ORDERS'?own.filter(u=>!u.mustRetreat).length===0:board.phase==='RETREATS'?!own.some(u=>u.mustRetreat):buildDelta===0));
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
      <nav aria-label="Project links">{game.auth.operator&&<button onClick={()=>setOperatorView(v=>!v)}>{operatorView?'Back to challenge':'Operator'}</button>}<a href="/legal.html">Credits & licenses</a><a href="https://github.com/CameronDickie/diplomacy-ai" target="_blank" rel="noreferrer">Source code</a></nav></header>
    {game.error&&<div className="challenge-alert" role="alert">{game.error}<button onClick={game.clearError}>Dismiss</button>{!game.loaded&&<button onClick={()=>window.location.reload()}>Retry</button>}</div>}
    {!game.loaded&&!game.error&&<p>Loading the challenge…</p>}
    {operatorView&&game.auth.operator?<OperatorPanel/>:<div className="challenge-layout">
      <aside className="challenge-brief">
        <span className="challenge-badge">Development pilot · {replay?(replay.exhibition?'Bot exhibition game':replay.reference?'Reference replay':'Your replay'):a?.mode==='SPONSORED'?(game.sponsoredMock?'Mock model opponents':game.sponsoredLive?'Live playtest · real model calls':'Sponsored · GPT-6 Luna opponents'):a?.mode==='BOT'?'Practice bot':'Offline practice'}</span>
        <h2>Your mission</h2>{card&&<p>As {title(card.humanPower)}, own {territoryName(card.targetTerritory)} after Fall {card.deadlineYear} or sooner.</p>}
        <p>Own the supply center after a settled Fall turn, no later than Fall {card?.deadlineYear}. Moving there in Spring is not enough.</p>
        {card&&board&&<Progress card={card} board={board} live={a?.lifecycle==='ACTIVE'}/>}
        <div className="challenge-achievement"><strong>Early capture</strong><span>Complete by Fall {card?.earlyAchievementYear}.</span></div>
        <p>{a&&a.mode!=='PRACTICE'?`${a.challenge.opponentLabel}.`:a?`${a.challenge.opponentLabel}. No paid model is used in this practice mode.`:'Practise for free against scripted opponents, or against opponents that simply hold.'}</p>
        {game.rotation&&(!a||a.lifecycle!=='ACTIVE')&&<p className="muted">Development rotation: challenge {game.rotation.index+1} of {game.rotation.size} for {game.rotation.day} UTC. {game.cards[0]&&a&&a.challenge.id!==game.cards[0].id?`The current challenge is now ${game.cards[0].title}. `:''}The next one starts in {untilChange(game.rotation.nextChangeAt,clock)}.</p>}
        {!a||a.lifecycle!=='ACTIVE'?<><button className="primary" disabled={!game.auth.authenticated||game.busy||!game.cards[0]} onClick={()=>game.cards[0]&&void game.start(game.cards[0],'BOT')}>{a&&game.cards[0]&&a.challenge.id!==game.cards[0].id?`Start ${game.cards[0].title}`:'Play against the practice bot'}</button>
          <button disabled={!game.auth.authenticated||game.busy||!game.cards[0]} onClick={()=>game.cards[0]&&void game.start(game.cards[0])}>Start practice</button>
          {game.sponsoredPlay==='OPEN'&&<button className="primary" disabled={!game.auth.authenticated||game.busy||!game.cards[0]} onClick={()=>game.cards[0]&&void game.start(game.cards[0],'SPONSORED')}>{game.sponsoredMock?'Play against mock model opponents':game.sponsoredLive?'Play a live playtest (real model calls)':'Play against Luna opponents'}</button>}</>:<>
          <div className="challenge-phase">{a.board.year} {a.board.season} · {a.board.phase}</div>
          <p role="status">{a.execution==='ACCEPTING'?'Your move':a.execution!=='RECOVERING'?(a.mode==='SPONSORED'?'Your orders are saved. The opponents are deciding…':'Your orders are saved. Resolving this phase…')
            :a.notice==='SPONSORED_PAUSED'?'Your orders are saved. Sponsored play is paused, so the opponents cannot move yet. Nothing is lost: continue when it resumes, or end the attempt.'
            :a.notice==='ATTEMPT_BUDGET'?'Your orders are saved, but this attempt has used its sponsored budget and cannot continue. You can end it and review what happened.'
            :a.notice==='SPONSORED_RETRY'?'Your orders are saved. An opponent did not answer in time. Try again to continue.'
            :'Your orders are saved. Processing needs recovery.'}</p>
          {a.execution==='RECOVERING'&&a.notice!=='ATTEMPT_BUDGET'&&<button onClick={()=>void game.recover()} disabled={game.busy||a.notice==='SPONSORED_PAUSED'&&game.sponsoredPlay==='PAUSED'}>{a.notice==='SPONSORED_RETRY'?'Try again':a.notice==='SPONSORED_PAUSED'?'Continue when resumed':'Recover saved phase'}</button>}
          {clock>=a.idleWarnAt&&<div className="challenge-alert">Your attempt expires after inactivity. <button onClick={()=>void game.activity(true)}>I’m still here</button></div>}
          {confirmAbandon?<div><p>End this attempt? Its saved result will remain available.</p><button onClick={()=>void game.abandon()} disabled={game.busy}>End attempt</button><button onClick={()=>setConfirmAbandon(false)}>Keep playing</button></div>:<button className="subtle" onClick={()=>setConfirmAbandon(true)}>Abandon attempt</button>}
        </>}
        {game.capacity==='FULL'&&(!a||a.lifecycle!=='ACTIVE')&&<p role="status">All {game.limits?.maxActiveAttempts} game slots are in use right now. There is no queue: try again in a few minutes, or watch the reference replay meanwhile.</p>}
        {game.sponsoredPlay==='PAUSED'&&<div className="challenge-alert" role="status">Sponsored play against GPT-6 Luna is paused. Practice and the replay still work.
          {game.auth.authenticated&&<button disabled={game.busy||game.creditRequested} onClick={()=>void game.requestCredit()}>{game.creditRequested?'Request sent to the owner':'Ask the owner to resume it'}</button>}</div>}
        {!game.auth.authenticated&&<p>Sign in with Google or GitHub to save your attempt. The reference replay needs no account.</p>}
        {a&&a.lifecycle!=='ACTIVE'&&<Outcome attempt={a} limits={game.limits}/>}
        <button onClick={()=>game.demo&&setReplay({reports:game.demo.reports,index:0,after:false,reference:true})} disabled={!game.demo||replay?.reference}>Watch reference replay</button>
        {card&&<Guide card={card} limits={game.limits} open={(!a||a.lifecycle!=='ACTIVE')&&!replay&&window.matchMedia('(min-width:651px)').matches}/>}
        {game.history.length>0&&<section><h2>Your attempts</h2>{game.history.map(item=><button className="attempt-history" key={item.id} onClick={()=>void game.resume(item.id)} disabled={game.busy}>{item.challenge.title}<small>{item.lifecycle} · {item.board.year} {item.board.season}</small></button>)}
          {game.older&&<button className="subtle" onClick={()=>void game.loadOlder()} disabled={game.busy}>Show older attempts</button>}</section>}
        {game.exhibitions.length>0&&<section><h2>Bot exhibition games</h2><p className="muted">All seven powers played by the practice bot. Watch one to see a longer game unfold.</p>
          {game.exhibitions.map(e=><button className="attempt-history" key={e.id} disabled={e.phases===0} onClick={()=>void game.loadExhibition(e.id).then(r=>{if(r.reports.length)setReplay({reports:r.reports,index:0,after:false,reference:true,exhibition:e.title});}).catch(()=>{})}>
            {e.title}<small>{e.state==='RUNNING'?'In progress':e.state==='PAUSED'?'Paused':e.state==='STALLED'?'Drawn':e.state==='COMPLETED'?'Finished':e.state==='CANCELLED'?'Cancelled':'Stopped'} · {e.phases} phases · {e.year} {e.season}</small></button>)}</section>}
        {game.auth.authenticated&&<section className="challenge-account"><h2>Your account</h2>
          {confirmDelete?<><p>Delete your account? This signs you out and permanently removes your sign-in identity, any attempt in progress and all saved attempts. Today’s used starts still count if you sign in again.</p>
            <button onClick={()=>void game.deleteAccount()} disabled={game.busy}>Delete account and data</button><button onClick={()=>setConfirmDelete(false)}>Keep my account</button></>
            :<button className="subtle" onClick={()=>setConfirmDelete(true)}>Delete account and data…</button>}</section>}
      </aside>
      <section className="challenge-board" aria-label="Challenge board">
        <a className="map-attribution" href="/legal.html">Map: Godip contributors · GPL-3.0</a>
        <MapGraph gameState={mapState} selectedTerritory={replay?null:selected} selectedUnit={replay?null:selectedUnit}
          validTargets={selectedUnit?options.filter(o=>o.unitTerritory===selectedUnit.territory&&o.order.type==='MOVE').map(o=>o.order.targetTerritory!):[]}
          pendingOrders={report?.phase==='ORDERS'?report.resolvedOrders:replay?[]:chosenOrders}
          onSelectTerritory={territory=>{if(!replay&&own.some(u=>u.territory===territory)){setSelected(territory);activity();}}} onClearSelection={()=>setSelected(null)}/>
        {replay&&report&&<div className="challenge-replay" aria-label="Replay controls"><strong>{replay.exhibition?`Exhibition · ${replay.exhibition}`:replay.reference?'Reference replay':'Your attempt'} · {report.year} {report.season} {report.phase.toLowerCase()} · {replay.after?'Result':'Before'}</strong>
          <button disabled={replay.index===0&&!replay.after} onClick={()=>setReplay(r=>r&&({...r,...(r.after?{after:false}:{index:r.index-1,after:true})}))}>Previous</button>
          <button disabled={replay.index===replay.reports.length-1&&replay.after} onClick={()=>setReplay(r=>r&&({...r,...(!r.after?{after:true}:{index:r.index+1,after:false})}))}>Next</button>
          <button onClick={()=>setReplay(null)}>{a?.lifecycle==='ACTIVE'?'Return to your attempt':'Return to board'}</button></div>}
      </section>
      <aside className="challenge-orders"><h2>{replay?'Replay':`${card?.humanPower??''} orders`}</h2>
        {replay?<><p>{replay.exhibition?'A game played entirely by the free practice bot, one bot for each of the seven powers. Nobody is playing it and it uses no AI model.':replay.reference?'A recorded example run of this scenario, the same for every visitor. It is not your game and uses no AI model.':'Saved phases from your own attempt. Only you can see them.'}</p>
          <p>Recorded orders and resolved positions. A legal order can still fail when another power contests it.</p>
          {a?.lifecycle==='ACTIVE'&&<p role="status">Your attempt is untouched while you watch: its board and any orders you have chosen are waiting where you left them.</p>}</>:!a?<p>Start a practice attempt to enter orders. Select a unit on the map or use its menu here.</p>:<>
          {a.lifecycle==='ACTIVE'&&<>
          <p className="challenge-phase-note"><strong>{phaseTitle(a.board)}</strong><br/>{nothingToDo
            ?(a.board.phase==='RETREATS'?'Another power has a dislodged unit that must retreat or disband. None of yours is affected, so there is nothing for you to decide.'
              :a.board.phase==='BUILDS'?'Other powers are building or disbanding to match their supply centers. Your count already matches, so there is nothing for you to decide.'
              :'You have no units to order this turn.')
            :a.board.phase==='ORDERS'?'Give each of your units one order. These are the rules engine’s legal orders; legal means allowed, not guaranteed to succeed.'
            :a.board.phase==='RETREATS'?'One of your units was dislodged. Choose where it retreats, or disband it.'
            :'Match your units to your supply centers: build where you have gained, disband where you have lost.'}</p>
          {lastOrders&&lastOrders.orders.length>0&&<div className="challenge-last-orders"><strong>Your orders, {lastOrders.when}</strong>
            <ul>{lastOrders.orders.map(o=><li key={o.id} className={o.resolution==='SUCCEEDS'?undefined:'failed'}>{describeOrder(o.id)} · {o.resolution==='SUCCEEDS'?'succeeded':title(o.resolution)}</li>)}</ul></div>}
          {convoyHint&&editable&&<p className="muted">No convoy is possible this turn. A convoy needs one of your fleets in a sea space next to the army; move a fleet out to sea first, and the convoy orders will appear here next turn.</p>}
          {a.acceptedAction&&a.execution!=='ACCEPTING'&&<div><p>Your submission is locked while this phase resolves.</p>{a.acceptedAction.phase==='ORDERS'&&<ul>{a.acceptedAction.orderIds.map(id=><li key={id}>{describeOrder(id)}</li>)}</ul>}</div>}
          {a.board.phase==='ORDERS'&&own.filter(u=>!u.mustRetreat).map(u=><label key={u.id} className={selected===u.territory?'selected-order':''}>
            <button className="unit-selector" onClick={()=>{setSelected(u.territory);activity();}}>{u.type} · {territoryName(u.territory)}</button>
            <select aria-label={`Order for ${u.territory}`} disabled={!editable||!game.legal} value={choices[u.id]??defaultOrder(u)} onChange={e=>{choose(u,e.target.value);activity();}}>
              {!game.legal&&<option value="">{a.execution==='ACCEPTING'?'Loading legal choices…':'Orders saved'}</option>}
              {options.filter(o=>o.unitTerritory===u.territory).map(o=><option key={o.id} value={o.id}>{o.description}</option>)}
            </select></label>)}
          {a.board.phase==='RETREATS'&&own.filter(u=>u.mustRetreat).map(u=><label key={u.id}>Retreat from {u.territory}<select disabled={!editable} value={retreats[u.id]??''} onChange={e=>{setRetreats(v=>({...v,[u.id]:e.target.value}));activity();}}><option value="">Disband</option>
            {u.retreatOptions.flatMap(t=>u.retreatCoasts[t]?.length?u.retreatCoasts[t]!.map(c=>`${t}/${c}`):[t]).map(d=><option key={d} value={d}>{d}</option>)}</select></label>)}
          {a.board.phase==='BUILDS'&&<><p>{buildDelta>=0?`Up to ${buildDelta} builds. Unused builds are waived.`:`Choose ${-buildDelta} units to disband.`}</p>
            {buildDelta>0?homes.map(h=><label key={h.id}>Build in {h.name}<select disabled={!editable} value={builds[h.id]??''} onChange={e=>{setBuilds(v=>({...v,[h.id]:e.target.value}));activity();}}><option value="">No build</option><option value="ARMY">Army</option>{h.type!=='LAND'&&(h.coasts.length?h.coasts.map(c=><option key={c} value={`FLEET/${c}`}>Fleet · {c} coast</option>):<option value="FLEET">Fleet</option>)}</select></label>):own.map(u=><label className="disband-choice" key={u.id}><input type="checkbox" disabled={!editable||buildDelta===0} checked={disbands.includes(u.id)} onChange={e=>{setDisbands(v=>e.target.checked?[...v,u.id]:v.filter(id=>id!==u.id));activity();}}/>{u.type} {u.territory}</label>)}</>}
          {editable&&convoyWarnings.map(w=><div className="challenge-alert" role="status" key={w}>{w}</div>)}
          <button className="primary" disabled={!editable||!complete} onClick={()=>{const action=submission();if(action)void game.submit(action);}}>{game.busy?'Saving…':a.execution!=='ACCEPTING'?'Orders saved':nothingToDo?'Continue':a.board.phase==='RETREATS'?'Submit retreats':a.board.phase==='BUILDS'?'Submit adjustments':'Submit orders'}</button>
          </>}
          {a.lifecycle!=='ACTIVE'&&<p>This attempt has ended. Review its saved phases below.</p>}
          {game.playtest&&a?.mode==='SPONSORED'&&<PlaytestPanel log={game.playtest}/>}
          {game.reports.length>0&&<section><h2>Phase reports</h2>{game.reports.map((r,i)=><button className="attempt-history" key={r.id} onClick={()=>setReplay({reports:game.reports,index:i,after:true,reference:false})}>{r.year} {r.season} · {r.phase}</button>)}</section>}
        </>}
      </aside>
    </div>}
  </main>;
}
const title=(power:string)=>power[0]+power.slice(1).toLowerCase();
function untilChange(at:number,now:number){const minutes=Math.max(0,Math.ceil((at-now)/60_000));return minutes>=60?`${Math.floor(minutes/60)}h ${minutes%60}m`:`${minutes}m`;}
/** Where the objective stands on the board being shown; ownership only moves after a settled Fall. */
function phaseTitle(board:{year:number;season:string;phase:string}):string {
  return board.phase==='ORDERS'?`${title(board.season)} ${board.year} · orders`:board.phase==='RETREATS'?`${title(board.season)} ${board.year} · retreats`:`Winter ${board.year} · builds and disbands`;
}
/** An order ID as a sentence: "LVP|MOVE|YOR" reads "Liverpool moves to Yorkshire". */
function describeOrder(id:string):string {
  const [unit,type,first,second]=id.split('|'),place=(t?:string)=>t?territoryName(t.split('/')[0] as Parameters<typeof territoryName>[0])+(t.includes('/')?` (${t.split('/')[1].toLowerCase()} coast)`:''):'';
  return type==='HOLD'?`${place(unit)} holds`:type==='MOVE'?`${place(unit)} moves to ${place(first)}`:type==='MOVE_VIA_CONVOY'?`${place(unit)} moves to ${place(first)} by convoy`
    :type==='SUPPORT_HOLD'?`${place(unit)} supports ${place(first)} holding`:type==='SUPPORT_MOVE'?`${place(unit)} supports ${place(first)} to ${place(second)}`
    :type==='CONVOY'?`${place(unit)} convoys ${place(first)} to ${place(second)}`:id.split('|').join(' · ');
}

function Progress({card,board,live}:{card:ChallengeCard;board:ChallengeCard['board'];live:boolean}){
  const owner=board.territoryOwners[card.targetTerritory]??null,there=board.units.find(u=>u.territory===card.targetTerritory);
  const falls=Math.max(0,card.deadlineYear-board.year+(board.season==='WINTER'?0:1));
  return <div className="challenge-progress" role="status"><strong>{territoryName(card.targetTerritory)}</strong>
    <span>{owner===card.humanPower?'Yours':owner?`Owned by ${title(owner)}`:'Unowned'}{there?` · ${there.power===card.humanPower?'your':`${title(there.power)}’s`} ${there.type.toLowerCase()} is there`:''}</span>
    {live&&<span>{falls===0?'The deadline has passed.':`${falls} Fall turn${falls===1?'':'s'} left, through Fall ${card.deadlineYear}`}</span>}</div>;
}
function Outcome({attempt,limits}:{attempt:ChallengeAttemptView;limits:ChallengeLimits|null}){
  const score=attempt.score;
  return <section className="challenge-outcome" aria-label="Attempt result"><h2>{score?.outcome==='SUCCESS'?'Objective complete':attempt.lifecycle==='EXPIRED'?'Attempt expired':attempt.lifecycle==='ABANDONED'?'Attempt abandoned':score?.outcome==='FAILURE'?'Challenge finished':'Attempt stopped'}</h2>
    {score?.completedYear&&<p>Fall {score.completedYear}</p>}{score?.achievementIds.includes('EARLY_CAPTURE')&&<strong>Achievement: Early capture</strong>}
    {attempt.lifecycle==='EXPIRED'&&<p>It closed after {limits?`${limits.idleExpireMinutes} minutes`:'a period'} without an action from you and cannot be resumed. You can start a new attempt if you have starts left today.</p>}
    {attempt.lifecycle==='STOPPED'&&<p>The site operator closed this attempt.</p>}
    <p>{attempt.mode==='SPONSORED'?'This was a sponsored attempt against Luna opponents.':attempt.mode==='BOT'?'This was practice against the scripted bot.':'This was offline practice.'} Your phase reports are saved{limits?` for ${limits.resultRetentionDays} days`:''}.</p></section>;
}
function Guide({card,limits,open}:{card:ChallengeCard;limits:ChallengeLimits|null;open:boolean}){
  const power=title(card.humanPower),n=(count:number,noun:string)=>`${count} ${noun}${count===1?'':'s'}`;
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
    <p>The practice bot is free: scripted opponents that head for supply centers and support each other, using no AI model. It plays the same way for the same attempt and position, and it is not a strong player. “Start practice” gives opponents that hold every turn, useful for learning the controls. Sponsored attempts are played against opponents decided by GPT-6 Luna, paid for by the site owner; they are offered only when a second start button appears.</p>
    <p>Sponsored play runs on a fixed budget. If that budget runs out or play is paused, you are told, no new sponsored attempts start, and an attempt in progress waits with your orders saved; the replay and your saved results stay available. Luna opponents are never silently swapped for practice opponents, and an attempt keeps the mode it started in.</p>
    {limits&&<><h3>Limits</h3>
    <p>{n(limits.maxActivePerAccount,'active attempt')} per account and {n(limits.dailyStartLimit,'start')} per account per UTC day; an abandoned start still counts. The site runs at most {n(limits.maxActiveAttempts,'attempt')} at once. There is no queue: if it is full, try again later.</p>
    <p>You are warned after {limits.idleWarnMinutes} minutes without an action and the attempt expires at {limits.idleExpireMinutes}. Only your own actions count; leaving the page open does not. Expired and finished attempts stay readable for {limits.resultRetentionDays} days, then are deleted.</p></>}
    <h3>Privacy</h3>
    <p>Signing in stores your Google or GitHub account identifier and display name, and accounts are never linked by email. Your attempts are visible only to you. The site operator can view attempt boards, settled reports and capacity to run the service.</p>
    <p>You can delete your account at any time under “Your account”. That removes your identity, sessions and attempts; anonymous usage and cost records with no link to you are kept for accounting.</p>
    <p className="muted">Development pilot: AI-generated test scenarios that rotate at midnight UTC so the rotation itself can be tested. An attempt keeps the challenge it started with. A public daily schedule has not been announced.</p>
  </details>;
}
