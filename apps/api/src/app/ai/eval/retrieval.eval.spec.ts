import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaService } from '../../../prisma/prisma.service';
import { OpenAiProvider } from '../openai.provider';
import { KnowledgeHit, RetrievalService } from '../retrieval.service';
import { RETRIEVAL_CASES, RetrievalCase } from './retrieval-questions';

/**
 * RETRIEVAL EVAL — measures recall and false-positive rate against the labelled
 * question set, and sweeps the distance threshold.
 *
 * MEASURED 24 Sep 2026, and the numbers are now floors. The first run
 * deliberately asserted nothing about quality — writing a threshold before
 * measuring would have been the same guess this step exists to remove. Having
 * measured, the floors below are set at exactly what was observed, so any
 * regression fails rather than being discovered later by a customer.
 *
 * WHAT THE SWEEP SHOWED, and it matters more than the number it confirmed:
 * the threshold cannot separate answerable from unanswerable questions,
 * because the two distributions are interleaved rather than merely close. The
 * nearest false positive ("can I open a joint account with my spouse?" →
 * Opening an account, 0.5392) is closer than the correct section for eight of
 * the twenty-two covered questions. At the operating point, one unanswerable
 * question in four still produces a passage. Step 3 asserted this from three
 * negatives; it is now measured on twelve, and it is the evidence for Step 4's
 * design — the model judging relevance, and citations being earned rather
 * than assumed, are what stands between a false positive and a fabrication.
 *
 * What it does assert is the contract between the labels and the corpus, in
 * both directions. A typo'd label would otherwise score as a permanent
 * retrieval miss and look like a model problem forever, and a section added to
 * the FAQ without a question written for it would go untested silently.
 *
 * Costs about $0.00001, in ONE network call: all 34 questions are embedded in
 * a single batch, then searched locally. Needs a real key — the mock's
 * hash-derived vectors have no semantics,
 * so retrieval quality cannot be measured against it at all.
 */

const REPO_ROOT = join(__dirname, '../../../../../..');
loadEnv({ path: join(REPO_ROOT, '.env'), quiet: true });

type Measured = RetrievalCase & { hits: KnowledgeHit[] };

const isCovered = (m: Measured) => m.expect.length > 0;

/** Distance of the nearest correct section, or Infinity if none is in the top 5. */
const bestCorrect = (m: Measured) =>
  m.hits.find((h) => m.expect.includes(h.heading))?.distance ?? Infinity;

function score(measured: Measured[], threshold: number) {
  const covered = measured.filter(isCovered);
  const negatives = measured.filter((m) => !isCovered(m));

  let top1 = 0;
  let anyRank = 0;
  for (const m of covered) {
    const within = m.hits.filter((h) => h.distance <= threshold);
    if (within.length > 0 && m.expect.includes(within[0].heading)) top1++;
    if (within.some((h) => m.expect.includes(h.heading))) anyRank++;
  }

  // A false positive is ANY hit surviving the threshold for a question the
  // corpus does not answer. Not "a wrong top hit" — the generator is shown
  // every surviving passage, so one irrelevant survivor is already a chance
  // to ground an answer in something that does not answer the question.
  const falsePositives = negatives.filter((m) =>
    m.hits.some((h) => h.distance <= threshold),
  ).length;

  return {
    threshold,
    top1,
    anyRank,
    falsePositives,
    covered: covered.length,
    negatives: negatives.length,
  };
}

/**
 * Regression floors, measured on 24 Sep 2026 against text-embedding-3-small
 * with the 17-section corpus:
 *
 *   recall@1  16/22   recallAny  19/22   false positives  3/12
 *
 * Exact floors are legitimate because embeddings are deterministic for a given
 * model and text. A model version bump that moves them is information, not
 * flakiness, and should be read rather than accommodated.
 *
 * These pin the QUALITY OF THE OPERATING POINT, not the constant. They are
 * evaluated at whatever DEFAULT_MAX_DISTANCE currently is, so moving it to
 * 0.68 fails on false positives and moving it to 0.58 fails on recall. That is
 * a far better contract than asserting the constant equals 0.62 — it says what
 * the threshold has to deliver, not what it has to be.
 */
const FLOORS = { recallAt1: 16, recallAny: 19, falsePositives: 3 };

/** The split the floors were measured against. Changing it invalidates them. */
const CASE_SPLIT = { covered: 22, notCovered: 12 };

describe('retrieval eval', () => {
  let prisma: PrismaService;
  let retrieval: RetrievalService;
  let embeddingModel: string;
  let currentThreshold: number;
  let corpusHeadings: Set<string>;
  const measured: Measured[] = [];

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set, and no .env was found at the repository root.');
    }
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        'OPENAI_API_KEY is not set. This eval measures retrieval quality, which needs real ' +
        'embeddings: the mock returns hash-derived vectors with no semantics, so every ' +
        'question would score zero and it would look like a catastrophic regression.',
      );
    }

    prisma = new PrismaService();
    await prisma.$connect();
    const llm = new OpenAiProvider();
    retrieval = new RetrievalService(prisma, llm);
    embeddingModel = llm.embeddingModel;

    const chunks = await prisma.knowledgeChunk.findMany({ select: { heading: true } });
    corpusHeadings = new Set(chunks.map((c) => c.heading));

    // PRECONDITION — the corpus is actually embedded, with THIS model. A
    // db:reset drops KnowledgeChunk, and the seed does not restore it; that
    // exact situation produced an empty corpus earlier in Step 5. Without this
    // check the eval would report 0% recall, which reads as a retrieval
    // catastrophe rather than as "nobody ran the ingest".
    const [{ ready }] = await prisma.$queryRaw<Array<{ ready: number }>>`
      SELECT count(*)::int AS ready
      FROM "KnowledgeChunk"
      WHERE embedding IS NOT NULL AND "modelVersion" = ${embeddingModel}
    `;
    if (chunks.length === 0 || ready !== chunks.length) {
      throw new Error(
        `${ready} of ${chunks.length} knowledge chunks are embedded with ${embeddingModel}. ` +
        `Run POST /ai/ingest as ADMIN before this eval.`,
      );
    }

    const questions = RETRIEVAL_CASES.map((c) => c.q);

    // ONE round trip for all 34 questions. The first version of this file
    // called searchKnowledge in a loop — 34 sequential embeddings, which on a
    // lossy link took 207 seconds and then failed. See searchByVector.
    const { vectors } = await llm.embed(questions);

    // The provider sorts embeddings by the API's `index` before returning, so
    // position i is question i. This checks the only part of that contract a
    // caller can see. A silent length mismatch would pair every question with
    // the wrong vector and report it as a retrieval collapse — the same
    // failure mode as Step 2's batch-ref bug, one layer up.
    if (vectors.length !== questions.length) {
      throw new Error(
        `embed returned ${vectors.length} vectors for ${questions.length} questions`,
      );
    }

    // The default threshold is not exported. Read it off a result instead,
    // which is possible only because a search carries the parameters that
    // produced it — and costs no network call, because the vector exists
    // already. Measuring against a copied constant would let the eval and the
    // service drift apart silently.
    currentThreshold = (await retrieval.searchByVector(questions[0], vectors[0])).maxDistance;

    for (const [i, testCase] of RETRIEVAL_CASES.entries()) {
      const result = await retrieval.searchByVector(testCase.q, vectors[i], {
        limit: 5,
        maxDistance: 2,
      });
      measured.push({ ...testCase, hits: result.hits });
    }
  });

  afterAll(async () => {
    if (measured.length > 0) report();
    await prisma?.$disconnect();
  });

  it('every labelled heading exists in the corpus', () => {
    const labelled = [...new Set(RETRIEVAL_CASES.flatMap((c) => c.expect))];
    expect(labelled.filter((h) => !corpusHeadings.has(h)).sort()).toEqual([]);
  });

  it('every corpus heading is covered by at least one case', () => {
    const labelled = new Set(RETRIEVAL_CASES.flatMap((c) => c.expect));
    expect([...corpusHeadings].filter((h) => !labelled.has(h)).sort()).toEqual([]);
  });

  it('measured every case', () => {
    expect(measured).toHaveLength(RETRIEVAL_CASES.length);
  });

  it('the case set is the one the floors were measured against', () => {
    // Absolute counts, not rates — so adding a question would quietly weaken
    // the floors. This makes that a deliberate act: change the set and this
    // fails, forcing a re-measurement rather than a silently easier bar.
    expect({
      covered: measured.filter(isCovered).length,
      notCovered: measured.filter((m) => !isCovered(m)).length,
    }).toEqual(CASE_SPLIT);
  });

  it('recall@1 has not regressed', () => {
    expect(score(measured, currentThreshold).top1).toBeGreaterThanOrEqual(FLOORS.recallAt1);
  });

  it('recallAny has not regressed', () => {
    // The metric that matches the system: the generator is shown EVERY passage
    // inside the threshold, not just the nearest. Optimising recall@1 instead
    // would have picked 0.58 and lost three questions for no benefit.
    expect(score(measured, currentThreshold).anyRank).toBeGreaterThanOrEqual(FLOORS.recallAny);
  });

  it('false positives have not increased', () => {
    expect(score(measured, currentThreshold).falsePositives).toBeLessThanOrEqual(
      FLOORS.falsePositives,
    );
  });

  /** One console.log, not forty — Jest prefixes each call with its own header. */
  function report(): void {
    const out: string[] = [];
    const covered = measured.filter(isCovered);
    const negatives = measured.filter((m) => !isCovered(m));

    out.push('=== retrieval eval ===');
    out.push(`embedding model : ${embeddingModel}`);
    out.push(`current default : ${currentThreshold}`);
    out.push(`cases           : ${covered.length} covered, ${negatives.length} not covered`);

    out.push('', 'hardest covered questions (distance to the nearest correct section):');
    [...covered]
      .sort((a, b) => bestCorrect(b) - bestCorrect(a))
      .slice(0, 8)
      .forEach((m) => {
        const d = bestCorrect(m);
        const rank = m.hits.findIndex((h) => m.expect.includes(h.heading));
        out.push(
          `  ${d === Infinity ? 'NOT IN TOP 5' : d.toFixed(4).padStart(12)}` +
          `  rank ${rank < 0 ? '-' : rank + 1}  ${m.q}`,
        );
      });

    out.push('', 'nearest false positives (best distance for an unanswerable question):');
    [...negatives]
      .sort((a, b) => (a.hits[0]?.distance ?? Infinity) - (b.hits[0]?.distance ?? Infinity))
      .slice(0, 8)
      .forEach((m) => {
        const top = m.hits[0];
        out.push(`  ${(top?.distance ?? Infinity).toFixed(4)}  ${top?.heading ?? '-'}  | ${m.q}`);
      });

    out.push('', 'threshold sweep:');
    out.push('  thresh   recall@1        recallAny       false positives');
    for (let t = 0.4; t <= 0.8001; t += 0.02) {
      const s = score(measured, Number(t.toFixed(2)));
      const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(0).padStart(3)}% (${n}/${d})`;
      out.push(
        `  ${s.threshold.toFixed(2)}     ${pct(s.top1, s.covered)}` +
        `      ${pct(s.anyRank, s.covered)}      ${pct(s.falsePositives, s.negatives)}`,
      );
    }

    const now = score(measured, currentThreshold);
    out.push(
      '',
      `at the current default ${currentThreshold}: ` +
      `recall@1 ${now.top1}/${now.covered}, recallAny ${now.anyRank}/${now.covered}, ` +
      `false positives ${now.falsePositives}/${now.negatives}`,
    );

    console.log('\n' + out.join('\n') + '\n');
  }
});
