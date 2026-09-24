import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LLM_PROVIDER_TOKEN, LlmProvider } from './llm-provider.interface';

/**
 * Cosine distance above which a chunk is treated as "not an answer".
 *
 * CALIBRATED 16 Sep 2026 against text-embedding-3-small and the 17-chunk
 * FAQ, with five paraphrased questions the corpus answers and three it
 * does not:
 *
 *   covered      0.250  0.278  0.451  0.462  0.574   ← worst true positive
 *   ──────────────────────────────────────── 0.62 ───
 *   not covered                      0.665  0.722  0.906  ← best false positive
 *
 * The initial guess was 0.55, which would have SILENTLY DROPPED "is there a
 * charge for using the app?" at 0.574 — a real question answered by the
 * Fees and charges section. A guessed threshold errs toward "I don't know"
 * about documented policy, and that failure appears in no log.
 *
 * All five covered questions returned the CORRECT section at rank 1, so
 * ranking and thresholding are separate concerns. This number decides only
 * where to cut.
 *
 * Eight samples is a sample, not a distribution. The hard negatives sit
 * 0.045 above the cut, so some off-corpus questions WILL clear it. That is
 * accepted deliberately: Step 4 must have the model judge whether the
 * retrieved text answers the question, because a non-empty result is not
 * permission to answer. This is a pre-filter, not the grounding guard.
 * Step 5's eval harness replaces this with a number backed by measured
 * recall and false-positive counts.
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
