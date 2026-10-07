import { fixtureSchema as s } from '../fixtures/BoardFixture.js';

export interface RotationManifest {
  schemaVersion: 1;
  id: string;
  version: number;
  /** UTC date (YYYY-MM-DD) on which the first entry is featured. */
  epochDay: string;
  entries: Array<{ id: string; version: number }>;
}
const DAY = 86_400_000;
const dayNumber = (ms: number): number => Math.floor(ms / DAY);

export function parseRotation(value: unknown): RotationManifest {
  const m = s.fields(value, ['schemaVersion', 'id', 'version', 'epochDay', 'entries'], 'rotation');
  if (m.schemaVersion !== 1) s.fail('rotation.schemaVersion', 'only version 1 is supported');
  if (typeof m.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m.id) || m.id.length > 80) s.fail('rotation.id', 'expected a lowercase slug');
  if (!Number.isSafeInteger(m.version) || Number(m.version) < 1) s.fail('rotation.version', 'invalid version');
  if (typeof m.epochDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.epochDay) || new Date(`${m.epochDay}T00:00:00Z`).toISOString().slice(0, 10) !== m.epochDay) s.fail('rotation.epochDay', 'expected a UTC date');
  const entries = s.array(m.entries, 'rotation.entries', 366).map((input, i) => {
    const e = s.fields(input, ['id', 'version'], `rotation.entries[${i}]`);
    if (typeof e.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(e.id) || !Number.isSafeInteger(e.version) || Number(e.version) < 1) s.fail(`rotation.entries[${i}]`, 'expected a scenario id and version');
    return { id: e.id as string, version: e.version as number };
  });
  if (entries.length < 1) s.fail('rotation.entries', 'expected at least one scenario');
  // One scenario per slot keeps "which day shows what" a bijection within a cycle.
  s.unique(entries.map(e => `${e.id}@${e.version}`), 'rotation.entries');
  return { schemaVersion: 1, id: m.id as string, version: m.version as number, epochDay: m.epochDay as string, entries };
}

/**
 * Pure function of the manifest and the clock: the same instant always features the same pinned
 * scenario version on every server and after every restart. Days before the epoch wrap backwards.
 */
export function featuredSlot(manifest: RotationManifest, now: number): { index: number; day: string; nextChangeAt: number } {
  const today = dayNumber(now), offset = today - dayNumber(Date.parse(`${manifest.epochDay}T00:00:00Z`)), size = manifest.entries.length;
  return { index: ((offset % size) + size) % size, day: new Date(today * DAY).toISOString().slice(0, 10), nextChangeAt: (today + 1) * DAY };
}
