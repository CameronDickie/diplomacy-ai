import { createHash } from 'node:crypto';
import { Store } from '../../storage/Store.js';
// Killed at a named point between ledger steps; the parent test then reopens the database.
const [path,stage,fence]=process.argv.slice(2),store=await Store.open(path),now=1_800_000_000_000;
const die=(point:string)=>{if(stage===point)process.kill(process.pid,'SIGKILL');};
const intent={id:'crash',fence:JSON.parse(fence),power:'FRANCE' as const,provider:'OPENAI' as const,model:'gpt-6-luna' as const,role:'ORDERS' as const,pricingVersion:'mock-price-v1',
  requestHash:createHash('sha256').update('crash').digest('hex'),maxCostNanousd:100000};
die('BEFORE_RESERVE');
await store.call('prepareProviderCall',{intent,now});die('RESERVED');
await store.call('dispatchProviderCall',{id:'crash',now});die('DISPATCHED');
await store.call('receiveProviderCall',{id:'crash',responseId:'resp_crash',usage:{inputTokens:100,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:50,reasoningTokens:0,costNanousd:12345},now});die('SETTLED');
await store.close();process.exit(24);
