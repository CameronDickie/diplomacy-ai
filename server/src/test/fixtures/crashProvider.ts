import { Store } from '../../storage/Store.js';
const [path,stage]=process.argv.slice(2),store=await Store.open(path),now=1_800_000_000_000;
const die=(point:string)=>{if(stage===point)process.kill(process.pid,'SIGKILL');};
die('PREPARED');
await store.call('dispatchProviderCall',{id:'crash',now});die('DISPATCHED');
await store.call('receiveProviderCall',{id:'crash',responseId:'resp_crash',usage:{inputTokens:100,cachedInputTokens:20,cacheWriteTokens:10,outputTokens:50,reasoningTokens:20,costNanousd:12345},now});die('RECEIVED');
await store.call('finishProviderCall',{id:'crash',outcome:'VALID',now});die('FINISHED');
await store.close();process.exit(24);
