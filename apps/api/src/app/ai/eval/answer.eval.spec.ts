import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { formatPaise } from '@neobank/utils';
import { PrismaService } from '../../../prisma/prisma.service';
import { AggregatesService } from '../aggregates.service';
import { AnsweringService, AnswerResult } from '../answering.service';
import { OpenAiProvider } from '../openai.provider';
import { Period } from '../period';
import { RetrievalService } from '../retrieval.service';
import { ToolRegistryService } from '../tool-registry.service';
import { ANSWER_CASES, AnswerCase } from './answer-questions';
import { Expectation, Finding, scoreAnswer } from './answer-scoring';

/**
 * ANSWER EVAL — Layer C. The full answering loop against the real model,
 * scored mechanically.
 *
 * WHAT IT EXERCISES THAT NOTHING ELSE DOES. Layer A proves the tools return
 * the right numbers; Layer B proves retrieval finds the right passage for a
 * given query. Between them and the customer sits everything this measures:
 * whether the model called the tool at all, whether it rewrote the question
 * into something retrievable, whether it quoted the figure it was handed or
 * one it composed, and whether it says "not documented" when nothing covers
 * the question.
 *
 * STRICT PER CASE, NOT A FLOOR. The retrieval eval scores against floors
 * because partial recall is expected — no threshold reaches 22 of 22. Here the
 * target is every property on every case, because there is no principled
 * reason a working assistant should fabricate an amount or cite a section it
 * did not use. A red case is a finding to diagnose, not a number to tune.
 *
 * SCORING LIVES IN answer-scoring.ts, which the unit suite tests on every pull
 * request — including an assertion that each of its seven properties has been
 * observed failing. A scorer that could only return true would make this
 * expensive, rarely-run suite permanently green, and that is exactly the kind
 * of rot nobody finds for months.
 *
 * WHY IT CALLS THE SERVICE AND NOT /ai/ask. The controller sets `now` from the
 * wall clock, by design — it is the edge of a real request. This eval must
 * resolve periods at the seed anchor, so it constructs the context itself.
 * The cost is that the controller's response mapping is NOT covered here,
 * including its rule that `withheldAnswer` must never reach the wire. That
 * needs its own test and is logged as a gap.
 *
 * Costs roughly ₹1.6 / $0.02 and a few minutes, in about thirty chat
 * completions. Needs a real key: the mock answers from a script, so every
 * property below would measure the script.
 */

const REPO_ROOT = join(__dirname, '../../../../../..');
loadEnv({ path: join(REPO_ROOT, '.env'), quiet: true });

type SpendWindow = {
  from: string | null;
  to: string;
  debitsPaise: string;
  debitCount: number;
};

type SeedFacts = {
  anchor: string;
  database: string;
  accounts: Array<{ accountNumber: string; transactionCount: number }>;
  spendByUser: Record<string, Partial<Record<Period, SpendWindow>>>;
};

const facts: SeedFacts = JSON.parse(
  readFileSync(join(REPO_ROOT, 'prisma/.seed-facts.json'), 'utf8'),
);

/** The instant every case is answered at. The whole point of Part 2c step 1. */
const NOW = new Date(facts.anchor);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * "August 2026", derived from the facts file's window rather than by calling
 * period.ts.
 *
 * A SECOND IMPLEMENTATION ON PURPOSE, the same rule Layer A follows for the
 * IST calendar: ground truth that shares code with the system under test is
 * wrong in lockstep with it. Importing resolvePeriod here would mean the
 * expected label and the produced label could only ever agree.
 *
 * `to` is the exclusive end of the window, so one millisecond before it is the
 * last instant inside the month. Adding the IST offset and reading UTC fields
 * is the standard way to ask "what did the clock in India say" without a
 * timezone library.
 */
const istMonthLabel = (windowEnd: string): string => {
  const last = new Date(new Date(windowEnd).getTime() - 1 + IST_OFFSET_MS);
  return `${MONTH_NAMES[last.getUTCMonth()]} ${last.getUTCFullYear()}`;
};

/** Periods whose label is a single month, and so is worth asserting. */
const MONTH_PERIODS: Period[] = ['this_month', 'last_month'];

const expectationFor = (testCase: AnswerCase): Expectation => {
  if (!testCase.expectTotalFor) return {};

  const window = facts.spendByUser[testCase.user]?.[testCase.expectTotalFor];
  if (!window) {
    throw new Error(
      `.seed-facts.json has no ${testCase.expectTotalFor} window for ` +
      `${testCase.user}, which case "${testCase.id}" expects. Re-seed, or ` +
      `correct the case.`,
    );
  }

  return {
    totalDisplay: formatPaise(window.debitsPaise),
    // last_30_days renders as a date range whose exact formatting this file
    // would have to reproduce character for character. A check that goes red
    // when a date format changes is measuring its own expectation.
    periodLabel: MONTH_PERIODS.includes(testCase.expectTotalFor)
      ? istMonthLabel(window.to)
      : undefined,
  };
};

type Scored = { testCase: AnswerCase; result: AnswerResult; findings: Finding[] };

describe('answer eval', () => {
  let prisma: PrismaService;
  let answering: AnsweringService;
  const userIds = new Map<string, string>();
  const scored: Scored[] = [];

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set, and no .env was found at the repository root.');
    }
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        'OPENAI_API_KEY is not set. This eval measures what the real model does with real ' +
        'tools; the mock answers from a script, so every property below would be measuring ' +
        'the script rather than the assistant.',
      );
    }

    // PRECONDITION 1 — the facts describe THIS database. Copied in spirit from
    // the ground-truth suite, which has it because that exact mistake was made
    // by hand in Step 4: a production figure compared against local data and
    // misdiagnosed as seed drift.
    const connected = new URL(process.env.DATABASE_URL).host;
    if (facts.database !== connected) {
      throw new Error(
        `.seed-facts.json describes ${facts.database}, but DATABASE_URL points at ` +
        `${connected}. Re-seed this database, or point DATABASE_URL at the one that was seeded.`,
      );
    }

    prisma = new PrismaService();
    await prisma.$connect();

    // PRECONDITION 2 — nothing has written to the seeded accounts since.
    for (const account of facts.accounts) {
      const actual = await prisma.transaction.count({
        where: { account: { accountNumber: account.accountNumber } },
      });
      if (actual !== account.transactionCount) {
        throw new Error(
          `Account ${account.accountNumber} holds ${actual} transactions; the facts file ` +
          `expects ${account.transactionCount}. Every figure below would be wrong for a ` +
          `reason unrelated to the assistant. Re-seed.`,
        );
      }
    }

    const llm = new OpenAiProvider();
    const retrieval = new RetrievalService(prisma, llm);
    const aggregates = new AggregatesService(prisma);
    answering = new AnsweringService(llm, new ToolRegistryService(retrieval, aggregates));

    // PRECONDITION 3 — the corpus is embedded with THIS model. A db:reset
    // drops KnowledgeChunk and the seed does not restore it; that exact
    // situation happened in Part 1. Without this, every knowledge case would
    // fail its citation property and read as a model regression.
    const chunks = await prisma.knowledgeChunk.findMany({ select: { heading: true } });
    const [{ ready }] = await prisma.$queryRaw<Array<{ ready: number }>>`
      SELECT count(*)::int AS ready
      FROM "KnowledgeChunk"
      WHERE embedding IS NOT NULL AND "modelVersion" = ${llm.embeddingModel}
    `;
    if (chunks.length === 0 || ready !== chunks.length) {
      throw new Error(
        `${ready} of ${chunks.length} knowledge chunks are embedded with ` +
        `${llm.embeddingModel}. Run POST /ai/ingest as ADMIN before this eval.`,
      );
    }

    // PRECONDITION 4 — every heading a case names actually exists. The unit
    // suite checks this against the retrieval set's labels, which is free but
    // indirect; this is the real thing. A typo'd heading would otherwise look
    // like the assistant refusing to cite, forever.
    const corpusHeadings = new Set(chunks.map((chunk) => chunk.heading));
    const unknown = ANSWER_CASES.flatMap((testCase) =>
      testCase.expectSources
        .filter((heading) => !corpusHeadings.has(heading))
        .map((heading) => `${testCase.id} → "${heading}"`),
    );
    if (unknown.length > 0) {
      throw new Error(`Cases name headings absent from the corpus:\n  ${unknown.join('\n  ')}`);
    }

    for (const email of new Set(ANSWER_CASES.map((testCase) => testCase.user))) {
      const user = await prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });
      userIds.set(email, user.id);
    }
  });

  afterAll(async () => {
    if (scored.length > 0) {
      const lines = scored.map(({ testCase, findings }) => {
        const failed = findings.filter((finding) => !finding.ok);
        const mark = failed.length === 0 ? 'pass' : `FAIL ${failed.length}`;
        return (
          `  ${testCase.id.padEnd(30)} ${String(findings.length).padStart(2)} checked  ${mark}` +
          failed.map((finding) => `\n      ${finding.property}: ${finding.detail}`).join('')
        );
      });
      const totalChecks = scored.reduce((sum, s) => sum + s.findings.length, 0);
      const totalFailed = scored.reduce(
        (sum, s) => sum + s.findings.filter((f) => !f.ok).length,
        0,
      );
      // eslint-disable-next-line no-console
      console.log(
        `\nanswer eval — ${scored.length} cases, ${totalChecks} property checks, ` +
        `${totalFailed} failed\n${lines.join('\n')}\n`,
      );
    }
    await prisma?.$disconnect();
  });

  // Every numeric case must expect a figure no other case expects, so that a
  // wrong identity or a wrong period surfaces as a mismatch rather than as a
  // coincidence. The unit suite asserts the (user, period) pairs are distinct;
  // only here, with the facts file loaded, can the TOTALS be compared.
  it('no two numeric cases expect the same total', () => {
    const totals = ANSWER_CASES
      .filter((testCase) => testCase.expectTotalFor)
      .map((testCase) => expectationFor(testCase).totalDisplay);

    expect(totals.length).toBeGreaterThan(0);
    expect(new Set(totals).size).toBe(totals.length);
  });

  for (const testCase of ANSWER_CASES) {
    it(`${testCase.id}: ${testCase.question}`, async () => {
      const userId = userIds.get(testCase.user);
      expect(typeof userId).toBe('string');

      const result = await answering.answer(testCase.question, { userId, now: NOW });
      const findings = scoreAnswer(testCase, result, expectationFor(testCase));
      scored.push({ testCase, result, findings });

      // The scorer decides what applies; this asserts it was scored at all.
      // A case that produced no findings would pass silently.
      expect(findings.length).toBeGreaterThanOrEqual(3);

      const failed = findings.filter((finding) => !finding.ok);
      expect({
        id: testCase.id,
        failed: failed.map((finding) => `${finding.property}: ${finding.detail}`),
        answer: failed.length > 0 ? result.answer : undefined,
      }).toEqual({ id: testCase.id, failed: [], answer: undefined });
    });
  }
});
