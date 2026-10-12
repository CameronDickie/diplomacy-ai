import type { Power, PublicPhaseReport, TerritoryId } from '@diplomacy/shared';

export interface ChallengeDefinition {
  id: string;
  version: number;
  title: string;
  objectiveText: string;
  variant: 'CLASSICAL';
  startingPosition: { fixtureId: string; version: number };
  rulesEngine: 'godip@v0.6.5';
  humanPower: Power;
  opponentPowers: readonly Power[];
  opponentPolicy: 'SPONSORED_LUNA_UNRANKED';
  objective: {
    kind: 'OWN_SUPPLY_CENTER_AFTER_FALL';
    territory: TerritoryId;
    deadlineYear: number;
  };
  earlyAchievementYear: number;
  rotation: 'PILOT_ONLY';
  tiePolicy: 'NOT_POSSIBLE_SINGLE_OWNER';
  /**
   * Development only: a full game with no human player. Every power, including the nominal
   * `humanPower` seat, is listed in `opponentPowers` and decided by a model; the objective's
   * territory is ignored and the game runs to the deadline year or a solo win. Registered only by
   * the autoplay CLI, never by the challenge catalog.
   */
  autoplay?: true;
}

/** An authored pilot, not yet a daily rotation or a validated difficulty level. */
export const TUNIS_PILOT_V1: ChallengeDefinition = {
  id: 'tunis-expedition',
  version: 1,
  title: 'Tunis expedition',
  objectiveText: 'As Turkey, own Tunis after Fall 1903 or sooner.',
  variant: 'CLASSICAL',
  startingPosition: { fixtureId: 'tunis-expedition', version: 1 },
  rulesEngine: 'godip@v0.6.5',
  humanPower: 'TURKEY',
  opponentPowers: ['AUSTRIA', 'ENGLAND', 'FRANCE', 'GERMANY', 'ITALY', 'RUSSIA'],
  opponentPolicy: 'SPONSORED_LUNA_UNRANKED',
  objective: {
    kind: 'OWN_SUPPLY_CENTER_AFTER_FALL',
    territory: 'TUN',
    deadlineYear: 1903,
  },
  earlyAchievementYear: 1902,
  rotation: 'PILOT_ONLY',
  tiePolicy: 'NOT_POSSIBLE_SINGLE_OWNER',
};

export interface ChallengeAttemptRecord {
  challengeId: string;
  challengeVersion: number;
  lifecycle: 'ACTIVE' | 'ABANDONED' | 'GAME_FINISHED';
  /** Server-recorded reports in sequence order; clients must not author these. */
  reports: readonly PublicPhaseReport[];
}

export interface ChallengeScore {
  outcome: 'INCOMPLETE' | 'SUCCESS' | 'FAILURE' | 'ABANDONED';
  reason: 'AWAITING_FALL_RESULT' | 'OBJECTIVE_MET' | 'DEADLINE' | 'GAME_FINISHED' | 'PLAYER_ABANDONED';
  completedYear: number | null;
  achievementIds: readonly string[];
  tie: 'NOT_POSSIBLE';
}

/** Score only settled Fall ownership, after any retreat phase has finished. */
export function scoreChallenge(
  definition: ChallengeDefinition,
  attempt: ChallengeAttemptRecord
): ChallengeScore {
  if (attempt.challengeId !== definition.id || attempt.challengeVersion !== definition.version) {
    throw new Error('Challenge id/version does not match the saved attempt');
  }

  const settledFalls = attempt.reports
    .filter(report => report.season === 'FALL' && (
      report.phase === 'RETREATS' ||
      (report.phase === 'ORDERS' && report.dislodgedUnits.length === 0)
    ))
    .sort((left, right) => left.sequence - right.sequence);

  for (const report of settledFalls) {
    if (report.year > definition.objective.deadlineYear) break;
    // A full game has nothing to capture: it simply ends once its last Fall has settled.
    if (definition.autoplay) {
      if (report.year === definition.objective.deadlineYear) return { outcome: 'SUCCESS', reason: 'DEADLINE', completedYear: report.year, achievementIds: [], tie: 'NOT_POSSIBLE' };
      continue;
    }
    if (report.after.territoryOwners[definition.objective.territory] === definition.humanPower) {
      return {
        outcome: 'SUCCESS',
        reason: 'OBJECTIVE_MET',
        completedYear: report.year,
        achievementIds: report.year <= definition.earlyAchievementYear
          ? ['EARLY_CAPTURE'] : [],
        tie: 'NOT_POSSIBLE',
      };
    }
    if (report.year === definition.objective.deadlineYear) {
      return {
        outcome: 'FAILURE',
        reason: 'DEADLINE',
        completedYear: report.year,
        achievementIds: [],
        tie: 'NOT_POSSIBLE',
      };
    }
  }

  if (attempt.lifecycle === 'ABANDONED') {
    return {
      outcome: 'ABANDONED', reason: 'PLAYER_ABANDONED', completedYear: null,
      achievementIds: [], tie: 'NOT_POSSIBLE',
    };
  }
  // In a full game a solo win is how the game is meant to end, not a failed objective.
  if (attempt.lifecycle === 'GAME_FINISHED' && definition.autoplay) return { outcome: 'SUCCESS', reason: 'GAME_FINISHED', completedYear: settledFalls.at(-1)?.year ?? null, achievementIds: [], tie: 'NOT_POSSIBLE' };
  if (attempt.lifecycle === 'GAME_FINISHED') {
    return {
      outcome: 'FAILURE', reason: 'GAME_FINISHED', completedYear: null,
      achievementIds: [], tie: 'NOT_POSSIBLE',
    };
  }
  return {
    outcome: 'INCOMPLETE', reason: 'AWAITING_FALL_RESULT', completedYear: null,
    achievementIds: [], tie: 'NOT_POSSIBLE',
  };
}

/** Human-readable outcome text for the future challenge UI and offline review. */
export function describeChallengeScore(
  definition: ChallengeDefinition,
  score: ChallengeScore
): string {
  switch (score.reason) {
    case 'OBJECTIVE_MET':
      return `Tunis secured after Fall ${score.completedYear}. ${
        score.achievementIds.includes('EARLY_CAPTURE') ? 'Early capture achieved.' : 'Objective complete.'
      }`;
    case 'DEADLINE':
      return `Challenge failed: Turkey did not own Tunis after Fall ${definition.objective.deadlineYear}.`;
    case 'GAME_FINISHED':
      return 'Challenge failed: the game ended before the objective was met.';
    case 'PLAYER_ABANDONED':
      return 'Challenge abandoned without a result or achievement.';
    case 'AWAITING_FALL_RESULT':
      return `Challenge in progress: ${definition.objectiveText}`;
  }
}
