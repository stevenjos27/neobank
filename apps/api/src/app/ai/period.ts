/**
 * Named time windows, resolved server-side.
 *
 * WHY AN ENUM AND NOT DATES FROM THE MODEL. This is the same decision as the
 * closed category taxonomy, for the same reason. A model asked for a date
 * range will happily produce one, and it will be plausibly wrong — off by a
 * day at month boundaries, confused about which month "last month" is on the
 * 1st, silently in UTC. Free-form dates from a model are free-form categories
 * with worse consequences, because nothing downstream can detect the error.
 *
 * The model picks a NAME. The server owns the arithmetic.
 */
export const PERIODS = [
  'this_month',
  'last_month',
  'last_30_days',
  'this_year',
  'all_time',
] as const;

export type Period = (typeof PERIODS)[number];

export function isPeriod(value: unknown): value is Period {
  return typeof value === 'string' && (PERIODS as readonly string[]).includes(value);
}

export type ResolvedPeriod = {
  period: Period;
  /**
   * Inclusive lower bound. `null` means unbounded — and it is null rather
   * than the epoch on purpose. "Beginning of time is 1 January 1970" is only
   * safe because our data happens to start in 2026, and that flavour of
   * reasoning is what produced the NULL staleness bug in Step 2. One ternary
   * in the query is cheaper than a type that lies.
   */
  from: Date | null;
  /**
   * EXCLUSIVE upper bound. Half-open `[from, to)` is the only interval form
   * that tiles without gaps or double-counting: `last_month.to` is exactly
   * `this_month.from`, so a transaction at an IST month boundary lands in
   * precisely one window. A closed range either counts it twice or drops it,
   * depending on sub-second precision nobody is looking at.
   */
  to: Date;
  /** For the answer to quote. See the note on why this is not "last month". */
  label: string;
};

/**
 * IST is UTC+05:30 with no daylight saving, and has been since 1945.
 *
 * A hardcoded offset rather than Intl-based zone resolution is a deliberate
 * trade. NeoBank is a single-branch Indian bank with one civil calendar, so
 * this is exact — and the 40 lines of offset inversion the general case needs
 * would be machinery serving a requirement that does not exist.
 *
 * The trigger for replacing it is explicit: the day NeoBank operates in a
 * second timezone, this constant becomes a lookup and the boundary helpers
 * take a zone argument. Not "if it ever seems messy" — a named condition.
 */
const IST_OFFSET_MS = 330 * 60 * 1000;

/** The civil year/month/day an instant falls on, in IST. */
function istCivil(instant: Date) {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(), // 0-based, as Date.UTC expects
    day: shifted.getUTCDate(),
  };
}

/**
 * The UTC instant at which an IST calendar day begins.
 *
 * `Date.UTC` normalises out-of-range components — month -1 rolls back to the
 * previous December, day 0 becomes the last day of the previous month, day
 * -14 walks further back still. That is why `last_month` and `last_30_days`
 * below need no manual month-length or leap-year arithmetic, which is where
 * hand-rolled date code usually goes wrong.
 */
function istStartOfDay(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - IST_OFFSET_MS);
}

const monthFormat = new Intl.DateTimeFormat('en-IN', {
  month: 'long',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});

const dayFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});

export function resolvePeriod(period: Period, now: Date = new Date()): ResolvedPeriod {
  const today = istCivil(now);

  switch (period) {
    case 'this_month': {
      const from = istStartOfDay(today.year, today.month, 1);
      return { period, from, to: now, label: monthFormat.format(from) };
    }

    case 'last_month': {
      const from = istStartOfDay(today.year, today.month - 1, 1);
      const to = istStartOfDay(today.year, today.month, 1);
      return { period, from, to, label: monthFormat.format(from) };
    }

    case 'last_30_days': {
      // `day - 29`, not `day - 30`. Thirty days INCLUDING today: today plus
      // the 29 before it. Using -30 gives 31 days, which is the off-by-one
      // that makes a reported total impossible to reconcile against the
      // ledger. The resolved dates are returned so the answer can state the
      // window rather than rely on this comment being right.
      const from = istStartOfDay(today.year, today.month, today.day - 29);
      return {
        period,
        from,
        to: now,
        label: `${dayFormat.format(from)} to ${dayFormat.format(now)}`,
      };
    }

    case 'this_year': {
      const from = istStartOfDay(today.year, 0, 1);
      return { period, from, to: now, label: String(today.year) };
    }

    case 'all_time':
      return { period, from: null, to: now, label: 'all time' };
  }
}
