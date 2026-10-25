/**
 * App-lock state machine (Phase 4 Step 2, Decision 2: re-lock after
 * 5 minutes in the background).
 *
 * Pure on purpose: no React, no AppState, no clock. The caller passes
 * timestamps in, which makes the 5-minute boundary testable to the
 * millisecond without fake timers. The AuthProvider (3b) maps AppState
 * changes to these events and feeds them through useReducer.
 *
 * This machine only answers "is the UI locked?". Whether a session exists
 * at all (login vs unlock) is the auth client's job.
 */

export const RELOCK_AFTER_MS = 5 * 60 * 1000;

export type LockState =
  | { readonly status: 'locked' }
  | { readonly status: 'unlocked'; readonly backgroundedAt: number | null };

export type LockEvent =
  | { readonly type: 'UNLOCKED' }
  | { readonly type: 'BACKGROUNDED'; readonly at: number }
  | { readonly type: 'FOREGROUNDED'; readonly at: number }
  | { readonly type: 'LOCK' };

/** Cold start is always locked: an active session still needs unlocking. */
export const LOCKED: LockState = Object.freeze({ status: 'locked' });

export function lockReducer(state: LockState, event: LockEvent): LockState {
  switch (event.type) {
    case 'UNLOCKED':
      return { status: 'unlocked', backgroundedAt: null };

    case 'LOCK':
      return state.status === 'locked' ? state : LOCKED;

    case 'BACKGROUNDED':
      // Ignore while locked; keep the FIRST timestamp if it fires twice.
      if (state.status !== 'unlocked' || state.backgroundedAt !== null) {
        return state;
      }
      return { status: 'unlocked', backgroundedAt: event.at };

    case 'FOREGROUNDED': {
      if (state.status !== 'unlocked' || state.backgroundedAt === null) {
        return state;
      }
      const away = event.at - state.backgroundedAt;
      // Fail closed: a clock that went backwards, or garbage input, locks.
      if (!Number.isFinite(away) || away < 0 || away >= RELOCK_AFTER_MS) {
        return LOCKED;
      }
      return { status: 'unlocked', backgroundedAt: null };
    }

    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}
