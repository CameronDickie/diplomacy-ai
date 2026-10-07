import {Store} from '../../storage/Store.js';
import {AttemptService} from '../../attempts/AttemptService.js';
import {PhaseRules} from '../../attempts/PhaseRules.js';
import {LunaDecisionProvider} from '../../luna/LunaDecisionProvider.js';
import {mockLunaTransport,type LunaTransport} from '../../luna/Transport.js';
const [path,stage,input]=process.argv.slice(2),store=await Store.open(path),now=()=>1_800_000_000_000;
const die=()=>process.kill(process.pid,'SIGKILL'),mock=mockLunaTransport();
let prepared=0,sent=0,ready!:()=>void;
const allStarted=new Promise<void>(done=>{ready=done;});
const transport:LunaTransport=async request=>{
  if(++sent===6){if(stage==='DISPATCHED')die();ready();}
  await allStarted;
  if(stage==='DECIDED'&&request.body.includes('You are AUSTRIA.'))return mock(request);
  return new Promise(()=>{});
};
const rules=new PhaseRules(),provider=new LunaDecisionProvider(store,rules,transport,{now,boundary:async(point,power)=>{
  if(stage==='RESERVED'&&point==='reserved'){if(++prepared===6)die();await new Promise(()=>{});}
  if(stage==='DECIDED'&&point==='decided'&&power==='AUSTRIA')die();
}});
const service=new AttemptService(store,provider,rules,{now}),command=JSON.parse(input);
await service.submit(command);await service.wait(command.attemptId);await service.close();await store.close();process.exit(24);
