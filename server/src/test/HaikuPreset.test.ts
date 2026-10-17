import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readRuntimeConfig } from '../../../config/runtime.cjs';
import { evaluate } from '../evaluation/Harness.js';
import { keyVariable,liveTransport } from '../evaluation/cli.js';
import { anthropicHaikuTransport } from '../luna/HaikuTransport.js';
import { mockOpponentTransport } from '../luna/Transport.js';
import { HAIKU_PRESET,buildHaikuRequest,haikuReservationNanousd,mockHaikuEnvelope } from '../providers/HaikuPreset.js';
import { normalizeHaikuResponse } from '../providers/HaikuResponse.js';
import { HAIKU_CONTRACT,LUNA_CONTRACT,opponentContract } from '../providers/OpponentContract.js';
import { Store } from '../storage/Store.js';

const context='You are ENGLAND.\nLON:\n0 hold\n1 move to NTH';
const answer=(over:Record<string,unknown>={},usage:Record<string,unknown>={}):Record<string,unknown>=>({...(mockHaikuEnvelope({serial:1,text:'{"choices":[0]}',inputTokens:900,outputTokens:60}) as Record<string,unknown>),...over,
  usage:{...((mockHaikuEnvelope({serial:1,text:'',inputTokens:900,outputTokens:60}) as {usage:Record<string,unknown>}).usage),...usage}});

test('the Haiku request is fully pinned: model, cap, low effort, schema and nothing a caller can override',()=>{
  const request=buildHaikuRequest({context}),body=JSON.parse(request.body);
  assert.deepEqual(Object.keys(body).sort(),['max_tokens','messages','model','output_config','stream','system','thinking']);
  assert.deepEqual([body.model,body.max_tokens,body.stream,body.thinking,body.output_config.effort],['claude-haiku-5-5',4096,false,{type:'adaptive'},'low']);
  assert.deepEqual(body.messages,[{role:'user',content:context}]);
  // The API rejects numeric and length limits in a schema; bounds are applied when the answer is parsed.
  assert.deepEqual(body.output_config.format,{type:'json_schema',schema:{type:'object',properties:{choices:{type:'array',items:{type:'integer'}}},required:['choices'],additionalProperties:false}});
  // Rejected or unreserved features are absent: sampling, tools, prompt caching, another model as fallback, a prefilled turn.
  for(const banned of ['temperature','top_p','top_k','tools','tool_choice','cache_control','fallbacks','budget_tokens','service_tier'])assert.equal(request.body.includes(`"${banned}"`),false,banned);
  assert.deepEqual([request.presetId,request.pricingVersion],[HAIKU_PRESET.id,HAIKU_PRESET.pricingVersion]);
  assert.equal(request.requestHash,buildHaikuRequest({context}).requestHash);assert.notEqual(request.requestHash,buildHaikuRequest({context:`${context} `}).requestHash);
  assert.throws(()=>buildHaikuRequest({context:'x'.repeat(HAIKU_PRESET.maxContextBytes+1)}),/oversized/);
  assert.throws(()=>buildHaikuRequest({context,model:'claude-opus-5-5'} as never),/Invalid/);
  assert.throws(()=>buildHaikuRequest({context:'   '}),/Invalid/);
});

test('the reservation is the worst case: the dearest input rate for every allowed token plus the whole output cap',()=>{
  assert.equal(haikuReservationNanousd(HAIKU_PRESET.maxInputTokens),32_768*200+4_096*500);
  for(const bad of [0,-1,1.5,HAIKU_PRESET.maxInputTokens+1,Number.NaN])assert.throws(()=>haikuReservationNanousd(bad),/bound/);
  // No bill inside the preset's limits can exceed what was held for it.
  const dearest=normalizeHaikuResponse(answer({},{input_tokens:0,cache_creation_input_tokens:HAIKU_PRESET.maxInputTokens,cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:HAIKU_PRESET.maxInputTokens},output_tokens:HAIKU_PRESET.maxOutputTokens}));
  assert.equal(dearest.status,'COMPLETED');assert.equal(dearest.usage!.costNanousd,haikuReservationNanousd(HAIKU_PRESET.maxInputTokens));
  // The two contracts are separate objects with separate prices and identities.
  assert.notEqual(HAIKU_CONTRACT.presetHash,LUNA_CONTRACT.presetHash);
  assert.deepEqual([opponentContract('haiku').preset.provider,opponentContract('luna').preset.provider],['ANTHROPIC','OPENAI']);
  assert.throws(()=>opponentContract('opus'),/Unknown sponsored preset/);
});

test('an answer is read by block type, billed from usage, and thinking is counted as output',()=>{
  const sample=answer(),ok=normalizeHaikuResponse(sample);
  assert.deepEqual(ok,{responseId:String(sample.id),status:'COMPLETED',outputText:'{"choices":[0]}',
    usage:{inputTokens:900,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:60,reasoningTokens:16,costNanousd:900*100+60*500}});
  // `input_tokens` excludes cached tokens here, so the stored total is the sum and each part has its own rate.
  const cached=normalizeHaikuResponse(answer({},{input_tokens:100,cache_read_input_tokens:700,cache_creation_input_tokens:300,cache_creation:{ephemeral_5m_input_tokens:200,ephemeral_1h_input_tokens:100}}));
  assert.deepEqual([cached.usage!.inputTokens,cached.usage!.cachedInputTokens,cached.usage!.cacheWriteTokens,cached.usage!.costNanousd],[1100,700,300,100*100+700*10+200*125+100*200+60*500]);
  // A cache write with no breakdown is priced at the dearer rate, and absent cache figures are zero.
  assert.equal(normalizeHaikuResponse(answer({},{cache_creation_input_tokens:10,cache_creation:null})).usage!.costNanousd,900*100+10*200+60*500);
  assert.equal(normalizeHaikuResponse(answer({},{cache_read_input_tokens:null,cache_creation_input_tokens:null,cache_creation:null,output_tokens_details:null})).usage!.costNanousd,900*100+60*500);
});

test('a safety decline and a spent output cap are billed, typed outcomes; nothing unexpected is treated as a decision',()=>{
  const refused=normalizeHaikuResponse(answer({stop_reason:'refusal',stop_details:{type:'refusal',category:'general_harms',explanation:'private'},content:[]}));
  assert.deepEqual([refused.status,refused.outputText,refused.usage!.costNanousd],['REFUSED',null,900*100+60*500]);
  assert.equal(JSON.stringify(refused).includes('private'),false);
  const cut=normalizeHaikuResponse(answer({stop_reason:'max_tokens',content:[{type:'thinking',thinking:'',signature:'s'}]},{output_tokens:4096}));
  assert.deepEqual([cut.status,cut.usage!.outputTokens],['INCOMPLETE',4096]);
  const error=(value:unknown,status=200)=>normalizeHaikuResponse(value,status);
  // Still billed and known, but not usable.
  for(const [name,value,status] of [['two text blocks',answer({content:[{type:'text',text:'a'},{type:'text',text:'b'}]}),200],['no text',answer({content:[{type:'thinking',thinking:'',signature:'s'}]}),200],
    ['pause',answer({stop_reason:'pause_turn'}),200],['http error with a body',answer(),500]] as const){
    const r=error(value,status);assert.equal(r.status,'ERROR',name);assert.equal(r.outputText,null,name);
  }
  // Unknown price: wrong model, wrong tier, tool activity, missing or inconsistent usage. Never zero, never guessed.
  for(const [name,value] of [['another model',answer({model:'claude-sonnet-5-5'})],['priority tier',answer({},{service_tier:'priority'})],['a tool call',answer({content:[{type:'tool_use',id:'t',name:'x',input:{}}]})],
    ['server tool use',answer({},{server_tool_use:{web_search_requests:1}})],['missing output count',answer({},{output_tokens:undefined})],['split does not add up',answer({},{cache_creation_input_tokens:5,cache_creation:{ephemeral_5m_input_tokens:1,ephemeral_1h_input_tokens:1}})],
    ['thinking above output',answer({},{output_tokens_details:{thinking_tokens:61}})],['no body',null],['an error body',{type:'error',error:{type:'overloaded_error',message:'x'}}]] as const){
    const r=error(value);assert.equal(r.status,'ERROR',name);assert.equal(r.usage,null,name);
  }
  // Beyond the preset's bounds the real bill is kept (on the long-prompt rate card when it applies) and the call fails.
  const long=error(answer({},{input_tokens:100_001}));
  assert.deepEqual([long.status,long.usage!.costNanousd],['ERROR',(100_001*100+60*500)*5]);
  assert.equal(error(answer({},{output_tokens:4097})).status,'ERROR');
});

/** A stand-in for api.anthropic.com that records what the SDK sends. */
function endpoint(reply:(path:string,body:Record<string,unknown>)=>{status:number;body:unknown}){
  const seen:Array<{path:string;body:Record<string,unknown>;headers:Headers}>=[];
  const fetchImpl=(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const path=new URL(String(input instanceof Request?input.url:input)).pathname,body=JSON.parse(String(init?.body??'{}')) as Record<string,unknown>;
    seen.push({path,body,headers:new Headers(init?.headers)});
    const r=reply(path,body);
    return new Response(JSON.stringify(r.body),{status:r.status,headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  return {seen,fetchImpl};
}
const live=AbortSignal.timeout(10_000);

test('the transport counts the exact input first, sends those bytes once through the SDK, and never retries',async()=>{
  const request=buildHaikuRequest({context});
  const api=endpoint(path=>path.endsWith('/count_tokens')?{status:200,body:{input_tokens:1234}}:{status:200,body:answer()});
  const transport=anthropicHaikuTransport('synthetic-test-key',api.fetchImpl);
  await assert.rejects(transport({body:request.body,signal:live}),/requires a successful input-token preflight/);
  const {inputTokens,send}=await transport.preflight!({body:request.body,signal:live});
  assert.equal(inputTokens,1234);assert.deepEqual(api.seen.map(x=>x.path),['/v1/messages/count_tokens']);
  // The count covers every input-affecting field and creates no model response.
  assert.deepEqual(Object.keys(api.seen[0].body).sort(),['messages','model','output_config','system','thinking']);
  assert.equal(api.seen[0].headers.get('x-api-key'),'synthetic-test-key');
  const response=await send({body:request.body,signal:live});
  assert.equal(normalizeHaikuResponse(response.body,response.status).status,'COMPLETED');
  assert.deepEqual(api.seen.map(x=>x.path),['/v1/messages/count_tokens','/v1/messages']);
  assert.deepEqual(api.seen[1].body,JSON.parse(request.body));
  await assert.rejects(send({body:request.body,signal:live}),/repeated dispatch/);
  assert.equal(api.seen.length,2);
  // Changed bytes are refused before either endpoint sees them.
  const other=await transport.preflight!({body:request.body,signal:live});
  await assert.rejects(other.send({body:buildHaikuRequest({context:`${context}!`}).body,signal:live}),/does not authorize/);
  for(const tampered of [request.body.replace('claude-haiku-5-5','claude-opus-5-5'),request.body.replace('"max_tokens":4096','"max_tokens":64000'),request.body.replace('"effort":"low"','"effort":"max"'),'{}','not json']){
    const sentSoFar:number=api.seen.length;
    await assert.rejects(transport.preflight!({body:tampered,signal:live}),/Invalid Haiku request contract/);assert.equal(api.seen.length,sentSoFar);
  }
  assert.throws(()=>anthropicHaikuTransport('short'),/key is required/);
});

test('a failed or oversized count buys nothing, and a provider error is one request with no retry',async()=>{
  const request=buildHaikuRequest({context});
  for(const [name,count] of [['over the input bound',{status:200,body:{input_tokens:HAIKU_PRESET.maxInputTokens+1}}],['count unavailable',{status:529,body:{type:'error',error:{type:'overloaded_error',message:'x'}}}],['malformed count',{status:200,body:{input_tokens:'many'}}]] as const){
    const api=endpoint(()=>count);
    await assert.rejects(anthropicHaikuTransport('synthetic-test-key',api.fetchImpl).preflight!({body:request.body,signal:live}),/preflight/,name);
    // One count request, never a generation request, and the SDK did not retry the failure.
    assert.deepEqual(api.seen.map(x=>x.path),['/v1/messages/count_tokens'],name);
  }
  for(const status of [429,500,529]){
    const api=endpoint(path=>path.endsWith('/count_tokens')?{status:200,body:{input_tokens:50}}:{status,body:{type:'error',error:{type:'api_error',message:'secret detail'}}});
    const {send}=await anthropicHaikuTransport('synthetic-test-key',api.fetchImpl).preflight!({body:request.body,signal:live});
    const response=await send({body:request.body,signal:live});
    assert.deepEqual(response,{status,body:null});assert.equal(api.seen.filter(x=>x.path==='/v1/messages').length,1,String(status));
    assert.deepEqual(normalizeHaikuResponse(response.body,response.status),{responseId:null,usage:null,status:'ERROR',outputText:null});
  }
  // A cancelled wait stops before anything is sent.
  const api=endpoint(()=>({status:200,body:{input_tokens:50}}));
  await assert.rejects(anthropicHaikuTransport('synthetic-test-key',api.fetchImpl).preflight!({body:request.body,signal:AbortSignal.abort()}));assert.equal(api.seen.length,0);
});

test('whole Haiku attempts run through the same ledger offline, are recorded under their own provider and preset, and cannot be mixed with Luna',async t=>{
  const outbound:string[]=[],realFetch=globalThis.fetch;
  globalThis.fetch=((input:Parameters<typeof fetch>[0])=>{outbound.push(String(input));throw new Error('no network in tests');}) as typeof fetch;
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-haiku-')),path=join(dir,'game.sqlite'),store=await Store.open(path);
  t.after(async()=>{globalThis.fetch=realFetch;await store.close();await rm(dir,{recursive:true,force:true});});
  await store.call('grantFunding',{amountNanousd:1_000_000_000,authorizationRef:'owner-haiku-0001',grantedBy:'test',now:1});
  let tick=0;
  const base={store,transportKind:'mock' as const,runId:'haiku-a',scenario:'tunis-expedition',script:'early-capture',attempts:2,seed:5,now:()=>1_800_000_000_000,clock:()=>(tick+=25)};
  const report=await evaluate({...base,contract:HAIKU_CONTRACT,transport:mockOpponentTransport(HAIKU_CONTRACT,{pick:'seeded',seed:5})});
  assert.deepEqual([report.manifest.presetId,report.manifest.model,report.manifest.pricingVersion,report.manifest.presetHash],[HAIKU_PRESET.id,'claude-haiku-5-5',HAIKU_PRESET.pricingVersion,HAIKU_CONTRACT.presetHash]);
  assert.equal(report.attempts.length,2);
  for(const attempt of report.attempts){
    assert.equal(attempt.lifecycle,'COMPLETED');assert.equal(attempt.callOutcomes.VALID,attempt.calls);assert.equal(attempt.heldNanousd,0);
    assert.ok(attempt.settledNanousd>0&&attempt.settledNanousd<attempt.reservedEstimateNanousd);
  }
  assert.equal(report.ledger.reconciles,true);assert.equal((await store.call('fundingTotals',{})).settledNanousd,report.summary.settledNanousd);
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    assert.deepEqual(db.prepare("SELECT DISTINCT json_extract(intent_json,'$.provider') AS provider,json_extract(intent_json,'$.model') AS model,json_extract(intent_json,'$.pricingVersion') AS pricing,json_extract(intent_json,'$.maxCostNanousd') AS held FROM provider_calls").all().map(r=>({...r})),
      [{provider:'ANTHROPIC',model:'claude-haiku-5-5',pricing:HAIKU_PRESET.pricingVersion,held:haikuReservationNanousd(HAIKU_PRESET.maxInputTokens)}]);
    assert.deepEqual(db.prepare('SELECT DISTINCT preset_id AS id,pricing_version AS pricing FROM attempts').all().map(r=>({...r})),[{id:HAIKU_PRESET.id,pricing:HAIKU_PRESET.pricingVersion}]);
  }finally{db.close();}
  // The same run cannot be continued under the other preset, and nothing is dispatched trying.
  const settled=(await store.call('fundingTotals',{})).settledNanousd;
  await assert.rejects(evaluate({...base,attempts:3,contract:LUNA_CONTRACT,transport:mockOpponentTransport(LUNA_CONTRACT,{pick:'seeded',seed:5})}));
  assert.equal((await store.call('fundingTotals',{})).settledNanousd,settled);
  // A Haiku answer handed to the Luna parser (or the reverse) is an unknown-price error, never a decision.
  assert.equal(LUNA_CONTRACT.normalizeResponse(answer(),200).usage,null);
  assert.equal(HAIKU_CONTRACT.normalizeResponse(LUNA_CONTRACT.mockEnvelope({serial:1,text:'{"choices":[0]}',inputTokens:9,outputTokens:9}),200).usage,null);
  assert.deepEqual(outbound,[]);
});

test('a live Haiku run needs its own key variable, and the preset is a validated deployment setting',()=>{
  assert.deepEqual([keyVariable(HAIKU_CONTRACT),keyVariable(LUNA_CONTRACT)],['ANTHROPIC_API_KEY','OPENAI_API_KEY']);
  assert.equal(liveTransport({live:false,db:'/nonexistent',attempts:1,contract:HAIKU_CONTRACT}),null);
  assert.throws(()=>liveTransport({live:true,db:'/nonexistent',authorizationRef:'ref-0001',attempts:1,contract:HAIKU_CONTRACT}),/ANTHROPIC_API_KEY/);
  assert.throws(()=>liveTransport({live:true,db:'/nonexistent',authorizationRef:'ref-0001',attempts:1,apiKey:'synthetic-test-key',contract:HAIKU_CONTRACT}),/existing ledger database/);
  assert.equal(readRuntimeConfig({DIPLOMACY_PROFILE:'local'}).sponsoredPreset,'luna');
  assert.equal(readRuntimeConfig({DIPLOMACY_PROFILE:'local',DIPLOMACY_SPONSORED_PRESET:'haiku'}).sponsoredPreset,'haiku');
  assert.throws(()=>readRuntimeConfig({DIPLOMACY_PROFILE:'local',DIPLOMACY_SPONSORED_PRESET:'sonnet'}),/DIPLOMACY_SPONSORED_PRESET/);
});
