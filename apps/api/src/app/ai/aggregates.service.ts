import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TransactionType } from '@neobank/prisma';
import { formatPaise } from '@neobank/utils';
import { PrismaService } from '../../prisma/prisma.service';
import { Period, ResolvedPeriod, resolvePeriod } from './period';

/**
 * Every transaction type, classified as money in or money out.
 *
 * A `Record<TransactionType, …>` rather than an array of debit types, because
 * this is exhaustive AT COMPILE TIME: add a fifth member to the Prisma enum
 * and this object stops type-checking until someone decides which direction
 * it points. A hand-maintained `['WITHDRAWAL', 'TRANSFER_OUT']` would keep
 * compiling happily and quietly stop counting the new type as spend.
 *
 * That choice matters more than it looks. The alternative failure — a
 * blacklist, `NOT IN ('DEPOSIT','TRANSFER_IN')` — silently counts any new
 * CREDIT type as spending. Both defaults are wrong; the fix is to make the
 * compiler refuse the question rather than answer it badly. Same reasoning as
 * the web app's `isCredit`, one level stricter.
 */
const DIRECTION: Record<TransactionType, 'in' | 'out'> = {
  DEPOSIT: 'in',
  TRANSFER_IN: 'in',
  WITHDRAWAL: 'out',
  TRANSFER_OUT: 'out',
};

const DEBIT_TYPES = (Object.keys(DIRECTION) as TransactionType[]).filter(
  (type) => DIRECTION[type] === 'out',
);

export type CategoryTotal = {
  /** `null` means the categoriser produced no verdict — NOT the `Other` category. */
  category: string | null;
  totalPaise: string;
  /** Pre-formatted for the assistant to quote verbatim. */
  total: string;
  count: number;
};

export type SpendByCategoryResult = {
  period: Period;
  periodLabel: string;
  from: string | null;
  to: string;
  currency: 'INR';
  categories: CategoryTotal[];
  totalPaise: string;
  total: string;
  /**
   * Surfaced deliberately. If some transactions have no category, the
   * per-category figures do not add up to what the customer actually spent,
   * and an assistant that reports the breakdown without saying so has given
   * a number that is quietly short. Step 4 must disclose this.
   */
  uncategorisedCount: number;
};

/**
 * The raw row shape Postgres returns. Deliberately NOT exported and
 * deliberately not the same type as `CategoryTotal`: this is what the wire
 * hands back, that is what we promise callers. Collapsing the two would let
 * a column rename ripple straight into the public contract.
 */
type CategoryRow = {
  category: string | null;
  totalPaise: string;
  count: number;
};

@Injectable()
export class AggregatesService {
  private readonly logger = new Logger(AggregatesService.name);

  constructor(private readonly prisma: PrismaService) { }

  /**
   * Spending grouped by category, for one customer, over one window.
   *
   * THE SCOPING RULE, and it is the most important line in this file:
   * `userId` is a PARAMETER OF THIS METHOD, supplied from the authenticated
   * JWT by the caller. It is never a tool argument the model can fill. The
   * model chooses WHICH tool and WHICH period; it can express no opinion
   * about WHOSE money. Any design where a user id can travel from a prompt
   * into this query is an account-enumeration hole with a feature's name on
   * it — and it would look completely normal in review.
   */
  async spendByCategory(
    userId: string,
    period: Period,
    now: Date = new Date(),
  ): Promise<SpendByCategoryResult> {
    const window = resolvePeriod(period, now);

    // Prisma.empty rather than a nullable bound in SQL. `(${from} IS NULL OR
    // createdAt >= ${from})` needs an explicit cast to survive a null
    // parameter and reads worse; omitting the clause entirely is what
    // "unbounded" actually means.
    const lowerBound = window.from
      ? Prisma.sql`AND t."createdAt" >= ${window.from}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<CategoryRow[]>`
      SELECT
        e.category                    AS category,
        SUM(t."amountPaise")::text    AS "totalPaise",
        COUNT(*)::int                 AS count
      FROM "Transaction" t
      JOIN "Account" a ON a.id = t."accountId"
      LEFT JOIN "TransactionEnrichment" e ON e."transactionId" = t.id
      WHERE a."userId" = ${userId}
        AND t.type::text IN (${Prisma.join(DEBIT_TYPES)})
        ${lowerBound}
        AND t."createdAt" < ${window.to}
      GROUP BY e.category
      ORDER BY SUM(t."amountPaise") DESC
    `;

    const totalPaise = rows.reduce((sum, row) => sum + BigInt(row.totalPaise), 0n);
    const uncategorisedCount = rows.find((row) => row.category === null)?.count ?? 0;

    this.logger.debug(
      `spendByCategory user=${userId} period=${period} buckets=${rows.length} ` +
      `uncategorised=${uncategorisedCount}`,
    );

    return {
      period: window.period,
      periodLabel: window.label,
      from: window.from?.toISOString() ?? null,
      to: window.to.toISOString(),
      currency: 'INR',
      categories: rows.map((row) => ({
        category: row.category,
        totalPaise: row.totalPaise,
        total: formatPaise(row.totalPaise),
        count: row.count,
      })),
      totalPaise: totalPaise.toString(),
      total: formatPaise(totalPaise),
      uncategorisedCount,
    };
  }
}
