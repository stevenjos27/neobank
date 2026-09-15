import { Inject, Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../../prisma/prisma.service';
import { LLM_PROVIDER_TOKEN, LlmProvider } from './llm-provider.interface';
import { chunkMarkdown, MarkdownChunk } from './chunk-markdown';
import { CategorisationInput, CategoriserService } from './categoriser.service';

/**
 * Inputs per embedding call. The API accepts far more, but a batch that fails
 * costs the whole batch, and 96 keeps a single failure cheap while still
 * turning 249 transactions into 3 round trips instead of 249.
 */
const BATCH_SIZE = 96;

export type KnowledgeReport = {
  source: string;
  embedded: number;
  unchanged: number;
  removed: number;
};

export type IngestionReport = {
  embeddingModel: string;
  chatModel: string;
  knowledge: KnowledgeReport[];
  categorisation: { categorised: number; attempted: number; skippedNoDescription: number };
  transactionEmbeddings: { embedded: number; unchanged: number; skippedNoDescription: number };
  usage: {
    embeddingInputTokens: number;
    chatInputTokens: number;
    chatOutputTokens: number;
  };
  durationMs: number;
};

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);
  /**
 * The run currently in progress, if any.
 *
 * Two concurrent ingests would embed the same rows twice, bill twice, and
 * race each other on the same upserts. The second caller therefore JOINS
 * the run already underway and receives its report, rather than being
 * rejected — an admin who double-clicks gets the answer, not an error.
 */
  private inFlight: Promise<IngestionReport> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly categoriser: CategoriserService,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llm: LlmProvider,
  ) { }

  async ingestAll(): Promise<IngestionReport> {
    if (this.inFlight) {
      this.logger.warn('Ingest already in progress; joining the running one');
      return this.inFlight;
    }

    // `finally` clears the slot whether the run succeeded or threw. Without
    // it, one failure would leave a settled promise parked here forever and
    // every later ingest would return that same stale report.
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private async run(): Promise<IngestionReport> {
    const startedAt = Date.now();
    let embeddingInputTokens = 0;

    const knowledge = await this.ingestKnowledge((n) => (embeddingInputTokens += n));

    /**
     * Categorisation runs BEFORE embedding, deliberately.
     *
     * It creates a TransactionEnrichment row for every transaction, with
     * `embeddingModelVersion` still null. The embedding pass that follows must
     * therefore handle null correctly or it will find nothing to do and
     * silently embed zero rows — see the note on `embeddingCandidates`.
     *
     * Running them in this order means that bug cannot lurk: it would show up
     * on the very first run against a fresh database, as an ingest that
     * reports 249 categorised and 0 embedded. Ordering the passes the other
     * way round would let the same mistake hide until the first time a row
     * was categorised before it was embedded — months later, in production.
     */
    const categorisation = await this.categoriseTransactions();

    const transactionEmbeddings = await this.embedTransactions((n) => (embeddingInputTokens += n));

    return {
      embeddingModel: this.llm.embeddingModel,
      chatModel: this.llm.chatModel,
      knowledge,
      categorisation: {
        categorised: categorisation.categorised,
        attempted: categorisation.attempted,
        skippedNoDescription: categorisation.skippedNoDescription,
      },
      transactionEmbeddings,
      usage: {
        embeddingInputTokens,
        chatInputTokens: categorisation.inputTokens,
        chatOutputTokens: categorisation.outputTokens,
      },
      durationMs: Date.now() - startedAt,
    };
  }

  // ─────────────────────────────────────────────────────────────── knowledge

  private async ingestKnowledge(countTokens: (n: number) => void): Promise<KnowledgeReport[]> {
    const dir = this.knowledgeDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
    const reports: KnowledgeReport[] = [];

    for (const file of files) {
      const markdown = await readFile(join(dir, file), 'utf8');
      const chunks = chunkMarkdown(file, markdown);

      const existing = await this.prisma.knowledgeChunk.findMany({
        where: { source: file },
        select: { chunkIndex: true, contentHash: true, modelVersion: true },
      });
      const byIndex = new Map(existing.map((row) => [row.chunkIndex, row]));

      // Re-embed only what actually changed. A chunk is current when BOTH its
      // text and the model that embedded it are unchanged — a vector from a
      // different model is not merely stale, it is in a different space and
      // cannot be compared with the others.
      //
      // `modelVersion` is unqualified here because KnowledgeChunk has exactly
      // one model: chunks are embedded and never categorised.
      const stale = chunks.filter((chunk) => {
        const row = byIndex.get(chunk.chunkIndex);
        return (
          !row ||
          row.contentHash !== chunk.contentHash ||
          row.modelVersion !== this.llm.embeddingModel
        );
      });

      for (const batch of this.batches(stale)) {
        const result = await this.llm.embed(batch.map((c) => c.content));
        countTokens(result.usage.inputTokens);

        for (const [i, chunk] of batch.entries()) {
          await this.writeKnowledgeChunk(chunk, result.vectors[i]);
        }
      }

      // The document may have lost sections since the last run. Rows past the
      // current end would otherwise linger and keep being retrieved — answers
      // citing policy that no longer exists.
      const removed = await this.prisma.knowledgeChunk.deleteMany({
        where: { source: file, chunkIndex: { gte: chunks.length } },
      });

      reports.push({
        source: file,
        embedded: stale.length,
        unchanged: chunks.length - stale.length,
        removed: removed.count,
      });

      this.logger.log(
        `${file}: ${stale.length} embedded, ${chunks.length - stale.length} unchanged, ` +
        `${removed.count} removed`,
      );
    }

    return reports;
  }

  private async writeKnowledgeChunk(chunk: MarkdownChunk, vector: number[]) {
    const row = await this.prisma.knowledgeChunk.upsert({
      where: { source_chunkIndex: { source: chunk.source, chunkIndex: chunk.chunkIndex } },
      update: {
        heading: chunk.heading,
        content: chunk.content,
        contentHash: chunk.contentHash,
        modelVersion: this.llm.embeddingModel,
      },
      create: {
        source: chunk.source,
        chunkIndex: chunk.chunkIndex,
        heading: chunk.heading,
        content: chunk.content,
        contentHash: chunk.contentHash,
        modelVersion: this.llm.embeddingModel,
      },
      select: { id: true },
    });

    await this.writeVector('KnowledgeChunk', row.id, vector);
  }

  // ──────────────────────────────────────────────────────────── categorising

  private async categoriseTransactions() {
    const candidates = await this.prisma.transaction.findMany({
      where: {
        OR: [
          { enrichment: null },
          { enrichment: { categoryModelVersion: null } },
          { enrichment: { categoryModelVersion: { not: this.llm.chatModel } } },
        ],
      },
      select: { id: true, description: true, type: true, amountPaise: true },
    });

    // An explicit map, not a type predicate.
    //
    // Prisma types `type` as the TransactionType enum; CategorisationInput
    // types it as string. That widening is deliberate — it is what keeps the
    // categoriser free of any Prisma import, so it can be unit-tested against
    // a stub provider with no generated client and no database. The cost is
    // that the boundary has to be crossed by hand, here, exactly once.
    const withText: CategorisationInput[] = [];
    for (const t of candidates) {
      if (typeof t.description !== 'string' || t.description.trim().length === 0) continue;
      withText.push({
        id: t.id,
        description: t.description,
        type: t.type,
        amountPaise: t.amountPaise,
      });
    }
    const skippedNoDescription = candidates.length - withText.length;

    const { verdicts, inputTokens, outputTokens } = await this.categoriser.categorise(withText);

    for (const [transactionId, verdict] of verdicts) {
      await this.prisma.transactionEnrichment.upsert({
        where: { transactionId },
        update: {
          category: verdict.category,
          confidence: verdict.confidence,
          categoryModelVersion: this.llm.chatModel,
        },
        create: {
          transactionId,
          category: verdict.category,
          confidence: verdict.confidence,
          categoryModelVersion: this.llm.chatModel,
        },
      });
    }

    this.logger.log(
      `categorisation: ${verdicts.size} of ${withText.length} attempted, ` +
      `${skippedNoDescription} without description`,
    );

    return {
      categorised: verdicts.size,
      attempted: withText.length,
      skippedNoDescription,
      inputTokens,
      outputTokens,
    };
  }

  // ───────────────────────────────────────────────────────── embedding txns

  private async embedTransactions(countTokens: (n: number) => void) {
    const candidates = await this.embeddingCandidates();

    // Only free text is worth embedding. `type`, `amountPaise` and `createdAt`
    // are structured: filtering them in SQL is exact, whereas embedding them
    // dilutes the semantic signal and still cannot answer a numeric question.
    // The categoriser makes the opposite call about the same two fields, for
    // the opposite reason — see the note in its `buildMessages`.
    const withText = candidates.filter(
      (t): t is { id: string; description: string } =>
        typeof t.description === 'string' && t.description.trim().length > 0,
    );
    const skippedNoDescription = candidates.length - withText.length;

    for (const batch of this.batches(withText)) {
      const result = await this.llm.embed(batch.map((t) => t.description));
      countTokens(result.usage.inputTokens);

      for (const [i, transaction] of batch.entries()) {
        const row = await this.prisma.transactionEnrichment.upsert({
          where: { transactionId: transaction.id },
          update: { embeddingModelVersion: this.llm.embeddingModel },
          create: {
            transactionId: transaction.id,
            embeddingModelVersion: this.llm.embeddingModel,
          },
          select: { id: true },
        });

        await this.writeVector('TransactionEnrichment', row.id, result.vectors[i]);
      }
    }

    const total = await this.prisma.transaction.count();

    this.logger.log(
      `transaction embeddings: ${withText.length} embedded, ` +
      `${skippedNoDescription} without description`,
    );

    return {
      embedded: withText.length,
      unchanged: total - candidates.length,
      skippedNoDescription,
    };
  }

  /**
   * Three clauses, and the middle one is not redundant.
   *
   * SQL comparisons against NULL yield NULL, not true — so for a row whose
   * `embeddingModelVersion` is null, `embeddingModelVersion <> 'text-...'`
   * evaluates to NULL, the row fails the WHERE clause, and it is never
   * embedded. Not an error, not a warning: it simply never happens.
   *
   * Since the categoriser now creates rows with a null here, that single
   * missing clause would mean nothing on this table is ever embedded again.
   * `{ not: x }` is not "everything except x" — it is "everything KNOWN to
   * differ from x", and null is not known to differ from anything.
   */
  private embeddingCandidates() {
    return this.prisma.transaction.findMany({
      where: {
        OR: [
          { enrichment: null },
          { enrichment: { embeddingModelVersion: null } },
          { enrichment: { embeddingModelVersion: { not: this.llm.embeddingModel } } },
        ],
      },
      select: { id: true, description: true },
    });
  }

  // ───────────────────────────────────────────────────────────────── helpers

  /**
   * Prisma has no vector type, so `embedding` is `Unsupported(...)` and does
   * not exist on the generated client at all. Every vector write is raw SQL.
   *
   * The vector is passed as a PARAMETER and cast, never interpolated into the
   * statement. `JSON.stringify` on a number[] produces "[0.1,0.2,...]", which
   * is exactly pgvector's text input format.
   */
  private async writeVector(
    table: 'KnowledgeChunk' | 'TransactionEnrichment',
    id: string,
    vector: number[]
  ) {
    const literal = JSON.stringify(vector);

    if (table === 'KnowledgeChunk') {
      await this.prisma.$executeRaw`
        UPDATE "KnowledgeChunk" SET embedding = ${literal}::vector WHERE id = ${id}
      `;
      return;
    }

    await this.prisma.$executeRaw`
      UPDATE "TransactionEnrichment" SET embedding = ${literal}::vector WHERE id = ${id}
    `;
  }

  private * batches<T>(items: T[]): Generator<T[]> {
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      yield items.slice(i, i + BATCH_SIZE);
    }
  }

  /**
   * Two locations because there are two ways this runs: from a checkout
   * (`nx serve api`, cwd = workspace root) and from a build, where the assets
   * entry in `apps/api/webpack.config.js` has copied `knowledge/` next to main.js.
   */
  private knowledgeDir(): string {
    const candidates = [
      process.env.KNOWLEDGE_DIR,
      join(process.cwd(), 'knowledge'),
      join(__dirname, 'knowledge'),
    ].filter((p): p is string => Boolean(p));

    const found = candidates.find((p) => existsSync(p));
    if (!found) {
      throw new Error(
        `No knowledge directory found. Looked in: ${candidates.join(', ')}. ` +
        `Set KNOWLEDGE_DIR, or check the assets entry in apps/api/webpack.config.js`,
      );
    }
    return found;
  }
}
