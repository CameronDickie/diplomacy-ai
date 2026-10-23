import type { DatabaseSync } from 'node:sqlite';
import { ALL_POWERS } from '@diplomacy/shared';
import { canonicalJson } from '../fixtures/BoardFixture.js';
import { EFFORTS } from '../providers/LunaPreset.js';
import { OPPONENT_CONTRACTS, opponentContract } from '../providers/OpponentContract.js';
import { mixedPlan } from '../providers/OpponentPlan.js';
import { StoreError, type AutoplaySettings, type StoreOperations } from './contracts.js';

export class AutoplaySettingsRepository {
  constructor(private db: DatabaseSync) {}

  get(attemptId: string): AutoplaySettings | null {
    if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='autoplay_settings'").get()) return null;
    const row = this.db.prepare('SELECT settings_json FROM autoplay_settings WHERE attempt_id=?').get(attemptId);
    return row ? JSON.parse(String(row.settings_json)) as AutoplaySettings : null;
  }

  save(input: StoreOperations['saveAutoplaySettings']['input']): null {
    const settings = input.settings;
    if (!settings || !settings.assignment || Object.keys(settings.assignment).length !== ALL_POWERS.length
      || ALL_POWERS.some(power => !Object.hasOwn(OPPONENT_CONTRACTS,settings.assignment[power]))
      || !EFFORTS.includes(settings.effort) || !['mock','live'].includes(settings.transport)
      || !Number.isSafeInteger(settings.talkRecipients) || settings.talkRecipients < 0 || settings.talkRecipients > 6
      || !Number.isSafeInteger(input.now) || input.now < 0)
      throw new StoreError('STORE_INVALID','Invalid autoplay settings.');
    const encoded = canonicalJson(settings), old = this.get(input.attemptId);
    if (old) {
      if (canonicalJson(old) !== encoded) throw new StoreError('STORE_CONFLICT','This game has different autoplay settings.');
      return null;
    }
    const attempt = this.db.prepare('SELECT preset_id,pricing_version,challenge_id FROM attempts WHERE id=?').get(input.attemptId);
    const plan = mixedPlan(settings.assignment,opponentContract(settings.assignment.AUSTRIA));
    if (!attempt || !String(attempt.challenge_id).startsWith('full-game-to-') || attempt.preset_id !== plan.id || attempt.pricing_version !== plan.pricingVersion)
      throw new StoreError('STORE_CONFLICT','Autoplay settings do not match this game.');
    this.db.prepare('INSERT INTO autoplay_settings(attempt_id,settings_json,created_at) VALUES(?,?,?)').run(input.attemptId,encoded,input.now);
    return null;
  }
}
