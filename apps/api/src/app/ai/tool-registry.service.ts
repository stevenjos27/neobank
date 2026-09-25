import { Injectable, Logger } from '@nestjs/common';
import { ToolCall, ToolDefinition } from './llm-provider.interface';
import { MAX_LIMIT, RetrievalService } from './retrieval.service';
import { AggregatesService } from './aggregates.service';
import { isPeriod, PERIODS } from './period';

/**
 * Who is asking, and WHEN the question is being answered.
 *
 * A SEPARATE PARAMETER from the tool arguments, so that identity and model
 * output cannot be confused for one another even by accident — there is no
 * object anywhere in this file that holds both.
 *
 * `now` belongs here for the same two reasons `userId` does, and both are
 * worth stating because only the first is obvious.
 *
 * 1. THE MODEL MUST NOT CHOOSE IT. A model that could supply the current
 *    instant could resolve "last month" against a date it invented, and the
 *    answer would be confidently wrong about which month it described.
 *    Identity and time are both things the server knows and the model guesses.
 *
 * 2. ONE ANSWER, ONE CLOCK. `spendByCategory` defaults `now` to `new Date()`,
 *    so until now each tool call read the wall clock independently. A reply
 *    that calls the tool twice while the IST day rolls over would resolve two
 *    different "last month"s and reconcile neither. Fixing the instant for the
 *    whole turn makes a multi-call answer internally consistent by
 *    construction rather than by luck.
 *
 * Required, not optional. An optional `now` would let every future call site
 * silently fall back to the wall clock — which is precisely the bug — and the
 * compiler would say nothing. Required means adding a call site forces a
 * decision about which clock it runs on.
 */
export type ToolContext = { userId: string; now: Date };

/**
 * A tool outcome is DATA, not an exception, and the distinction is the design.
 *
 * `ok: false` travels back to the model as a `tool` message it can read and
 * act on: "period must be one of …" lets it retry with a valid argument, and
 * the turn survives. Throwing would kill the conversation over a mistake the
 * model is perfectly capable of correcting.
 *
 * The split: **the model's mistakes are data; ours are exceptions.** A bad
 * argument returns `ok: false`. A Prisma failure inside a tool is our bug and
 * propagates, because no amount of retrying will fix it and pretending
 * otherwise would bury a real fault in a chat reply.
 */
export type ToolExecution =
  | { ok: true; name: string; result: unknown }
  | { ok: false; name: string; error: string };

/** Argument names that would mean the model is choosing WHOSE data to read. */
const IDENTITY_KEYS = ['userid', 'user', 'accountid', 'account', 'email', 'customerid'];

/**
 * The tools, and their schemas as the model sees them.
 *
 * `description` is PROMPT, not documentation — it is the only thing the model
 * reads when deciding whether to call a tool at all. A vague description is
 * the usual cause of a model answering a numeric question from thin air
 * instead of calling the thing that knows the answer, so each one below
 * states what the tool is for AND what not to do instead.
 */
const DEFINITIONS: ToolDefinition[] = [
  {
    name: 'search_knowledge',
    description:
      "Search NeoBank's published policy and FAQ documents. Use for questions " +
      'about rules, limits, fees, currency, security, account types, and how ' +
      'features work. Returns an empty result when the documents do not cover ' +
      'the question — an empty result is a valid answer meaning "not ' +
      'documented", and must not be treated as a reason to answer from general ' +
      'knowledge.',
    parameters: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
          description:
            "The customer's question, copied as they asked it. This is " +
            'semantic search over whole sentences, NOT keyword search. Do ' +
            'not summarise the question, shorten it, or turn it into search ' +
            'terms: a compressed phrase retrieves worse than the sentence it ' +
            'came from and often retrieves nothing at all. If the customer ' +
            'asked about two things at once, pass the whole of the part that ' +
            'concerns policy — still in their own words, still a sentence.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: 'How many passages to return. Defaults to 5.',
        },
      },
      required: ['q'],
      // Rejects invented arguments at the provider where it is enforced.
      // Not relied upon — see warnOnIdentityArguments.
      additionalProperties: false,
    },
  },
  {
    name: 'spend_by_category',
    description:
      "The customer's own spending, grouped by category, over a named period. " +
      'Totals are exact and already formatted for display — quote them verbatim ' +
      'and never recompute or add them up. Use this for ANY question about how ' +
      'much was spent; never estimate an amount from transaction descriptions or ' +
      'from memory. If the result reports uncategorisedCount above zero, say so, ' +
      'because the per-category figures then do not sum to total spending.',
    parameters: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: [...PERIODS],
          description:
            'The time window. Calendar periods are resolved in India Standard ' +
            'Time by the server; do not attempt to supply dates.',
        },
      },
      required: ['period'],
      additionalProperties: false,
    },
  },
];

@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);

  constructor(
    private readonly retrieval: RetrievalService,
    private readonly aggregates: AggregatesService,
  ) { }

  definitions(): ToolDefinition[] {
    return DEFINITIONS;
  }

  /**
   * NOTE WHAT THE SCHEMAS ABOVE DO NOT EXPOSE.
   *
   * `maxDistance` is absent from `search_knowledge` on purpose. It is a
   * calibrated system parameter — measured at 0.62 against a known corpus —
   * and handing it to the model would let it widen the threshold until
   * something came back, converting "not documented" into a citation of
   * whatever ranked least badly. A model under pressure to be helpful must
   * not be given the dial that turns off the guard rail.
   *
   * `userId` is absent from both, and unlike `maxDistance` its absence is
   * also enforced below rather than merely declared.
   */
  async execute(call: ToolCall, context: ToolContext): Promise<ToolExecution> {
    const parsed = this.parseArguments(call.argumentsJson);
    // `in` narrowing rather than `if (!parsed.ok)`, which does NOT narrow
    // this union under the workspace's `strict: false` (gap #13). Structural
    // narrowing works either way. Don't "tidy" this back to a truthiness
    // check — and when #13 is fixed, verify before simplifying it.
    if ('error' in parsed) {
      return { ok: false, name: call.name, error: parsed.error };
    }

    this.warnOnIdentityArguments(call.name, parsed.value);

    switch (call.name) {
      case 'search_knowledge':
        return this.runSearchKnowledge(call.name, parsed.value);

      case 'spend_by_category':
        return this.runSpendByCategory(call.name, parsed.value, context);

      default:
        // A hallucinated tool name is the model's mistake, so it goes back as
        // data with the real list attached — it can pick again.
        return {
          ok: false,
          name: call.name,
          error:
            `Unknown tool "${call.name}". Available tools: ` +
            `${DEFINITIONS.map((tool) => tool.name).join(', ')}.`,
        };
    }
  }

  // ──────────────────────────────────────────────────────────────── parsing

  private parseArguments(
    argumentsJson: string,
  ): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
    // An absent argument object arrives as "" or "{}" depending on the
    // provider and the tool. Treating blank as empty-object avoids reporting
    // a JSON error for a tool that legitimately takes nothing.
    const raw = argumentsJson?.trim() ? argumentsJson : '{}';

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'Arguments were not valid JSON. Send a JSON object.' };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'Arguments must be a JSON object.' };
    }

    return { ok: true, value: parsed as Record<string, unknown> };
  }

  /**
   * The model cannot succeed at choosing an identity — nothing below reads one
   * from the arguments — but it is worth knowing when it tries.
   *
   * `additionalProperties: false` should stop this upstream, and relying on a
   * provider to enforce OUR security property would be the wrong place to put
   * trust. In production a run of these warnings is a prompt-injection
   * signal: something in the conversation is persuading the model that it
   * should be reading someone else's money.
   */
  private warnOnIdentityArguments(name: string, args: Record<string, unknown>): void {
    const suspicious = Object.keys(args).filter((key) =>
      IDENTITY_KEYS.includes(key.toLowerCase()),
    );

    if (suspicious.length > 0) {
      this.logger.warn(
        `Tool "${name}" was called with identity-shaped arguments ` +
        `[${suspicious.join(', ')}] — ignored. Identity comes from the JWT. ` +
        `Repeated occurrences may indicate prompt injection.`,
      );
    }
  }

  // ──────────────────────────────────────────────────────────────── tools

  private async runSearchKnowledge(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecution> {
    const q = args['q'];
    if (typeof q !== 'string' || q.trim().length === 0) {
      return { ok: false, name, error: 'Argument "q" is required and must be a non-empty string.' };
    }
    if (q.length > 500) {
      return { ok: false, name, error: 'Argument "q" must be 500 characters or fewer.' };
    }

    let limit: number | undefined;
    const rawLimit = args['limit'];
    if (rawLimit !== undefined) {
      // A non-integer is a SHAPE error the model must fix; an out-of-range
      // integer is a MAGNITUDE error we can safely correct. Rejecting the
      // first and clamping the second is not inconsistency — one is a
      // misunderstanding of the contract, the other is overreach within it.
      if (!Number.isInteger(rawLimit)) {
        return { ok: false, name, error: 'Argument "limit" must be an integer.' };
      }
      limit = Math.min(Math.max(1, rawLimit as number), MAX_LIMIT);
    }

    return { ok: true, name, result: await this.retrieval.searchKnowledge(q, { limit }) };
  }

  private async runSpendByCategory(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecution> {
    const period = args['period'];
    if (!isPeriod(period)) {
      return {
        ok: false,
        name,
        error: `Argument "period" must be one of: ${PERIODS.join(', ')}.`,
      };
    }

    // `context.userId`, never `args`. This is the line the whole step exists
    // to make true.
    //
    // `context.now` for the same reason, and so that every tool call within a
    // single answer resolves against one instant rather than re-reading the
    // clock each time.
    return {
      ok: true,
      name,
      result: await this.aggregates.spendByCategory(context.userId, period, context.now),
    };
  }
}
