import type { DatabaseSync } from 'node:sqlite';
import { ALL_POWERS } from '@diplomacy/shared';
import { canonicalJson } from '../fixtures/BoardFixture.js';
import { providerOutcomes, type ProviderCallIntent, type ProviderCallRecord, type ProviderUsage } from '../providers/accounting.js';
import { StoreError, type StoreOperations } from './contracts.js';
import { paidState } from './operator.js';
import { parseAction } from '../attempts/actions.js';
import { FundingRepository, type Refusal } from './funding.js';

const invalid = (): never => { throw new StoreError('STORE_INVALID','Invalid provider accounting metadata.'); };
const conflict = (): never => { throw new StoreError('STORE_CONFLICT','Provider call already exists or changed; reconcile its durable record.'); };
const integer = (n:number,max=Number.MAX_SAFE_INTEGER) => { if(!Number.isSafeInteger(n)||n<0||n>max)invalid(); };
const identifier = (s:string) => { if(typeof s!=='string'||!/^[A-Za-z0-9:_-]{1,100}$/.test(s))invalid(); };
const fields = (v:object,keys:string[]) => { if(!v||typeof v!=='object'||Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!(k in v)))invalid(); };
function intent(v:ProviderCallIntent):ProviderCallIntent {
  fields(v,['id','fence','power','provider','model','role','pricingVersion','requestHash','maxCostNanousd']);
  fields(v.fence,['operationId','attemptId','phaseId','revision']);
  identifier(v.id); identifier(v.fence.operationId); identifier(v.fence.attemptId);
  if(typeof v.fence.phaseId!=='string'||v.fence.phaseId.length>200)invalid();
  integer(v.fence.revision);identifier(v.pricingVersion);integer(v.maxCostNanousd,15_000_000_000);
  if(!v.maxCostNanousd||!(v.provider==='OPENAI'&&v.model==='gpt-6-luna'||v.provider==='ANTHROPIC'&&v.model==='claude-haiku-5-5')||!['ORDERS','RETREATS','BUILDS','CHAT'].includes(v.role)||!ALL_POWERS.includes(v.power)||!/^[a-f0-9]{64}$/.test(v.requestHash))invalid();
  return v;
}
function usage(v:ProviderUsage):ProviderUsage {
  fields(v,['inputTokens','cachedInputTokens','cacheWriteTokens','outputTokens','reasoningTokens','costNanousd']);
  for(const [key,value] of Object.entries(v))integer(value,key==='costNanousd'?Number.MAX_SAFE_INTEGER:2_000_000);
  if(v.cachedInputTokens+v.cacheWriteTokens>v.inputTokens||v.reasoningTokens>v.outputTokens)invalid();
  return v;
}

/** Methods run inside the worker transaction. These records are NOT funding authorization. */
export class ProviderCallRepository {
  constructor(private db:DatabaseSync) {}
  get(id:string):ProviderCallRecord|null {
    identifier(id);
    const r=this.db.prepare('SELECT * FROM provider_calls WHERE id=?').get(id);
    return r?{...JSON.parse(String(r.intent_json)),state:r.state,createdAt:Number(r.created_at),
      dispatchedAt:r.dispatched_at===null?null:Number(r.dispatched_at),receivedAt:r.received_at===null?null:Number(r.received_at),finishedAt:r.finished_at===null?null:Number(r.finished_at),
      responseId:r.response_id===null?null:String(r.response_id),usage:r.usage_json===null?null:JSON.parse(String(r.usage_json)),outcome:r.outcome} as ProviderCallRecord:null;
  }
  private required(id:string):ProviderCallRecord { return this.get(id)??conflict(); }
  private current(v:ProviderCallIntent):void {
    const f=v.fence;
    // An operator or exhaustion stop closes every new paid prepare/dispatch, including queued and recovered work.
    if(paidState(this.db).stopped)throw new StoreError('STORE_CONFLICT','Sponsored play is stopped; no new provider call may begin.');
    if(v.role==='CHAT'){
      // A reply belongs to one stored, still-unanswered player message in an attempt that is still at that point.
      const pending=this.db.prepare(`SELECT m.id FROM chat_messages m JOIN attempts a ON a.id=m.attempt_id JOIN players p ON p.id=a.player_id
        WHERE m.id=? AND m.attempt_id=? AND m.power=? AND m.sender='PLAYER' AND m.reply_state='PENDING' AND m.phase_id=? AND m.revision=?
        AND a.revision=m.revision AND a.phase_id=m.phase_id AND a.lifecycle='ACTIVE' AND a.execution='ACCEPTING' AND p.banned_at IS NULL`).get(f.operationId,f.attemptId,v.power,f.phaseId,f.revision);
      if(!pending)conflict();
      return;
    }
    const row=this.db.prepare(`SELECT j.id FROM phase_jobs j JOIN attempts a ON a.id=j.attempt_id JOIN players p ON p.id=a.player_id
      WHERE j.id=? AND j.attempt_id=? AND j.phase_id=? AND j.revision=? AND a.revision=j.revision AND a.phase_id=j.phase_id
      AND json_extract(j.definition_json,'$.humanPower')<>? AND json_extract(j.board_json,'$.phase')=?
      AND a.lifecycle='ACTIVE' AND p.banned_at IS NULL AND j.status IN ('DECIDING','RECOVERING')`).get(f.operationId,f.attemptId,f.phaseId,f.revision,v.power,v.role);
    if(!row)conflict();
  }
  /** Reserves the worst-case cost in the same transaction; a refusal leaves no call record behind. */
  prepare(input:StoreOperations['prepareProviderCall']['input']):ProviderCallRecord|Refusal {
    const v=intent(input.intent);integer(input.now);
    const old=this.get(v.id);
    if(old){const {state,createdAt,dispatchedAt,receivedAt,finishedAt,responseId,usage,outcome,...original}=old;if(canonicalJson(original)!==canonicalJson(v))conflict();return old;}
    this.current(v);
    const refusal=new FundingRepository(this.db).reserve(v,input.now);
    if(refusal)return refusal;
    this.db.prepare(`INSERT INTO provider_calls(id,operation_id,attempt_id,intent_json,state,created_at) VALUES(?,?,?,?,'PREPARED',?)`)
      .run(v.id,v.fence.operationId,v.fence.attemptId,canonicalJson(v),input.now);
    return this.required(v.id);
  }
  dispatch(input:StoreOperations['dispatchProviderCall']['input']):ProviderCallRecord|Refusal {
    integer(input.now);const old=this.required(input.id);
    if(old.state!=='PREPARED'||input.now<old.createdAt)conflict();
    this.current(old);
    // No dispatch without a live reservation for exactly this call.
    if(!this.db.prepare("SELECT 1 FROM reservations WHERE call_id=? AND state='HELD'").get(input.id))conflict();
    const refusal=new FundingRepository(this.db).dispatchAllowed(old,input.now);
    if(refusal)return refusal;
    this.db.prepare("UPDATE provider_calls SET state='DISPATCHED',dispatched_at=? WHERE id=?").run(input.now,input.id);
    return this.required(input.id);
  }
  receive(input:StoreOperations['receiveProviderCall']['input']):ProviderCallRecord {
    integer(input.now);if(input.responseId!==null)identifier(input.responseId);
    const next=input.usage===null?null:usage(input.usage),old=this.required(input.id);
    if(old.dispatchedAt===null||input.now<old.dispatchedAt)conflict();
    if(old.responseId!==null&&input.responseId!==old.responseId)conflict();
    if(old.usage!==null){if(canonicalJson(old.usage)!==canonicalJson(next))conflict();return old;}
    // A late receipt must still reconcile billing after stop/ban/expiry/recovery.
    this.db.prepare(`UPDATE provider_calls SET state=CASE WHEN state='FINISHED' THEN state ELSE 'RECEIVED' END,
      response_id=COALESCE(response_id,?),usage_json=?,received_at=COALESCE(received_at,?) WHERE id=?`)
      .run(input.responseId,next===null?null:canonicalJson(next),input.now,input.id);
    // First known usage settles the reservation exactly once; unknown usage keeps it held.
    if(next!==null)new FundingRepository(this.db).settle(input.id,old.fence.attemptId,next.costNanousd,input.now);
    return this.required(input.id);
  }
  finish(input:StoreOperations['finishProviderCall']['input']):ProviderCallRecord {
    integer(input.now);if(!providerOutcomes.includes(input.outcome))invalid();
    const old=this.required(input.id);
    if(old.dispatchedAt===null||input.now<old.dispatchedAt)conflict();
    if(old.outcome!==null){if(old.outcome!==input.outcome)conflict();return old;}
    if(['VALID','INVALID_JSON','INVALID_ACTION','REFUSED','INCOMPLETE','PROVIDER_ERROR'].includes(input.outcome)&&old.receivedAt===null)conflict();
    this.db.prepare("UPDATE provider_calls SET state='FINISHED',outcome=?,finished_at=? WHERE id=?").run(input.outcome,input.now,input.id);
    return this.required(input.id);
  }
  /**
   * Keeps one power's validated decision as soon as its billed answer has been checked, so a crash
   * before the whole phase is decided does not buy that answer twice. Refused once the phase is
   * closed: a late model result must not become a decision.
   */
  saveDecision(input:StoreOperations['saveProviderDecision']['input']):null {
    integer(input.now);const call=this.required(input.callId),action=parseAction(input.action);
    if(call.receivedAt===null||action.phase!==call.role)conflict();
    const old=this.db.prepare('SELECT action_json FROM provider_decisions WHERE call_id=?').get(input.callId);
    if(old){if(String(old.action_json)!==canonicalJson(action))conflict();return null;}
    if(call.outcome!==null || call.state!=='RECEIVED')conflict();
    const f=call.fence;
    const live=this.db.prepare(`SELECT 1 FROM phase_jobs j JOIN attempts a ON a.id=j.attempt_id JOIN players p ON p.id=a.player_id
      WHERE j.id=? AND j.attempt_id=? AND j.phase_id=? AND j.revision=? AND a.revision=j.revision AND a.phase_id=j.phase_id
      AND j.status IN ('DECIDING','RECOVERING') AND a.lifecycle='ACTIVE' AND p.banned_at IS NULL`)
      .get(f.operationId,f.attemptId,f.phaseId,f.revision);
    if(!live)conflict();
    this.db.prepare('INSERT INTO provider_decisions(call_id,operation_id,power,action_json,created_at) VALUES(?,?,?,?,?)').run(input.callId,call.fence.operationId,call.power,canonicalJson(action),input.now);
    return null;
  }
  decisions(operationId:string):StoreOperations['providerDecisions']['output'] {
    identifier(operationId);
    return this.db.prepare('SELECT call_id,power,action_json FROM provider_decisions WHERE operation_id=? ORDER BY created_at,call_id LIMIT 100').all(operationId)
      .map(r=>({callId:String(r.call_id),power:r.power as ProviderCallIntent['power'],action:parseAction(JSON.parse(String(r.action_json)))}));
  }
  list(operationId:string):ProviderCallRecord[] {
    identifier(operationId);
    const rows=this.db.prepare('SELECT id FROM provider_calls WHERE operation_id=? ORDER BY created_at,id LIMIT 1001').all(operationId);
    if(rows.length>1000)throw new StoreError('STORE_UNAVAILABLE','Provider recovery record count exceeds its bound.');
    return rows.map(r=>this.required(String(r.id)));
  }
  forAttempt(attemptId:string):ProviderCallRecord[] {
    identifier(attemptId);
    const rows=this.db.prepare('SELECT id FROM provider_calls WHERE attempt_id=? ORDER BY created_at,id LIMIT 2001').all(attemptId);
    if(rows.length>2000)throw new StoreError('STORE_UNAVAILABLE','Provider record count for this attempt exceeds its bound.');
    return rows.map(r=>this.required(String(r.id)));
  }
  totals(input:StoreOperations['providerCallTotals']['input']):StoreOperations['providerCallTotals']['output'] {
    identifier(input.operationId);
    const r=this.db.prepare(`SELECT count(*) calls,
      sum(CASE WHEN usage_json IS NOT NULL THEN 1 ELSE 0 END) known,
      sum(CASE WHEN usage_json IS NULL THEN 1 ELSE 0 END) unresolved,
      sum(COALESCE(json_extract(usage_json,'$.costNanousd'),0)) cost,
      sum(CASE WHEN usage_json IS NULL THEN json_extract(intent_json,'$.maxCostNanousd') ELSE 0 END) liability,
      sum(COALESCE(json_extract(usage_json,'$.inputTokens'),0)) input,
      sum(COALESCE(json_extract(usage_json,'$.outputTokens'),0)) output
      FROM provider_calls WHERE operation_id=?`).get(input.operationId)!;
    const result={calls:Number(r.calls),knownCalls:Number(r.known??0),unresolvedCalls:Number(r.unresolved??0),knownCostNanousd:Number(r.cost??0),unresolvedLiabilityNanousd:Number(r.liability??0),inputTokens:Number(r.input??0),outputTokens:Number(r.output??0)};
    for(const n of Object.values(result))integer(n);
    return result;
  }
}
