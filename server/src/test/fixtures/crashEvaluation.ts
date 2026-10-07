import { Store } from '../../storage/Store.js';
import { evaluate } from '../../evaluation/Harness.js';
import { mockLunaTransport,type LunaTransport } from '../../luna/Transport.js';
import { shutdownGodip } from '../../adjudication/GodipAdjudicator.js';
const [path,stage]=process.argv.slice(2),store=await Store.open(path),mock=mockLunaTransport({pick:'first',seed:5});
let broken=false;
const transport:LunaTransport=async request=>{
  const response=await mock(request);
  if((stage==='RECOVERED'&&!broken)||stage==='MAX_RECOVERIES'){broken=true;(response.body as {output:Array<{content:Array<{text:string}>}>}).output[0].content[0].text='not json';}
  return response;
};
await evaluate({store,runId:'crash-run',scenario:'tunis-expedition',script:'early-capture',attempts:1,seed:5,transport,transportKind:'mock',
  boundary:async(point,id)=>{
    const phases=await store.call('evaluationPhases',{attemptId:id});
    if((stage==='INTENT'&&point==='intent')||(stage==='COMMITTED'&&point==='committed')
      ||(stage==='RECOVERED'&&point==='intent'&&phases.at(-1)!.recoveries===1)
      ||(stage==='MAX_RECOVERIES'&&point==='intent'&&phases.at(-1)!.recoveries===2))process.kill(process.pid,'SIGKILL');
  }});
await store.close();await shutdownGodip();process.exit(24);
