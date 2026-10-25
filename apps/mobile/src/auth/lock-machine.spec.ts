import { LOCKED, RELOCK_AFTER_MS, lockReducer } from './lock-machine';
import type { LockEvent, LockState } from './lock-machine';

const T0 = Date.UTC(2026, 9, 22, 10, 0, 0);
const MIN = 60_000;

const run = (events: LockEvent[], start: LockState = LOCKED): LockState =>
  events.reduce(lockReducer, start);

const unlocked = (): LockState => run([{ type: 'UNLOCKED' }]);

/** Unlocked app goes to the background at T0 and returns `away` ms later. */
const trip = (away: number): LockState =>
  run(
    [
      { type: 'BACKGROUNDED', at: T0 },
      { type: 'FOREGROUNDED', at: T0 + away },
    ],
    unlocked(),
  );

describe('lockReducer', () => {
  describe('cold start', () => {
    it('starts locked, and the shared LOCKED value cannot be mutated', () => {
      expect(LOCKED).toEqual({ status: 'locked' });
      expect(Object.isFrozen(LOCKED)).toBe(true);
    });
  });

  describe('UNLOCKED and LOCK', () => {
    it('UNLOCKED opens the app with no background timestamp', () => {
      expect(unlocked()).toEqual({ status: 'unlocked', backgroundedAt: null });
    });

    it('LOCK from unlocked returns the shared LOCKED value', () => {
      expect(lockReducer(unlocked(), { type: 'LOCK' })).toBe(LOCKED);
    });

    it('LOCK while already locked returns the same object (no re-render)', () => {
      expect(lockReducer(LOCKED, { type: 'LOCK' })).toBe(LOCKED);
    });
  });

  describe('the 5-minute boundary (Decision 2)', () => {
    it('pins the threshold to 5 minutes', () => {
      expect(RELOCK_AFTER_MS).toBe(300_000);
    });

    it.each<[string, number, LockState['status']]>([
      ['0 ms', 0, 'unlocked'],
      ['1 ms', 1, 'unlocked'],
      ['4:59.999', RELOCK_AFTER_MS - 1, 'unlocked'],
      ['exactly 5:00', RELOCK_AFTER_MS, 'locked'],
      ['5:00.001', RELOCK_AFTER_MS + 1, 'locked'],
      ['1 hour', 60 * MIN, 'locked'],
    ])('%s away (%i ms) → %s', (_label, away, expected) => {
      expect(trip(away).status).toBe(expected);
    });
  });

  describe('fails closed on a bad clock', () => {
    it.each<[string, number]>([
      ['clock moved back 1 ms', -1],
      ['NaN timestamp', Number.NaN],
      ['Infinity timestamp', Number.POSITIVE_INFINITY],
    ])('%s → locked', (_label, away) => {
      expect(trip(away)).toBe(LOCKED);
    });
  });

  describe('background bookkeeping', () => {
    it('keeps the FIRST timestamp when BACKGROUNDED fires twice', () => {
      // 6 min from the first event (locks); only 2 min from the second.
      // Both are well clear of the 5:00 boundary, so this test only
      // fails if the first-timestamp rule breaks.
      const state = run(
        [
          { type: 'BACKGROUNDED', at: T0 },
          { type: 'BACKGROUNDED', at: T0 + 4 * MIN },
          { type: 'FOREGROUNDED', at: T0 + 6 * MIN },
        ],
        unlocked(),
      );
      expect(state).toBe(LOCKED);
    });

    it('measures each trip on its own: two 3-minute trips stay unlocked', () => {
      const state = run(
        [
          { type: 'BACKGROUNDED', at: T0 },
          { type: 'FOREGROUNDED', at: T0 + 3 * MIN },
          { type: 'BACKGROUNDED', at: T0 + 10 * MIN },
          { type: 'FOREGROUNDED', at: T0 + 13 * MIN },
        ],
        unlocked(),
      );
      expect(state).toEqual({ status: 'unlocked', backgroundedAt: null });
    });

    it('UNLOCKED clears a stale background timestamp', () => {
      const state = run(
        [
          { type: 'BACKGROUNDED', at: T0 },
          { type: 'UNLOCKED' },
          { type: 'FOREGROUNDED', at: T0 + 10 * MIN },
        ],
        unlocked(),
      );
      expect(state).toEqual({ status: 'unlocked', backgroundedAt: null });
    });

    it('FOREGROUNDED without a prior BACKGROUNDED returns the same object', () => {
      const before = unlocked();
      expect(lockReducer(before, { type: 'FOREGROUNDED', at: T0 })).toBe(before);
    });
  });

  describe('while locked', () => {
    it('ignores BACKGROUNDED and FOREGROUNDED (same object back)', () => {
      expect(lockReducer(LOCKED, { type: 'BACKGROUNDED', at: T0 })).toBe(LOCKED);
      expect(lockReducer(LOCKED, { type: 'FOREGROUNDED', at: T0 + 10 * MIN })).toBe(LOCKED);
    });
  });
});
