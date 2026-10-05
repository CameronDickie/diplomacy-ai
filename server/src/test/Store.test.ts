import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ALL_POWERS } from '@diplomacy/shared';
import { Store, hashToken, newToken } from '../storage/Store.js';
import { canonicalJson, exportBoard } from '../fixtures/BoardFixture.js';
import { importScenario, challengeDefinition } from '../fixtures/ScenarioFixture.js';
import { GameRoom } from '../GameRoom.js';
import type { StoredReceipt } from '../storage/contracts.js';

const now = 1_800_000_000_000;
const fixture = () => JSON.parse(readFileSync(new URL('../../fixtures/development/tunis-expedition.v1.json', import.meta.url),'utf8'));
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
async function seed(store: Store) {
  const scenario = await importScenario(fixture());
  const definition = challengeDefinition(scenario)!;
  const player = await store.call('identity',{provider:'github',subject:'test-owner',displayName:'Test owner',now});
  const content={definition,board:scenario.board};
  await store.call('registerChallenge',{...content,hash:hash(content),now});
  const attempt=await store.call('createAttempt',{id:'durable-attempt',playerId:player.id,challengeId:definition.id,challengeVersion:definition.version,now,reconnectTokenHash:hashToken(newToken())});
  return {player,attempt,scenario,definition};
}
function temporary() {
  const directory=mkdtempSync(resolve(tmpdir(),'diplomacy-store-'));
  return {directory,path:resolve(directory,'data','game.sqlite'),remove:()=>rmSync(directory,{recursive:true,force:true})};
}

test('SQLite migrations, provider identities and hashed revocable sessions survive reopening', async () => {
  const tmp=temporary();let store=await Store.open(tmp.path);
  try {
    assert.deepEqual(await store.call('health',{}),{schemaVersion:2,journalMode:'wal'});
    const github=await store.call('identity',{provider:'github',subject:'123',displayName:'Same display name',now});
    const google=await store.call('identity',{provider:'google',subject:'123',displayName:'Same display name',now});
    assert.notEqual(github.id,google.id,'no name/email-based linking across providers');
    const token=newToken();
    await store.call('createSession',{tokenHash:hashToken(token),playerId:github.id,now,expiresAt:now+10000});
    await store.close();store=await Store.open(tmp.path);
    const same=await store.call('identity',{provider:'github',subject:'123',displayName:'Updated name',now:now+1});
    assert.equal(same.id,github.id);
    assert.equal((await store.call('session',{tokenHash:hashToken(token),now:now+1}))?.player.id,github.id);
    assert.equal(await store.call('session',{tokenHash:hashToken(token),now:now+10000}),null);
    assert.ok(!readFileSync(tmp.path).includes(Buffer.from(token)));
    assert.equal(statSync(tmp.path).mode & 0o777,0o600);
    await store.call('revokeSession',{tokenHash:hashToken(token),now:now+2});
    assert.equal(await store.call('session',{tokenHash:hashToken(token),now:now+3}),null);
    const next=newToken();await store.call('createSession',{tokenHash:hashToken(next),playerId:github.id,now:now+4,expiresAt:now+5000});
    await store.call('banPlayer',{playerId:github.id,banned:true,now:now+5});
    assert.equal(await store.call('session',{tokenHash:hashToken(next),now:now+6}),null);
    await assert.rejects(store.call('createSession',{tokenHash:hashToken(newToken()),playerId:github.id,now:now+6,expiresAt:now+5000}),{code:'STORE_FORBIDDEN'});
    await store.call('banPlayer',{playerId:github.id,banned:false,now:now+7});
    assert.equal(await store.call('session',{tokenHash:hashToken(next),now:now+8}),null,'unban never revives revoked sessions');
  } finally {await store.close();tmp.remove();}
});

test('attempt checkpoints atomically restore board, pinned objective, reports and duplicate receipts', async () => {
  const tmp=temporary();let store=await Store.open(tmp.path);
  const {player,attempt,scenario,definition}=await seed(store);
  const room=await GameRoom.fromBoardFixture(scenario.board);
  try {
    for(const power of ALL_POWERS)room.addPlayer(power,power,power);
    await room.startGame();
    const receipt:StoredReceipt={attemptId:attempt.id,playerId:player.id,fingerprint:hash('command'),createdAt:now+1,state:{phaseId:attempt.phaseId,requestId:'request-1',status:'SUBMITTING',error:null}};
    await store.call('recordReceipt',receipt);
    assert.deepEqual(await store.call('recordReceipt',{...receipt,createdAt:now+2}),receipt);
    await assert.rejects(store.call('recordReceipt',{...receipt,fingerprint:hash('different command')}),{code:'STORE_CONFLICT'});
    for(const power of ALL_POWERS)await room.submitOrders(power,[]);
    const reports=room.getPhaseHistory();
    (reports[0] as unknown as Record<string,unknown>).privateChat='must-not-persist';
    const checkpoint={id:attempt.id,expectedRevision:0,expectedPhaseId:attempt.phaseId,board:exportBoard(room.getState()),execution:'ACCEPTING' as const,lifecycle:'ACTIVE' as const,reports,receipt:{...receipt,state:{...receipt.state,status:'ACCEPTED' as const}},now:now+3};
    const badBoard=structuredClone(checkpoint.board);badBoard.units.pop();
    await assert.rejects(store.call('checkpoint',{...checkpoint,board:badBoard}),{code:'STORE_CONFLICT'});
    assert.equal((await store.call('reports',{attemptId:attempt.id})).length,0,'report insert rolled back');
    assert.equal((await store.call('receipt',{attemptId:attempt.id,playerId:player.id,requestId:'request-1'}))?.state.status,'SUBMITTING');
    const saved=await store.call('checkpoint',checkpoint);
    assert.equal(saved.revision,1);assert.equal(saved.board.season,'FALL');
    assert.equal(saved.lastActivityAt,now+1,'AI/checkpoint work does not refresh player idle time');
    await assert.rejects(store.call('checkpoint',checkpoint),{code:'STORE_CONFLICT'});
    await store.close();store=await Store.open(tmp.path);
    assert.deepEqual(await store.call('attempt',{id:attempt.id,playerId:player.id}),saved);
    assert.equal(await store.call('attempt',{id:attempt.id,playerId:'another-player'}),null);
    assert.equal((await store.call('activeAttempts',{}))[0].id,attempt.id);
    assert.equal((await store.call('receipt',{attemptId:attempt.id,playerId:player.id,requestId:'request-1'}))?.state.status,'ACCEPTED');
    const publicHistory=await store.call('reports',{attemptId:attempt.id});
    assert.ok(!JSON.stringify(publicHistory).includes('must-not-persist'));
    assert.ok(!JSON.stringify(saved).includes('token'));
    assert.deepEqual((await store.call('challenge',{id:definition.id,version:1}))?.definition,definition);
    const altered={...definition,title:'Changed in place'};
    await assert.rejects(store.call('registerChallenge',{definition:altered,board:scenario.board,hash:hash({definition:altered,board:scenario.board}),now}),{code:'STORE_CONFLICT'});
    const v2={...definition,version:2,startingPosition:{fixtureId:definition.id,version:2},title:'Version two'};
    await store.call('registerChallenge',{definition:v2,board:scenario.board,hash:hash({definition:v2,board:scenario.board}),now});
    assert.equal((await store.call('attempt',{id:attempt.id}))?.challengeVersion,1);
    const terminal=await store.call('checkpoint',{id:attempt.id,expectedRevision:1,expectedPhaseId:saved.phaseId,board:saved.board,execution:'IDLE',lifecycle:'ABANDONED',reports:[],now:now+4});
    assert.equal(terminal.score?.outcome,'ABANDONED');
    await assert.rejects(store.call('checkpoint',{id:attempt.id,expectedRevision:2,expectedPhaseId:saved.phaseId,board:saved.board,execution:'ACCEPTING',lifecycle:'ACTIVE',reports:[],now:now+5}),{code:'STORE_CONFLICT'});
  } finally {room.dispose();await store.close();tmp.remove();}
});

test('backup and restore use new protected files and preserve authoritative state', async () => {
  const tmp=temporary();const store=await Store.open(tmp.path);let restored:Store|undefined;
  try {
    const {attempt}=await seed(store);
    const destination=resolve(tmp.directory,'backup.sqlite');
    const inspection=await Store.inspect(tmp.path);
    try {
      assert.ok((await inspection.call('backup',{destination})).pages>0);
      await assert.rejects(inspection.call('identity',{provider:'github',subject:'test-owner',displayName:'Should not change',now}),{code:'STORE_UNAVAILABLE'});
    } finally {await inspection.close();}
    assert.equal(statSync(destination).mode & 0o777,0o600);
    await assert.rejects(store.call('backup',{destination}));
    const restoredPath=resolve(tmp.directory,'restored.sqlite');
    restored=await Store.open(restoredPath,destination);
    assert.deepEqual(await restored.call('attempt',{id:attempt.id}),attempt);
    await assert.rejects(Store.open(restoredPath,destination),'restore must not overwrite an existing database');
  } finally {await restored?.close();await store.close();tmp.remove();}
});

test('unknown migration history and invalid storage files fail closed', async () => {
  const tmp=temporary();const store=await Store.open(tmp.path);await store.close();
  try {
    const db=new DatabaseSync(tmp.path);
    db.prepare('UPDATE schema_migrations SET checksum=?').run('not-the-shipped-migration');db.close();
    await assert.rejects(Store.open(tmp.path),{code:'STORE_SCHEMA'});
    const invalid=resolve(tmp.directory,'invalid.sqlite');writeFileSync(invalid,'not a SQLite database');
    await assert.rejects(Store.open(invalid),{code:'STORE_UNAVAILABLE'});
    const empty=resolve(tmp.directory,'empty.sqlite');new DatabaseSync(empty).close();
    await assert.rejects(Store.open(resolve(tmp.directory,'from-empty.sqlite'),empty),{code:'STORE_SCHEMA'});
  } finally {tmp.remove();}
});

test('database write contention leaves HTTP responsive and the RPC queue bounded', async () => {
  const tmp=temporary();const store=await Store.open(tmp.path);const locker=new DatabaseSync(tmp.path);
  const http=createServer((_req,res)=>res.end('healthy'));http.listen(0,'127.0.0.1');await once(http,'listening');
  try {
    locker.exec('BEGIN IMMEDIATE');
    const write=assert.rejects(store.call('identity',{provider:'github',subject:'locked',displayName:'Locked write',now}),{code:'STORE_BUSY'});
    const queue=Promise.allSettled(Array.from({length:70},()=>store.call('health',{})));
    const address=http.address();assert.ok(address && typeof address==='object');
    assert.equal(await (await fetch(`http://127.0.0.1:${address.port}`,{signal:AbortSignal.timeout(2000)})).text(),'healthy');
    await write;locker.exec('ROLLBACK');
    const results=await queue;
    assert.ok(results.filter(r=>r.status==='rejected' && r.reason.code==='STORE_BUSY').length>=7);
    assert.equal((await store.call('health',{})).schemaVersion,2);
  } finally {locker.close();http.close();await store.close();tmp.remove();}
});

test('a committed achievement remains pinned across new definitions and a restart', async () => {
  const tmp=temporary();let store=await Store.open(tmp.path);
  const {scenario,player,definition}=await seed(store);
  const room=await GameRoom.fromBoardFixture(scenario.board);
  try {
    for(const power of ALL_POWERS)room.addPlayer(power,power,power);
    await room.startGame();
    let saved=(await store.call('attempt',{id:'durable-attempt'}))!;
    for(const step of scenario.witnesses.find(w=>w.name==='early-capture')!.steps) {
      assert.equal(step.phase,'ORDERS');if(step.phase!=='ORDERS')throw Error('unexpected witness');
      const catalog=(await Promise.all(ALL_POWERS.map(power=>room.getLegalOrders(power)))).flat();
      const orders=step.orders.map(id=>catalog.find(o=>o.id===id)!.order);
      for(const power of ALL_POWERS)await room.submitOrders(power,orders.filter(o=>o.power===power));
      saved=await store.call('checkpoint',{id:saved.id,expectedRevision:saved.revision,expectedPhaseId:saved.phaseId,board:exportBoard(room.getState()),execution:'ACCEPTING',lifecycle:'ACTIVE',reports:room.getPhaseHistory().slice(-1),now:now+10});
    }
    assert.equal(saved.lifecycle,'COMPLETED');assert.equal(saved.score?.outcome,'SUCCESS');assert.deepEqual(saved.score?.achievementIds,['EARLY_CAPTURE']);
    const revised={...definition,version:2,startingPosition:{fixtureId:definition.id,version:2},earlyAchievementYear:1901};
    await store.call('registerChallenge',{definition:revised,board:scenario.board,hash:hash({definition:revised,board:scenario.board}),now});
    await store.close();store=await Store.open(tmp.path);
    assert.deepEqual(await store.call('attempt',{id:saved.id,playerId:player.id}),saved);
    await assert.rejects(store.call('checkpoint',{id:saved.id,expectedRevision:saved.revision,expectedPhaseId:saved.phaseId,board:saved.board,execution:'ACCEPTING',lifecycle:'ACTIVE',reports:[],now:now+11}),{code:'STORE_CONFLICT'});
  } finally {room.dispose();await store.close();tmp.remove();}
});

test('ban atomically stops active attempts and fences later writes', async () => {
  const tmp=temporary();const store=await Store.open(tmp.path);
  try {
    const {attempt,player}=await seed(store);
    await store.call('banPlayer',{playerId:player.id,banned:true,now:now+1});
    const stopped=(await store.call('attempt',{id:attempt.id}))!;
    assert.equal(stopped.lifecycle,'STOPPED');assert.equal(stopped.revision,1);
    await assert.rejects(store.call('checkpoint',{id:attempt.id,expectedRevision:0,expectedPhaseId:attempt.phaseId,board:attempt.board,execution:'ACCEPTING',lifecycle:'ACTIVE',reports:[],now:now+2}),{code:'STORE_CONFLICT'});
  } finally {await store.close();tmp.remove();}
});

test('phase-job migration upgrades a v1 database without changing existing attempts or sessions', async () => {
  const tmp=temporary();let store=await Store.open(tmp.path);
  try {
    const {attempt,player}=await seed(store);
    const tokenHash=hashToken(newToken());await store.call('createSession',{tokenHash,playerId:player.id,now,expiresAt:now+1000});
    await store.close();
    // Restore the exact v1 schema/history while preserving its seeded records.
    const db=new DatabaseSync(tmp.path);
    db.exec('DROP TABLE phase_jobs; DELETE FROM schema_migrations WHERE version=2; PRAGMA user_version=1;');db.close();
    store=await Store.open(tmp.path);
    assert.equal((await store.call('health',{})).schemaVersion,2);
    assert.deepEqual(await store.call('attempt',{id:attempt.id}),attempt);
    assert.equal((await store.call('session',{tokenHash,now}))?.player.id,player.id);
    assert.deepEqual(await store.call('pendingPhaseJobs',{}),[]);
  } finally {await store.close();tmp.remove();}
});
