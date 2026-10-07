import { Store } from '../../storage/Store.js';
import { AttemptService } from '../../attempts/AttemptService.js';
import { PhaseRules } from '../../attempts/PhaseRules.js';
import { LunaDecisionProvider } from '../../luna/LunaDecisionProvider.js';
import { httpLunaTransport,mockLunaTransport } from '../../luna/Transport.js';
import { LUNA_PRESET } from '../../providers/LunaPreset.js';
// Runs one sponsored phase and kills itself at a named point while GERMANY (the fourth opponent) is being decided.
const [path,stage,input]=process.argv.slice(2),store=await Store.open(path),now=()=>1_800_000_000_000;
const die=()=>process.kill(process.pid,'SIGKILL'),mock=mockLunaTransport();
class Rules extends PhaseRules {
  // The provider validates a model answer here after its usage is recorded and before the decision is saved.
  override async validate(...args:Parameters<PhaseRules['validate']>){if(stage==='RECEIVED'&&args[1]==='GERMANY')die();return super.validate(...args);}
}
const rules=new Rules();
const counted=httpLunaTransport('test-key-not-real',(async(url,init)=>{
  if(String(url)===LUNA_PRESET.countEndpoint){if(stage==='COUNTING'&&String(init!.body).includes('You are GERMANY.'))die();return new Response('{"object":"response.input_tokens","input_tokens":100}');}
  const result=await mock({body:String(init!.body),signal:init!.signal as AbortSignal});return new Response(JSON.stringify(result.body));
}) as typeof fetch);
const preflight=counted.preflight!;
counted.preflight=async input=>{const result=await preflight(input);if(stage==='COUNTED'&&input.body.includes('You are GERMANY.'))die();return result;};
const transport=['COUNTING','COUNTED'].includes(stage)?counted:async(request:Parameters<typeof mock>[0])=>{if(stage==='DISPATCHED'&&request.body.includes('You are GERMANY.'))die();return mock(request);};
const provider=new LunaDecisionProvider(store,rules,transport,
  {now,maxConcurrentDecisions:1,boundary:async(point,power)=>{if(power==='GERMANY'&&((stage==='RESERVED'&&point==='reserved')||(stage==='DECIDED'&&point==='decided')))die();}});
const service=new AttemptService(store,provider,rules,{now,boundary:async point=>{if((stage==='ALL_DECIDED'&&point==='decisions')||(stage==='COMMITTED'&&point==='committed'))die();}});
const command=JSON.parse(input);
await service.submit(command);await service.wait(command.attemptId);
await service.close();await store.close();process.exit(24);
