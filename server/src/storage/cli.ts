import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from './Store.js';

const [command,source,destination]=process.argv.slice(2);
let store:Store|undefined;
try {
  if (!source || !['init','health','backup','restore'].includes(command) || (['backup','restore'].includes(command) && !destination)) {
    throw new Error('Usage: storage init DATABASE | storage health DATABASE | storage backup DATABASE NEW_BACKUP | storage restore BACKUP NEW_DATABASE');
  }
  if (command !== 'init' && !existsSync(source)) throw new Error('Source database does not exist. Check its path; init is the explicit new-database command.');
  store=command==='health' || command==='backup' ? await Store.inspect(resolve(source))
    : await Store.open(resolve(command==='restore'?destination!:source),command==='restore'?resolve(source):undefined);
  const result=command==='backup'?await store.call('backup',{destination:resolve(destination!)}):await store.call('health',{});
  console.log(JSON.stringify(result));
} catch(error) {
  console.error(error instanceof Error?error.message:'Storage operation failed');process.exitCode=1;
} finally {await store?.close();}
