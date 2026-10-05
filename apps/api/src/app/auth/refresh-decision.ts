/**
 * What to do with a presented refresh token. Pure: a function of the stored
 * row and the clock, so every branch and boundary is unit-testable without a
 * database. AuthService does the I/O; this decides.
 *
 * Deciding is not the same as acting. Two concurrent requests can both read
 * `usedAt: null` and both be told 'rotate'; the conditional UPDATE in
 * AuthService lets exactly one of them win. The loser re-reads the row and
 * asks again, and with `usedAt` now set it gets 'grace' — never a second
 * 'rotate'. This function says what should happen; the database guarantees
 * it happens at most once.
 */

/**
 * How long a just-rotated token may be presented again without being treated
 * as stolen.
 *
 * WHY THIS EXISTS: the web app refreshes inside Next's proxy, which runs once
 * per request. When the 15-minute access cookie expires, one navigation fires
 * several requests at once (page, RSC payloads, prefetches), all carrying the
 * SAME refresh token. Without a window, the first rotates it and every other
 * one looks like a replay — revoking the session and logging the user out
 * every fifteen minutes, by their own browser.
 *
 * WHY 10 SECONDS: one page's parallel requests arrive within milliseconds;
 * even after a Render cold start, the queued requests are processed together
 * once the process boots. 10s covers that with a wide margin while keeping a
 * replay minutes later firmly in 'reuse'.
 *
 * THE COST, stated rather than hidden: a stolen token replayed inside these
 * 10 seconds gets a fresh token instead of revoking the session. That is the
 * standard trade (Auth0 "reuse interval", Okta "grace period"). Mobile does
 * not rely on it — its client refreshes single-flight and never presents a
 * token twice.
 */
export const REFRESH_REUSE_GRACE_MS = 10_000;

/** The stored state the decision needs: a token row joined to its session. */
export interface StoredRefreshToken {
  expiresAt: Date;
  usedAt: Date | null;
  session: {
    expiresAt: Date;
    revokedAt: Date | null;
  };
}

export type RefreshDecision =
  /** Unused, live: mark it used and issue its successor. */
  | { action: 'rotate' }
  /** Used moments ago (concurrent request): issue a sibling, revoke nothing. */
  | { action: 'grace' }
  /** Used outside the window: a replay. Revoke the whole session. */
  | { action: 'reuse' }
  /** Not usable, and not evidence of theft. */
  | { action: 'reject'; reason: 'unknown' | 'revoked' | 'expired' };

/**
 * ORDER IS THE SPECIFICATION. Each check is placed where it is on purpose;
 * the spec pins every boundary and the precedence between neighbours.
 */
export function decideRefresh(
  token: StoredRefreshToken | null,
  now: Date,
): RefreshDecision {
  if (token === null) {
    return { action: 'reject', reason: 'unknown' };
  }

  // A dead session stays dead. Re-revoking would change nothing, and calling
  // it 'reuse' would put noise in the security log.
  if (token.session.revokedAt !== null) {
    return { action: 'reject', reason: 'revoked' };
  }

  // Reuse is checked BEFORE expiry: a replayed old token is evidence of a
  // leak even after it expires, and the session it belonged to may still be
  // alive on a newer token. Checking expiry first would turn that signal
  // into a quiet 'expired'.
  if (token.usedAt !== null && now.getTime() - token.usedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
    return { action: 'reuse' };
  }

  // Expiry is exclusive: a token whose expiresAt equals now is expired. The
  // session's absolute cap applies to grace too — the window must never
  // extend a session past its 30 days.
  if (token.expiresAt.getTime() <= now.getTime() || token.session.expiresAt.getTime() <= now.getTime()) {
    return { action: 'reject', reason: 'expired' };
  }

  if (token.usedAt !== null) {
    return { action: 'grace' };
  }

  return { action: 'rotate' };
}
