import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ChatMessage,
  LLM_PROVIDER_TOKEN,
  LlmError,
  LlmProvider,
} from './llm-provider.interface';

/**
 * A CLOSED taxonomy, and the most consequential decision in this file.
 *
 * Free-form categories are the obvious thing to ask a model for and they are
 * useless: the same coffee shop comes back as "Food", "Food & Dining",
 * "Dining", "Restaurants" and "Cafes" across five runs. "How much did I spend
 * on food last month?" then has no correct SQL — you are aggregating over a
 * vocabulary the model reinvents each time.
 *
 * Fixing the vocabulary here is precisely what makes Step 3's aggregate tool
 * possible: `GROUP BY category` is only meaningful because this list is the
 * only thing that can ever land in that column.
 *
 * `Other` is the model's escape hatch — a real verdict of "none of these".
 * It is NOT the same as `null`, which this service returns when we failed to
 * obtain a verdict at all. Collapsing those two would hide every outage
 * behind a plausible-looking category.
 */
export const TRANSACTION_CATEGORIES = [
  'Food & Dining',
  'Groceries',
  'Transport',
  'Shopping',
  'Bills & Utilities',
  'Entertainment',
  'Health',
  'Travel',
  'Transfers',
  'Income',
  'Cash',
  'Fees & Charges',
  'Other',
] as const;

export type TransactionCategory = (typeof TRANSACTION_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(TRANSACTION_CATEGORIES);

export type CategorisationInput = {
  id: string;
  description: string;
  /** DEPOSIT | WITHDRAWAL | TRANSFER_IN | TRANSFER_OUT — direction is a strong signal. */
  type: string;
  amountPaise: bigint;
};

export type CategoryVerdict = {
  category: TransactionCategory;
  /**
   * The model's SELF-REPORTED confidence, 0–1, clamped.
   *
   * Not a calibrated probability. Usable as a triage signal for sorting, and
   * never to be shown to a customer as a likelihood.
   */
  confidence: number;
};

/**
 * Chat batching is not embedding batching, and the size reflects that.
 *
 * `embed()` uses 96 because the response is fixed-width vectors — a large
 * batch costs nothing extra in output. A chat batch instead produces output
 * tokens proportional to the batch, so an over-large batch risks hitting
 * `maxOutputTokens` and truncating the JSON mid-array. Twenty-five keeps the
 * response comfortably short while still amortising the system prompt across
 * twenty-five items instead of re-billing it for each one.
 */
const BATCH_SIZE = 25;

/** Generous enough for 25 verdicts, tight enough to bound a runaway. */
const MAX_OUTPUT_TOKENS = 1500;

const SYSTEM_PROMPT = `You categorise bank transactions for an Indian retail bank.

You will receive a JSON array of transactions, each with a numeric "ref". For
EACH one, return exactly one category from this list and nothing else:

${TRANSACTION_CATEGORIES.map((c) => `- ${c}`).join('\n')}

Rules:
- Use "Income" for money arriving that is earned (salary, interest). A refund
  of a purchase is NOT income - it keeps the original category.
- Use "Transfers" for movement between accounts or to another person, where no
  goods or services were bought.
- Use "Cash" for ATM withdrawals and cash handling.
- Use "Other" only when the description genuinely fits none of the categories.
  Do not guess a plausible-sounding category from a description that does not
  support it.
- "confidence" is your own estimate from 0 to 1 that the category is correct.
  Use a low value when the description is opaque.

Respond with ONLY a JSON array, no prose and no markdown fences, of the form:
[{"ref":0,"category":"<exact category>","confidence":0.0}]

Return one object for every transaction you were given, echoing back the SAME
"ref" it arrived with. Do not invent refs and do not repeat one.`;

@Injectable()
export class CategoriserService {
  private readonly logger = new Logger(CategoriserService.name);

  constructor(@Inject(LLM_PROVIDER_TOKEN) private readonly llm: LlmProvider) { }

  /**
   * Returns verdicts keyed by transaction id.
   *
   * Deliberately a partial result: a transaction may be absent because its
   * batch failed, because the model omitted it, or because it returned a
   * category outside the taxonomy. The caller decides what an absence means —
   * this service never invents a category to fill a gap.
   *
   * This method touches no database. Categorisation is a pure function of the
   * inputs, which is what lets it be unit-tested against a stub provider with
   * no Postgres and no API key.
   */
  async categorise(
    items: CategorisationInput[],
  ): Promise<{ verdicts: Map<string, CategoryVerdict>; inputTokens: number; outputTokens: number }> {
    const verdicts = new Map<string, CategoryVerdict>();
    let inputTokens = 0;
    let outputTokens = 0;

    for (const batch of this.batches(items)) {
      try {
        const result = await this.llm.chat({
          messages: this.buildMessages(batch),
          // Zero, and not negotiable. The same transaction must categorise the
          // same way on every run, or the backfill becomes a source of churn:
          // re-running would rewrite rows and shift every spend-by-category
          // figure the assistant has already quoted.
          temperature: 0,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        });

        inputTokens += result.usage.inputTokens;
        outputTokens += result.usage.outputTokens;

        this.collect(batch, result.text, verdicts);
      } catch (error) {
        // One failed batch must not lose the batches that already succeeded.
        // A spend limit is worth stopping for; a transient rate limit is not
        // worth discarding 200 good verdicts over.
        if (error instanceof LlmError && error.kind === 'spend_limit') {
          this.logger.error('Categorisation stopped: provider spend limit reached');
          throw error;
        }

        this.logger.warn(
          `Batch of ${batch.length} failed (${error instanceof LlmError ? error.kind : 'unknown'
          }); those transactions stay uncategorised`,
        );
      }
    }

    return { verdicts, inputTokens, outputTokens };
  }

  // ───────────────────────────────────────────────────────────────── prompt

  private buildMessages(batch: CategorisationInput[]): ChatMessage[] {
    /**
     * The batch is keyed by ORDINAL REF, not by transaction id.
     *
     * The first production run taught us why. Asked to echo back 36-character
     * UUIDs, the model mis-transcribed one of 249 — the verdict was discarded
     * as "an id that was not in the batch", and a completely unambiguous
     * description ("SWIGGY*ORDER 400231") went uncategorised because of a
     * copying error, not a judgement error.
     *
     * A one- or two-character ref cannot be mis-transcribed in that way, and
     * it keeps everything the id was there for: an omitted or duplicated ref
     * is still detectable, which is the only reason to echo a key at all.
     * It also removes ~250 input tokens per batch.
     *
     * Note what is sent and what is not. The embedding pipeline embeds the
     * DESCRIPTION ONLY, because `type` and `amountPaise` are structured facts
     * SQL can filter exactly and mixing them into a vector only dilutes the
     * semantic signal. Categorisation is the opposite case: direction and
     * magnitude are part of what the category IS. "ACME CORP" crediting
     * ₹85,000 is Income; the same name debiting ₹340 is not.
     *
     * The transaction id, account id, customer name and counterparty account
     * number are all withheld. None can improve a category, and every field
     * sent to a third party is a field that can appear in someone else's logs.
     */
    const payload = batch.map((item, ref) => ({
      ref,
      description: item.description,
      direction: item.type,
      amountInr: Number(item.amountPaise) / 100,
    }));

    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(payload) },
    ];
  }

  // ───────────────────────────────────────────────────────────────── parsing

  /**
   * Validate the response against the batch we actually sent.
   *
   * The ref echo is the whole point. Accepting "a list of categories in the
   * same order" is the tempting shortcut and it is the same bug as zipping
   * embeddings by array position: if the model drops or adds one item, every
   * subsequent transaction gets its neighbour's category, nothing throws, and
   * the damage is invisible — the data looks entirely plausible and is simply
   * wrong.
   */
  private collect(
    batch: CategorisationInput[],
    text: string,
    into: Map<string, CategoryVerdict>,
  ) {
    const parsed = this.parseJsonArray(text);

    if (!parsed) {
      this.logger.warn(`Unparseable response for a batch of ${batch.length}`);
      return;
    }

    const seen = new Set<number>();

    for (const entry of parsed) {
      const ref = entry?.['ref'];

      if (!Number.isInteger(ref) || (ref as number) < 0 || (ref as number) >= batch.length) {
        this.logger.warn(`Discarded a verdict with an out-of-range ref: ${String(ref)}`);
        continue;
      }

      // A repeated ref means the model answered one transaction twice — and
      // without this check the second answer would silently overwrite the
      // first, with no way to know which was intended. Neither is trustworthy
      // once it has contradicted itself, but the first is at least the one it
      // committed to before losing track.
      if (seen.has(ref as number)) {
        this.logger.warn(`Discarded a duplicate verdict for ref ${String(ref)}`);
        continue;
      }

      const category = entry?.['category'];
      if (typeof category !== 'string' || !CATEGORY_SET.has(category)) {
        // Outside the taxonomy. Accepting it would silently reopen the
        // free-form vocabulary this file exists to prevent.
        this.logger.warn(`Discarded out-of-taxonomy category "${String(category)}"`);
        continue;
      }

      seen.add(ref as number);
      into.set(batch[ref as number].id, {
        category: category as TransactionCategory,
        confidence: this.clampConfidence(entry?.['confidence']),
      });
    }

    const missing = batch.length - seen.size;
    if (missing > 0) {
      this.logger.warn(`${missing} of ${batch.length} transactions returned no usable verdict`);
    }
  }

  /**
   * The `chat()` seam has no structured-output option yet, so JSON is
   * requested in the prompt and must be treated as untrusted text. Models
   * wrap JSON in ```json fences often enough that stripping them is cheaper
   * than the support burden of not doing so.
   *
   * The real fix is a `responseFormat: 'json'` flag on ChatRequest, mapped to
   * OpenAI's `response_format`. That belongs with Step 3, where we also need
   * tool-calling on the same seam — changing the interface once for both is
   * better than changing it twice.
   */
  private parseJsonArray(text: string): Array<Record<string, unknown>> | null {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');

    try {
      const value = JSON.parse(cleaned);
      return Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Clamped because a model asked for 0–1 will occasionally answer 95, or "high".
   */
  private clampConfidence(raw: unknown): number {
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    return Math.min(1, Math.max(0, value));
  }

  private *batches<T>(items: T[]): Generator<T[]> {
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      yield items.slice(i, i + BATCH_SIZE);
    }
  }
}
