import {
  decideRefresh,
  REFRESH_REUSE_GRACE_MS,
  StoredRefreshToken,
} from './refresh-decision';

/** A fixed clock. Every timestamp below is an offset from it. */
const NOW = new Date('2026-10-05T10:00:00.000Z');
const SECOND = 1_000;
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

/**
 * A live, unused token in a live session, unless told otherwise. Each test
 * overrides only the field it is about, so the line that differs from this
 * default IS the scenario.
 */
function token(
  overrides: {
    expiresAt?: Date;
    usedAt?: Date | null;
    sessionExpiresAt?: Date;
    revokedAt?: Date | null;
  } = {},
): StoredRefreshToken {
  return {
    expiresAt: overrides.expiresAt ?? at(7 * DAY),
    usedAt: overrides.usedAt ?? null,
    session: {
      expiresAt: overrides.sessionExpiresAt ?? at(30 * DAY),
      revokedAt: overrides.revokedAt ?? null,
    },
  };
}

describe('decideRefresh', () => {
  describe('the happy path', () => {
    it('rotates a live, unused token', () => {
      expect(decideRefresh(token(), NOW)).toEqual({ action: 'rotate' });
    });
  });

  describe('rejections that are not evidence of theft', () => {
    it('rejects a token the database has never seen', () => {
      expect(decideRefresh(null, NOW)).toEqual({ action: 'reject', reason: 'unknown' });
    });

    it('rejects a token whose session was revoked', () => {
      expect(decideRefresh(token({ revokedAt: at(-DAY) }), NOW)).toEqual({
        action: 'reject',
        reason: 'revoked',
      });
    });

    it('rejects an expired token', () => {
      expect(decideRefresh(token({ expiresAt: at(-1) }), NOW)).toEqual({
        action: 'reject',
        reason: 'expired',
      });
    });

    it('treats expiry as exclusive: expiresAt equal to now is already expired', () => {
      expect(decideRefresh(token({ expiresAt: NOW }), NOW)).toEqual({
        action: 'reject',
        reason: 'expired',
      });
    });

    it('rejects a fresh token once its session passes the 30-day absolute cap', () => {
      // The token itself has days left. The session does not. Rotation must
      // never be a way to outlive the cap.
      expect(decideRefresh(token({ sessionExpiresAt: at(-1) }), NOW)).toEqual({
        action: 'reject',
        reason: 'expired',
      });
    });
  });

  describe('the grace window (concurrent requests from one client)', () => {
    it('issues a sibling for a token used a millisecond ago', () => {
      expect(decideRefresh(token({ usedAt: at(-1) }), NOW)).toEqual({ action: 'grace' });
    });

    it('still grants grace at exactly the edge of the window', () => {
      // The comparison is `>`, so a token used exactly REFRESH_REUSE_GRACE_MS
      // ago is inside. Written against the constant, not a literal 10_000:
      // this test pins WHERE the edge sits relative to the window, whatever
      // the window is.
      expect(decideRefresh(token({ usedAt: at(-REFRESH_REUSE_GRACE_MS) }), NOW)).toEqual({
        action: 'grace',
      });
    });

    it('never extends a session past its cap, even inside the window', () => {
      expect(
        decideRefresh(token({ usedAt: at(-SECOND), sessionExpiresAt: at(-1) }), NOW),
      ).toEqual({ action: 'reject', reason: 'expired' });
    });
  });

  describe('reuse (a replay outside the window)', () => {
    it('treats a token used one millisecond past the window as reused', () => {
      expect(
        decideRefresh(token({ usedAt: at(-(REFRESH_REUSE_GRACE_MS + 1)) }), NOW),
      ).toEqual({ action: 'reuse' });
    });
  });

  describe('precedence — where the order of the checks is the behaviour', () => {
    it('reports a revoked session as revoked, not as reuse', () => {
      // Used long ago AND revoked: the session is already dead, so there is
      // nothing to revoke and no reason to log a security event.
      expect(
        decideRefresh(token({ usedAt: at(-DAY), revokedAt: at(-DAY) }), NOW),
      ).toEqual({ action: 'reject', reason: 'revoked' });
    });

    it('reports a replayed EXPIRED token as reuse, not as expired', () => {
      // Rotated eight days ago, so it is both used and past its 7-day expiry.
      // Someone still holds it and is presenting it: that is a leak, and the
      // session may still be alive on a newer token. Expiry-first would
      // answer 'expired' and the leak would never be acted on.
      expect(
        decideRefresh(token({ usedAt: at(-8 * DAY), expiresAt: at(-DAY) }), NOW),
      ).toEqual({ action: 'reuse' });
    });
  });
});
