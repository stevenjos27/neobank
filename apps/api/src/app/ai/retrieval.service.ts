import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LLM_PROVIDER_TOKEN, LlmProvider } from './llm-provider.interface';

/**
 * MEASURED 24 Sep 2026 (Step 5) against text-embedding-3-small and the
 * 17-section FAQ, over 34 labelled questions — 22 the corpus answers, 12 it
 * does not. At this value:
 *
 *   recall@1  16/22      recallAny  19/22      false positives  3/12
 *
 * Chosen by sweeping 0.40–0.80 and maximising recallAny minus false-positive
 * rate, which peaks at 0.62–0.64 (0.614, against 0.606 at 0.58–0.60 and 0.531
 * at 0.66). The choice of metric decides the threshold: optimising recall@1
 * instead picks 0.58 and loses three questions for nothing, because the
 * generator is shown EVERY passage inside the threshold, not just the nearest.
 *
 * ORIGINALLY CALIBRATED 16 Sep from eight questions, and the guess before that
 * was 0.55 — which would have SILENTLY DROPPED "is there a charge for using
 * the app?" at 0.574, a real question answered by Fees and charges. A guessed
 * threshold errs toward "I don't know" about documented policy, and that
 * failure appears in no log. The eight-sample number survived the 34-case
 * sweep unchanged. That is worth knowing, but it is not why it stands: it
 * stands because it was measured.
 *
 * THIS THRESHOLD CANNOT BE THE GROUNDING GUARD, and that is now measured
 * rather than argued. The two distributions are interleaved, not merely close:
 * the nearest false positive ("can I open a joint account with my spouse?" →
 * Opening an account, 0.5392) is closer than the correct section for EIGHT of
 * the 22 covered questions. No cutoff separates them. At this operating point
 * one unanswerable question in four still yields a passage, so a non-empty
 * result is not permission to answer — the model judging relevance, and
 * citations being earned rather than assumed, are what stand between a false
 * positive and a fabrication.
 *
 * Three covered questions are unreachable at any sane cutoff: 0.7507, 0.7032
 * (at rank 1) and 0.6709. Those are corpus-vocabulary and retrieval-method
 * problems — a word appearing verbatim in a section does not put it nearby —
 * not threshold problems.
 *
 * These numbers are enforced as floors by
 * apps/api/src/app/ai/eval/retrieval.eval.spec.ts, evaluated at whatever this
 * constant currently is. Moving it fails that suite in one direction or the
 * other, by design.
 */
const DEFAULT_MAX_DISTANCE = 0.62;

/**
 * A ceiling on how much text one search can pull into a prompt.
 *
 * This matters more than it looks: once Step 3's tool-calling lands, `limit`
 * becomes a MODEL-SUPPLIED argument. A model that asks for 500 chunks would
 * blow the context window and the bill in one call. Clamp, don't trust.
 */
export const MAX_LIMIT = 10;

export type KnowledgeHit = {
  source: string;
  heading: string;
  chunkIndex: number;
  content: string;
  /** Cosine distance: 0 = identical, 1 = unrelated, 2 = opposite. */
  distance: number;
};

export type SearchOptions = {
  limit?: number;
  /** Pass 2 (the theoretical maximum) to disable filtering, for calibration. */
  maxDistance?: number;
};

/**
 * A result carries the parameters that produced it, non-optionally — the same
 * rule as `ChatResult.model`. Two searches with different thresholds are not
 * comparable, and a hit list with no record of its cutoff cannot be used to
 * calibrate that cutoff. It also keeps the effective defaults in ONE place:
 * the controller reports what the service actually did rather than guessing
 * from its own copy of the constants.
 */
export type KnowledgeSearchResult = {
  query: string;
  embeddingModel: string;
  limit: number;
  maxDistance: number;
  hits: KnowledgeHit[];
};

@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llm: LlmProvider,
  ) { }

  /**
   * Semantic search over the knowledge base.
   *
   * KnowledgeChunk is global — no userId, by design, because bank policy is
   * the same for everyone. That is exactly why this method is safe to expose
   * without scoping, and exactly why transaction search will NOT live here:
   * that one must be scoped to the caller's own accounts, and mixing a
   * global-by-design query with a must-be-scoped one in the same service is
   * how a scoping bug gets written by someone copying the method above it.
   */

  /**
 * Clamp, in one place, because both entry points need the same answer.
 *
 * A human caller out of range gets a 400 from the DTO; the model gets a
 * silent clamp here. Reject a human, clamp a model — see the DTO for why.
 */
  private resolveOptions(options: SearchOptions): { limit: number; maxDistance: number } {
    return {
      limit: Math.min(Math.max(1, Math.trunc(options.limit ?? 5)), MAX_LIMIT),
      maxDistance: options.maxDistance ?? DEFAULT_MAX_DISTANCE,
    };
  }

  /**
   * Semantic search over the knowledge base.
   *
   * KnowledgeChunk is global — no userId, by design, because bank policy is
   * the same for everyone.
   */
  async searchKnowledge(
    query: string,
    options: SearchOptions = {},
  ): Promise<KnowledgeSearchResult> {
    const trimmed = query.trim();

    // Return early WITHOUT embedding. A blank query would otherwise cost a
    // paid API call to produce a vector for nothing, and the DTO's Length(1)
    // only guards the HTTP path — the model-driven caller has no such
    // validation.
    if (trimmed.length === 0) {
      const { limit, maxDistance } = this.resolveOptions(options);
      return {
        query: trimmed,
        embeddingModel: this.llm.embeddingModel,
        limit,
        maxDistance,
        hits: [],
      };
    }

    // One embedding call per search — ~1.2s in production, measured. That is
    // the floor on answer latency and the reason Step 6 streams rather than
    // waiting. A caller with MANY queries should embed them in one batch and
    // use searchByVector instead of calling this in a loop.
    const { vectors } = await this.llm.embed([trimmed]);
    return this.searchByVector(trimmed, vectors[0], options);
  }

  /**
   * The search itself, for a vector that already exists.
   *
   * Split out because `embed()` is batch-shaped and this is not: embedding N
   * queries costs one round trip, searching with N vectors costs N local
   * queries. A caller that loops over searchKnowledge turns one network call
   * into N — the same mistake Step 1 designed embed(string[]) to prevent, and
   * the one the first version of the retrieval eval made. Thirty-four
   * sequential calls on a lossy link took 207 seconds and then failed.
   *
   * `query` is provenance only: it is the text the vector was produced from,
   * and it is echoed into the result so a hit list can still be traced back
   * to a question. Nothing re-embeds it, so a caller that passes a vector and
   * an unrelated string will get a plausible-looking lie. Keep them together.
   */
  async searchByVector(
    query: string,
    vector: number[],
    options: SearchOptions = {},
  ): Promise<KnowledgeSearchResult> {
    const { limit, maxDistance } = this.resolveOptions(options);
    const literal = JSON.stringify(vector);

    const hits = await this.prisma.$queryRaw<KnowledgeHit[]>`
      SELECT source, heading, "chunkIndex", content, distance
      FROM (
        SELECT
          source,
          heading,
          "chunkIndex",
          content,
          embedding <=> ${literal}::vector AS distance
        FROM "KnowledgeChunk"
        WHERE "modelVersion" = ${this.llm.embeddingModel}
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${literal}::vector
        LIMIT ${limit}
      ) ranked
      WHERE ranked.distance <= ${maxDistance}
      ORDER BY ranked.distance
    `;

    this.logger.debug(
      `knowledge search: ${hits.length} hit(s) within ${maxDistance}` +
      (hits.length > 0 ? `, best ${hits[0].distance.toFixed(4)}` : ''),
    );

    return {
      query,
      embeddingModel: this.llm.embeddingModel,
      limit,
      maxDistance,
      hits,
    };
  }
}
