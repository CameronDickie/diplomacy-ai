import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../fixtures/BoardFixture.js';
import type { PhaseJob } from '../attempts/types.js';
import { StoreError, type EvaluationManifest, type EvaluationPhase, type StoredAttempt, type StoreOperations } from './contracts.js';
type StartRefusal={refused:'SPONSORED_UNAVAILABLE'};

const invalid=():never=>{throw new StoreError('STORE_INVALID','Invalid evaluation metadata.');};
const conflict=(message:string):never=>{throw new StoreError('STORE_CONFLICT',message);};
const time=(n:number)=>{if(!Number.isSafeInteger(n)||n<0)invalid();};
const run=(id:string)=>{if(typeof id!=='string'||!/^[a-z0-9-]{3,40}$/.test(id))invalid();};
function manifest(v:EvaluationManifest):EvaluationManifest {
  const fields=['runId','transport','scenario','scenarioVersion','fixtureHash','script','seed','presetId','pricingVersion','presetHash','contextVersion','model','harnessVersion','timingPolicy','maxRecoveries'];
  if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!==fields.sort().join(','))invalid();
  run(v.runId);
  for(const value of [v.scenario,v.script,v.presetId,v.pricingVersion,v.contextVersion,v.harnessVersion])
    if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(value))invalid();
  if(!['mock','live'].includes(v.transport)||!['gpt-6-luna','claude-haiku-5-5'].includes(v.model)||v.timingPolicy!=='wall-submission-commit-v1'
    ||!Number.isSafeInteger(v.scenarioVersion)||v.scenarioVersion<1||v.scenarioVersion>1000
    ||(v.seed!==null&&(!Number.isSafeInteger(v.seed)||v.seed<0||v.seed>0xffffffff))
    ||!Number.isSafeInteger(v.maxRecoveries)||v.maxRecoveries<0||v.maxRecoveries>10
    ||!/^[a-f0-9]{64}$/.test(v.fixtureHash)||!/^[a-f0-9]{64}$/.test(v.presetHash))invalid();
  return v;
}

/** Every write is inside the worker transaction, including phase acceptance and commit. */
export class EvaluationRepository {
  constructor(private db:DatabaseSync){}
  get(id:string):EvaluationManifest|null {
    run(id);const row=this.db.prepare('SELECT manifest_json FROM evaluation_runs WHERE id=?').get(id);
    return row?manifest(JSON.parse(String(row.manifest_json))):null;
  }
  register(input:StoreOperations['registerEvaluationRun']['input']):EvaluationManifest {
    const value=manifest(input.manifest);time(input.now);const old=this.get(value.runId);
    if(old){if(canonicalJson(old)!==canonicalJson(value))conflict('Evaluation run ID belongs to a different configuration.');return old;}
    const prefix=`eval-${value.runId}-`;
    if(this.db.prepare("SELECT 1 FROM attempts WHERE substr(id,1,?)=? AND length(id)>? AND substr(id,?) NOT GLOB '*[^0-9]*' LIMIT 1").get(prefix.length,prefix,prefix.length,prefix.length+1))
      conflict('Legacy evaluation has no durable manifest. Use a new run ID; do not relabel existing evidence.');
    this.db.prepare('INSERT INTO evaluation_runs(id,manifest_json,created_at) VALUES(?,?,?)').run(value.runId,canonicalJson(value),input.now);
    return value;
  }
  create(input:StoreOperations['createEvaluationAttempt']['input'],get:(id:string)=>StoredAttempt|null,
    create:(input:StoreOperations['createAttempt']['input'])=>StoredAttempt|StartRefusal):StoredAttempt|StartRefusal {
    run(input.runId);time(input.now);
    if(!Number.isSafeInteger(input.ordinal)||input.ordinal<1||input.ordinal>200)invalid();
    const config=this.get(input.runId);if(!config)conflict('Register the evaluation manifest first.');
    const id=`eval-${input.runId}-${input.ordinal}`,mapping=this.db.prepare('SELECT attempt_id FROM evaluation_attempts WHERE run_id=? AND ordinal=?').get(input.runId,input.ordinal);
    if(mapping){const old=get(String(mapping.attempt_id));if(!old)conflict('Evaluation attempt has expired. Restore its evidence; it cannot be bought again.');
      if(old!.playerId!==input.playerId)conflict('Evaluation attempt has another owner.');return old!;}
    if(get(id))conflict('Unregistered evaluation attempt cannot be adopted.');
    if(input.sponsored.preset.id!==config!.presetId||input.sponsored.preset.pricingVersion!==config!.pricingVersion)invalid();
    const value=create({id,playerId:input.playerId,challengeId:config!.scenario,challengeVersion:config!.scenarioVersion,
      sponsored:input.sponsored,reconnectTokenHash:input.reconnectTokenHash,now:input.now});
    if('refused' in value)return value;
    this.db.prepare('INSERT INTO evaluation_attempts(attempt_id,run_id,ordinal,created_at) VALUES(?,?,?,?)').run(id,input.runId,input.ordinal,input.now);
    return value;
  }
  begin(job:PhaseJob,at:number):void {
    if(!this.db.prepare('SELECT 1 FROM evaluation_attempts WHERE attempt_id=?').get(job.attemptId))return;
    time(at);
    this.db.prepare('INSERT INTO evaluation_phases(operation_id,attempt_id,phase_id,sequence,started_at) VALUES(?,?,?,?,?)')
      .run(job.operationId,job.attemptId,job.phaseId,job.reportOffset+1,at);
  }
  recovery(id:string,count:boolean):void {
    if(!count)return;
    const row=this.db.prepare('SELECT p.recoveries,r.manifest_json FROM evaluation_phases p JOIN evaluation_attempts a ON a.attempt_id=p.attempt_id JOIN evaluation_runs r ON r.id=a.run_id WHERE p.operation_id=?').get(id);
    if(!row)return;
    if(Number(row.recoveries)>=manifest(JSON.parse(String(row.manifest_json))).maxRecoveries)conflict('Evaluation phase recovery limit reached.');
    this.db.prepare('UPDATE evaluation_phases SET recoveries=recoveries+1 WHERE operation_id=?').run(id);
  }
  commit(id:string,at:number):void {
    const row=this.db.prepare('SELECT started_at FROM evaluation_phases WHERE operation_id=?').get(id);if(!row)return;
    time(at);const duration=at-Number(row.started_at);
    // A backward wall clock is missing latency evidence, never a fabricated zero or a game failure.
    this.db.prepare('UPDATE evaluation_phases SET completed_at=?,duration_ms=? WHERE operation_id=?').run(at,duration>=0?duration:null,id);
  }
  phases(attemptId:string):EvaluationPhase[] {
    if(typeof attemptId!=='string'||attemptId.length>100)invalid();
    const rows=this.db.prepare('SELECT * FROM evaluation_phases WHERE attempt_id=? ORDER BY sequence LIMIT 121').all(attemptId);
    if(rows.length>120)conflict('Evaluation phase evidence exceeds its bound.');
    return rows.map(r=>({operationId:String(r.operation_id),attemptId:String(r.attempt_id),phaseId:String(r.phase_id),sequence:Number(r.sequence),startedAt:Number(r.started_at),
      completedAt:r.completed_at===null?null:Number(r.completed_at),durationMs:r.duration_ms===null?null:Number(r.duration_ms),recoveries:Number(r.recoveries)}));
  }
}
