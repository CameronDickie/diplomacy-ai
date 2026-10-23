import type { DatabaseSync } from 'node:sqlite';
import { ALL_POWERS } from '@diplomacy/shared';
import { parseAction } from '../attempts/actions.js';
import { canonicalJson } from '../fixtures/BoardFixture.js';
import { StoreError, type StoreOperations } from './contracts.js';

export class HumanActionRepository {
  constructor(private db: DatabaseSync) {}

  get(input: StoreOperations['humanAction']['input']): StoreOperations['humanAction']['output'] {
    const row = this.db.prepare('SELECT action_json FROM human_actions WHERE operation_id=? AND power=?').get(input.operationId,input.power);
    return row ? parseAction(JSON.parse(String(row.action_json))) : null;
  }

  save(input: StoreOperations['saveHumanAction']['input']): null {
    if (!ALL_POWERS.includes(input.power) || !Number.isSafeInteger(input.now) || input.now < 0)
      throw new StoreError('STORE_INVALID','Invalid human action.');
    const action = parseAction(input.action), encoded = canonicalJson(action);
    const live = this.db.prepare(`SELECT j.definition_json FROM phase_jobs j JOIN attempts a ON a.id=j.attempt_id
      JOIN players p ON p.id=a.player_id WHERE j.id=? AND j.attempt_id=? AND j.phase_id=? AND a.phase_id=j.phase_id
      AND j.status IN ('DECIDING','RECOVERING') AND a.lifecycle='ACTIVE' AND p.banned_at IS NULL`).get(input.operationId,input.attemptId,input.phaseId);
    if (!live || JSON.parse(String(live.definition_json)).humanPower !== input.power || !JSON.parse(String(live.definition_json)).autoplay)
      throw new StoreError('STORE_CONFLICT','This game is no longer waiting for these orders.');
    const old = this.get(input);
    if (old) {
      if (canonicalJson(old) !== encoded) throw new StoreError('STORE_CONFLICT','Orders were already submitted for this phase.');
      return null;
    }
    this.db.prepare('INSERT INTO human_actions(operation_id,power,action_json,created_at) VALUES(?,?,?,?)')
      .run(input.operationId,input.power,encoded,input.now);
    return null;
  }
}
