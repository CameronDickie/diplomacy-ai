import type { ChallengeCard, ChallengeReplay, PublicBoardSnapshot, PublicPhaseReport, Unit, ResolvedOrder } from '@diplomacy/shared';
import type { ChallengeDefinition } from '../challenge/TunisPilot.js';
import { fixtureSchema as s } from '../fixtures/BoardFixture.js';
import { ALL_POWERS, TERRITORY_MAP } from '@diplomacy/shared';

const unit = (u: Unit): Unit => ({ id:u.id, type:u.type, power:u.power, territory:u.territory, coast:u.coast,
  mustRetreat:u.mustRetreat, retreatOptions:[...u.retreatOptions], retreatCoasts:Object.fromEntries(Object.entries(u.retreatCoasts).filter(([id])=>id in TERRITORY_MAP).map(([id,coasts])=>[id,[...coasts!]])), dislodgedBy:u.dislodgedBy });
export const publicBoard = (board: PublicBoardSnapshot): PublicBoardSnapshot => ({
  units:board.units.map(unit).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),
  territoryOwners:Object.fromEntries(Object.entries(board.territoryOwners).filter(([id,owner])=>id in TERRITORY_MAP&&(owner===null||ALL_POWERS.includes(owner)))),
});
const order = (o: ResolvedOrder): ResolvedOrder => ({ id:o.id, power:o.power, unitTerritory:o.unitTerritory,unitCoast:o.unitCoast,type:o.type,
  targetTerritory:o.targetTerritory,targetCoast:o.targetCoast,supportedUnit:o.supportedUnit,supportedDestination:o.supportedDestination,
  ...(o.viaConvoy ? {viaConvoy:true}:{}),resolution:o.resolution,reason:o.reason });

/** Explicit projection keeps accidental private/session/provider fields out of saved public history. */
export function publicReport(input: PublicPhaseReport): PublicPhaseReport {
  const base={id:input.id,sequence:input.sequence,year:input.year,season:input.season,resolvedAt:input.resolvedAt,before:publicBoard(input.before),after:publicBoard(input.after)};
  if(input.phase==='BUILDS') return {...base,phase:'BUILDS',season:'WINTER',adjustments:input.adjustments.map(a=>({power:a.power,builds:a.builds.map(b=>({type:b.type,territory:b.territory,coast:b.coast})),disbandedUnits:a.disbandedUnits.map(unit),waivedBuilds:a.waivedBuilds}))};
  const ownershipChanges=input.ownershipChanges.map(c=>({territory:c.territory,fromPower:c.fromPower,toPower:c.toPower}));
  if(input.phase==='RETREATS') return {...base,phase:'RETREATS',ownershipChanges,retreats:input.retreats.map(r=>({power:r.power,unitId:r.unitId,unitType:r.unitType,fromTerritory:r.fromTerritory,toTerritory:r.toTerritory,toCoast:r.toCoast,outcome:r.outcome}))};
  if(input.phase!=='ORDERS') throw new Error('Invalid report phase');
  return {...base,phase:'ORDERS',ownershipChanges,resolvedOrders:input.resolvedOrders.map(order),standoffTerritories:[...input.standoffTerritories],dislodgedUnits:input.dislodgedUnits.map(unit),destroyedUnits:input.destroyedUnits.map(unit)};
}

const card = (c: ChallengeCard): ChallengeCard => ({ id:c.id, version:c.version, title:c.title, objectiveText:c.objectiveText, humanPower:c.humanPower, targetTerritory:c.targetTerritory,
  deadlineYear:c.deadlineYear, earlyAchievementYear:c.earlyAchievementYear, label:c.label, mode:c.mode, opponentLabel:c.opponentLabel,
  board:{...publicBoard(c.board),year:c.board.year,season:c.board.season,phase:c.board.phase} });
/** Packages the reference run: room-scoped IDs and wall-clock stamps are replaced so every start serves identical content. */
export function publicReplay(challenge: ChallengeCard, reports: readonly PublicPhaseReport[]): ChallengeReplay {
  return { kind:'REFERENCE', challenge:card(challenge), reports:reports.map((r,i)=>({...publicReport(r),id:`reference-${i+1}`,sequence:i+1,resolvedAt:'1970-01-01T00:00:00.000Z'}) as PublicPhaseReport) };
}

export function parseChallenge(value: unknown): ChallengeDefinition {
  const d=s.fields(value,['id','version','title','objectiveText','variant','startingPosition','rulesEngine','humanPower','opponentPowers','opponentPolicy','objective','earlyAchievementYear','rotation','tiePolicy',...(value&&typeof value==='object'&&Object.hasOwn(value,'autoplay')?['autoplay']:[])],'challenge');
  if(Object.hasOwn(d,'autoplay') && d.autoplay!==true) s.fail('challenge.autoplay','expected true when present');
  for(const field of ['id','title','objectiveText']) if(typeof d[field]!=='string' || !(d[field] as string).trim() || (d[field] as string).length>500) s.fail(`challenge.${field}`,'invalid text');
  if(!Number.isSafeInteger(d.version) || Number(d.version)<1) s.fail('challenge.version','invalid version');
  s.member(d.variant,['CLASSICAL'],'challenge.variant'); s.member(d.rulesEngine,['godip@v0.6.5'],'challenge.rulesEngine');
  s.member(d.opponentPolicy,['SPONSORED_LUNA_UNRANKED'],'challenge.opponentPolicy'); s.member(d.rotation,['PILOT_ONLY'],'challenge.rotation'); s.member(d.tiePolicy,['NOT_POSSIBLE_SINGLE_OWNER'],'challenge.tiePolicy');
  const human=s.member(d.humanPower,ALL_POWERS,'challenge.humanPower');
  const opponents=s.array(d.opponentPowers,'challenge.opponentPowers',7).map(p=>s.member(p,ALL_POWERS,'challenge.opponentPowers'));
  s.unique(opponents,'challenge.opponentPowers');
  // A model-only full game lists all seven; every other scenario lists exactly the six that are not the human.
  if(d.autoplay===true ? opponents.length!==7 : opponents.length!==6 || opponents.includes(human)) s.fail('challenge.opponentPowers',d.autoplay===true?'expected all seven powers':'expected the six other powers');
  const start=s.fields(d.startingPosition,['fixtureId','version'],'challenge.startingPosition');
  if(start.fixtureId!==d.id || start.version!==d.version) s.fail('challenge.startingPosition','fixture id/version must match challenge');
  const objective=s.fields(d.objective,['kind','territory','deadlineYear'],'challenge.objective');
  s.member(objective.kind,['OWN_SUPPLY_CENTER_AFTER_FALL'],'challenge.objective.kind');
  const territory=s.province(objective.territory,'challenge.objective.territory');
  if(!TERRITORY_MAP[territory].isSupplyCenter) s.fail('challenge.objective.territory','expected supply center');
  if(!Number.isSafeInteger(objective.deadlineYear) || Number(objective.deadlineYear)<1 || Number(objective.deadlineYear)>9999 || !Number.isSafeInteger(d.earlyAchievementYear) || Number(d.earlyAchievementYear)<1 || Number(d.earlyAchievementYear)>Number(objective.deadlineYear)) s.fail('challenge.objective','invalid deadline/achievement year');
  return structuredClone(value) as ChallengeDefinition;
}
