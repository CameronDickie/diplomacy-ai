import { Store } from '../../storage/Store.js';
import { AttemptService } from '../../attempts/AttemptService.js';
import { PhaseRules } from '../../attempts/PhaseRules.js';
import { LunaDecisionProvider } from '../../luna/LunaDecisionProvider.js';
import { mockLunaTransport } from '../../luna/Transport.js';
// Runs one sponsored phase and kills itself at a named point while GERMANY (the fourth opponent) is being decided.
const [path,stage,input]=process.argv.slice(2),store=await Store.open(path),now=()=>1_800_000_000_000;
const die=()=>process.kill(process.pid,'SIGKILL'),mock=mockLunaTransport();
class Rules extends PhaseRules {
  // The provider validates a model answer here after its usage is recorded and before the decision is saved.
  override async validate(...args:Parameters<PhaseRules['validate']>){if(stage==='RECEIVED'&&args[1]==='GERMANY')die();return super.validate(...args);}
}
const rules=new Rules();
const provider=new LunaDecisionProvider(store,rules,async request=>{if(stage==='DISPATCHED'&&request.body.includes('You are GERMANY.'))die();return mock(request);},
  {now,boundary:async(point,power)=>{if(power==='GERMANY'&&((stage==='RESERVED'&&point==='reserved')||(stage==='DECIDED'&&point==='decided')))die();}});
const service=new AttemptService(store,provider,rules,{now,boundary:async point=>{if((stage==='ALL_DECIDED'&&point==='decisions')||(stage==='COMMITTED'&&point==='committed'))die();}});
const command=JSON.parse(input);
await service.submit(command);await service.wait(command.attemptId);
await service.close();await store.close();process.exit(24);
