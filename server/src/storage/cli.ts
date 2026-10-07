import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from './Store.js';

const [command,source,destination,reference,extra]=process.argv.slice(2);
/** Exact decimal dollars to integer billionths; no floating point touches an amount of money. */
function nanousd(text:string,allowZero=false):number {
  const match=/^(\d{1,7})(?:\.(\d{1,9}))?$/.exec(text??'');
  if(!match)throw new Error('Amount must be decimal US dollars with at most nine decimal places, for example 5 or 2.50.');
  const value=Number(match[1])*1_000_000_000+Number((match[2]??'').padEnd(9,'0'));
  if(!Number.isSafeInteger(value)||(value<1&&!allowZero))throw new Error('Amount must be greater than zero.');
  return value;
}
let store:Store|undefined;
try {
  if (!source || !['init','health','backup','restore','funding','grant','held','resolve'].includes(command) || (['backup','restore'].includes(command) && !destination) || (command==='grant' && (!destination || !reference)) || (command==='resolve' && (!destination || !reference || !extra))) {
    throw new Error('Usage: storage init DATABASE | storage health DATABASE | storage backup DATABASE NEW_BACKUP | storage restore BACKUP NEW_DATABASE | storage funding DATABASE | storage grant DATABASE USD AUTHORIZATION_REFERENCE | storage held DATABASE | storage resolve DATABASE CALL_ID USD AUTHORIZATION_REFERENCE');
  }
  if (command !== 'init' && !existsSync(source)) throw new Error('Source database does not exist. Check its path; init is the explicit new-database command.');
  store=['health','backup','funding','held'].includes(command) ? await Store.inspect(resolve(source))
    : await Store.open(resolve(command==='restore'?destination!:source),command==='restore'?resolve(source):undefined);
  // A grant is the only way funds enter the ledger. It needs host access to the database and an explicit reference.
  const result=command==='backup'?await store.call('backup',{destination:resolve(destination!)})
    : command==='funding'?await store.call('fundingTotals',{})
    : command==='held'?await store.call('heldLiabilities',{})
    : command==='resolve'?await store.call('resolveLiability',{callId:destination!,costNanousd:nanousd(reference!,true),authorizationRef:extra!,now:Date.now()})
    : command==='grant'?await store.call('grantFunding',{amountNanousd:nanousd(destination!),authorizationRef:reference!,grantedBy:'cli',now:Date.now()})
    : await store.call('health',{});
  console.log(JSON.stringify(result));
} catch(error) {
  console.error(error instanceof Error?error.message:'Storage operation failed');process.exitCode=1;
} finally {await store?.close();}
