import { Store } from '../../storage/Store.js';
import { AttemptService, offlineDecisions } from '../../attempts/AttemptService.js';
import { PhaseRules } from '../../attempts/PhaseRules.js';
const [path,stage] = process.argv.slice(2);
const store = await Store.open(path), rules = new PhaseRules();
const attempt = (await store.call('activeAttempts',{}))[0];
const definition = (await store.call('challenge',{id:attempt.challengeId,version:attempt.challengeVersion}))!.definition;
const action = {phase:'ORDERS' as const,orderIds:(await rules.legal(attempt.board,definition.humanPower,new AbortController().signal)).filter(o => o.order.type === 'HOLD').map(o => o.id)};
const service = new AttemptService(store,offlineDecisions(rules),rules,{boundary:async point => {if(point===stage)process.kill(process.pid,'SIGKILL');}});
await service.submit({attemptId:attempt.id,playerId:attempt.playerId,revision:attempt.revision,phaseId:attempt.phaseId,requestId:'crash-request',action});
await service.wait(attempt.id);
await service.close();await store.close();
process.exit(24); // The requested crash boundary must have been reached.
