import { isPeriod, PERIODS, resolvePeriod } from './period';

/** 16 Sep 2026, 15:30 IST — mid-month, mid-afternoon, nothing special. */
const MID_SEPTEMBER = new Date('2026-09-16T10:00:00.000Z');

describe('resolvePeriod', () => {
  describe('IST boundaries', () => {
    it('places a transaction just after IST midnight on 1 September in September, not August', () => {
      // 2026-08-31T19:00Z is 2026-09-01T00:30 IST.
      //
      // The direction matters and is easy to get backwards: IST is UTC+05:30,
      // so India's date turns over BEFORE UTC's. The discriminating instant
      // is therefore one that is already September in IST while UTC still
      // reads 31 August — not the reverse, which no instant satisfies. A
      // UTC-based boundary files this transaction under August, and the
      // customer's September statement comes up short.
      const justAfterIstMidnight = new Date('2026-08-31T19:00:00.000Z');

      const august = resolvePeriod('last_month', MID_SEPTEMBER);
      const september = resolvePeriod('this_month', MID_SEPTEMBER);

      // August's exclusive upper bound must already have passed…
      expect(august.to.getTime()).toBeLessThanOrEqual(justAfterIstMidnight.getTime());
      // …and September's inclusive lower bound must already have started.
      expect(september.from!.getTime()).toBeLessThanOrEqual(justAfterIstMidnight.getTime());
    });

    it('starts the year at IST midnight, while UTC still says December', () => {
      // 2025-12-31T19:00Z is 2026-01-01T00:30 IST. India's civil year has
      // rolled over; UTC's has not.
      const newYearIst = new Date('2025-12-31T19:00:00.000Z');
      const thisYear = resolvePeriod('this_year', newYearIst);

      expect(thisYear.label).toBe('2026');
      expect(thisYear.from!.toISOString()).toBe('2025-12-31T18:30:00.000Z');
    });
  });

  describe('month arithmetic', () => {
    it('resolves last_month to August when evaluated on 1 September', () => {
      const firstOfSeptember = new Date('2026-09-01T02:00:00.000Z'); // 07:30 IST
      const result = resolvePeriod('last_month', firstOfSeptember);

      expect(result.from!.toISOString()).toBe('2026-07-31T18:30:00.000Z');
      expect(result.to.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    });

    it('rolls back across a year boundary', () => {
      const january = new Date('2026-01-15T10:00:00.000Z');
      const result = resolvePeriod('last_month', january);

      expect(result.from!.toISOString()).toBe('2025-11-30T18:30:00.000Z');
      expect(result.to.toISOString()).toBe('2025-12-31T18:30:00.000Z');
    });
  });

  describe('interval algebra', () => {
    it('tiles: last_month.to is exactly this_month.from', () => {
      // The half-open property asserted directly. If these two drift apart,
      // a boundary transaction is counted twice or lost, and neither
      // outcome raises anything.
      const last = resolvePeriod('last_month', MID_SEPTEMBER);
      const current = resolvePeriod('this_month', MID_SEPTEMBER);

      expect(last.to.toISOString()).toBe(current.from!.toISOString());
    });

    it('spans exactly 30 IST days, including today', () => {
      const result = resolvePeriod('last_30_days', MID_SEPTEMBER);

      // 16 Sep less 29 days is 18 Aug; IST midnight on 18 Aug is 17 Aug 18:30Z.
      // 14 days in August plus 16 in September is 30.
      expect(result.from!.toISOString()).toBe('2026-08-17T18:30:00.000Z');
      expect(result.to.toISOString()).toBe(MID_SEPTEMBER.toISOString());
    });
  });

  it('gives all_time no lower bound, and null rather than the epoch', () => {
    expect(resolvePeriod('all_time', MID_SEPTEMBER).from).toBeNull();
  });

  it('labels the calendar month rather than saying "last month"', () => {
    // A conversation read back tomorrow must stay auditable. "Last month"
    // has no referent once time moves; "August 2026" does.
    expect(resolvePeriod('last_month', MID_SEPTEMBER).label).toBe('August 2026');
  });
});

describe('isPeriod', () => {
  it('accepts every declared period', () => {
    for (const period of PERIODS) expect(isPeriod(period)).toBe(true);
  });

  it.each(['last_week', 'LAST_MONTH', '', 'lastmonth', null, undefined, 7, {}])(
    'rejects %p',
    (value) => {
      // This guard sits between a model's improvised output and our SQL.
      // Near-misses, wrong case and non-strings all have to fail closed.
      expect(isPeriod(value)).toBe(false);
    },
  );
});
