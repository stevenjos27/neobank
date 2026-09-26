import { Inject, Injectable, Logger } from '@nestjs/common';
import { findUnsupportedAmounts, isAmountSupported } from './amounts';
import {
  ChatMessage,
  LLM_PROVIDER_TOKEN,
  LlmProvider,
} from './llm-provider.interface';
import { ToolContext, ToolRegistryService } from './tool-registry.service';
import { ASSISTANT_PROMPT_VERSION, ASSISTANT_SYSTEM_PROMPT } from './assistant-prompt';
import { AmountGuard } from './amount-guard';

/**
 * Three model calls, and the last one is offered NO TOOLS.
 *
 * Withholding the tools on the final call makes the cap STRUCTURAL rather
 * than policed: the model cannot request another round, so there is no
 * "we ignored what it asked for" branch to get wrong. Calls one and two do
 * carry tools, which is what makes Step 3's "tool failures are data the model
 * can correct from" an actual capability rather than an aspiration — a
 * rejected argument in round one can be fixed in round two.
 *
 * The common case costs two calls. Three happens only when the model needs a
 * genuine second tool round, which for two tools is rare, since OpenAI issues
 * parallel tool calls and a compound question is served in one.
 */
const MAX_MODEL_CALLS = 3;

/** Enough for two or three sentences plus a tool-call payload. */
const MAX_OUTPUT_TOKENS = 600;

/**
 * Shown INSTEAD OF the model's answer when an amount cannot be traced to a
 * tool result. Deliberately says what happened without implying the figure
 * was wrong — we know it was unverifiable, not that it was incorrect.
 */
const WITHHELD_ANSWER =
  'I could not verify one of the figures in my answer, so I have not shown it. ' +
  'Please check your transaction history, or contact support if something looks wrong.';

export type AnswerSource = {
  source: string;
  heading: string;
  chunkIndex: number;
  distance: number;
};

export type ToolAudit = {
  name: string;
  argumentsJson: string;
  ok: boolean;
  error?: string;
};

export type AnswerResult = {
  question: string;
  answer: string;
  /**
   * Every knowledge chunk retrieved, named or not.
   *
   * An audit field. It answers "what was this answer allowed to be built
   * from?", which is the question Step 5's evals ask. It is NOT a citation
   * list, and the comment it replaces calling it "the authoritative citation
   * list" is exactly the error this change fixes.
   */
  sources: AnswerSource[];
  /**
   * The subset of `sources` whose heading appears in `answer`.
   *
   * The only field a customer may be shown as citations, because it is the
   * only one where every entry is a passage the answer actually names. The
   * first real run retrieved three passages and used one; publishing all
   * three would have credited two the answer never touched, and a reader who
   * follows one of those two and finds nothing relevant learns to distrust
   * all three. An over-broad citation list is worse than none.
   *
   * Derived from the FINAL `answer`, after any suppression below, so the
   * invariant is mechanical: every heading here is present in the string
   * sitting next to it in this object.
   */
  citedSources: AnswerSource[];
  /**
   * Monetary amounts in the answer that appear in NO tool result.
   *
   * Empty is the good case. A non-empty entry is a fabricated or reformatted
   * figure, and for a banking assistant that is the worst failure mode there
   * is — worse than refusing, because it is indistinguishable from a correct
   * answer to the person reading it.
   */
  unsupportedAmounts: string[];
  /**
   * The model's original text, present ONLY when it was withheld. Kept so the
   * Step 5 evals and the logs can see what was suppressed; the customer-facing
   * route must never return it.
   */
  withheldAnswer?: string;
  toolCalls: ToolAudit[];
  modelCalls: number;
  promptVersion: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
};

/**
 * What a streaming consumer is told while the answer is built.
 *
 * `tool` fills the wait with something true — the model is searching the
 * documents, or looking up spending — rather than a spinner.
 *
 * `delta` is text that has already passed the amount guard. Nothing reaches a
 * customer unverified.
 *
 * `reset` means discard what was published: a round wrote text and then asked
 * for a tool, so that text is not part of the answer.
 *
 * `withheld` means discard everything and show the notice. Whole-answer
 * suppression, the same semantics as the buffered path.
 */
export type AnswerStreamEvent =
  | { type: 'tool'; name: string }
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'withheld' };

export type AnswerSink = (event: AnswerStreamEvent) => void;

@Injectable()
export class AnsweringService {
  private readonly logger = new Logger(AnsweringService.name);

  constructor(
    @Inject(LLM_PROVIDER_TOKEN) private readonly llm: LlmProvider,
    private readonly tools: ToolRegistryService,
  ) { }

  /** Answer, buffered. Nothing is returned until the whole reply exists. */
  answer(question: string, context: ToolContext): Promise<AnswerResult> {
    return this.run(question, context);
  }

  /**
   * Answer, streamed. Returns the SAME AnswerResult as `answer`, and reports
   * progress through `sink` along the way — the provider seam's chat/chatStream
   * pair one layer up, for the same reason: one loop, one set of guardrails,
   * and a result that cannot differ by delivery mode.
   *
   * `sink` governs what the CUSTOMER sees. The returned result is computed
   * exactly as the buffered path computes it, so unsupportedAmounts,
   * withheldAnswer and citedSources are identical either way. That is what lets
   * the answer eval keep meaning something about both.
   */
  answerStream(
    question: string,
    context: ToolContext,
    sink: AnswerSink,
  ): Promise<AnswerResult> {
    return this.run(question, context, sink);
  }

  private async run(
    question: string,
    context: ToolContext,
    sink?: AnswerSink,
  ): Promise<AnswerResult> {
    const startedAt = Date.now();

    const messages: ChatMessage[] = [
      { role: 'system', content: ASSISTANT_SYSTEM_PROMPT },
      { role: 'user', content: question },
    ];

    const audit: ToolAudit[] = [];
    const sources: AnswerSource[] = [];
    // Every tool payload the model was shown, serialised. This is the ground
    // truth the answer is checked against below.
    const toolPayloads: string[] = [];

    const usage = { inputTokens: 0, outputTokens: 0 };
    let modelCalls = 0;
    let answer = '';
    let model = this.llm.chatModel;

    for (let call = 1; call <= MAX_MODEL_CALLS; call++) {
      const isFinalCall = call === MAX_MODEL_CALLS;

      const request = {
        messages,
        temperature: 0,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // The structural cap. See MAX_MODEL_CALLS.
        tools: isFinalCall ? undefined : this.tools.definitions(),
      };

      // One guard per round, closing over `toolPayloads` — the LIVE array, so
      // by the round that produces the answer, every payload the model was
      // shown is already in it. A round that answers before any tool has run
      // has nothing to verify against, and an amount there is held back: a
      // figure no tool produced is a figure the model invented.
      const guard = new AmountGuard((amount) => isAmountSupported(amount, toolPayloads));
      let published = 0;

      const result = sink
        ? await this.llm.chatStream(request, (delta) => {
          // Nothing to do when the guard withholds — it stops itself, and the
          // definitive verdict comes from findUnsupportedAmounts over the
          // finished text below. One policy, computed once, so the stream and
          // the returned result cannot disagree about the same answer.
          const out = guard.push(delta);
          if (out.text) {
            published += out.text.length;
            sink({ type: 'delta', text: out.text });
          }
        })
        : await this.llm.chat(request);

      if (sink) {
        const tail = guard.end();
        if (tail.text) {
          published += tail.text.length;
          sink({ type: 'delta', text: tail.text });
        }
      }

      modelCalls = call;
      model = result.model;
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;

      if (result.finishReason === 'length') {
        // Not an error, but the answer is a fragment. Worth a log line rather
        // than silence: before `finishReason` existed this was invisible.
        this.logger.warn(
          `Answer truncated against maxOutputTokens on call ${call} — the reply is incomplete`,
        );
      }

      if (result.toolCalls.length === 0) {
        answer = result.text;
        break;
      }


      // A round that both wrote text and asked for a tool. The buffered path
      // discards such text too — `answer` is only ever taken from the tool-free
      // round — so anything published here is not part of the answer and the
      // client is told to drop it. Empirically the model does one or the other;
      // this exists so the rare case is correct rather than invisible.
      if (published > 0) {
        sink?.({ type: 'reset' });
      }

      // The assistant's own turn must be replayed back verbatim, including the
      // calls it made — the provider matches the `tool` messages below against
      // these ids, and a missing assistant turn makes the ids unresolvable.
      messages.push({
        role: 'assistant',
        content: result.text,
        toolCalls: result.toolCalls,
      });

      for (const toolCall of result.toolCalls) {
        // Before execution, not after. The point of the event is to fill the
        // wait, and the wait IS the execution.
        sink?.({ type: 'tool', name: toolCall.name });

        const execution = await this.tools.execute(toolCall, context);

        if ('error' in execution) {
          // `in` narrowing, not `execution.ok` — see gap #13.
          audit.push({
            name: toolCall.name,
            argumentsJson: toolCall.argumentsJson,
            ok: false,
            error: execution.error,
          });
          messages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            content: JSON.stringify({ error: execution.error }),
          });
          continue;
        }

        const payload = JSON.stringify(execution.result);
        toolPayloads.push(payload);

        audit.push({
          name: toolCall.name,
          argumentsJson: toolCall.argumentsJson,
          ok: true,
        });

        this.collectSources(execution.result, sources);

        messages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          content: payload,
        });
      }
    }

    // From ./amounts, shared with the streaming guard rather than duplicated.
    // Two implementations of this rule would mean the same answer could be
    // suppressed when buffered and published when streamed.
    const unsupportedAmounts = findUnsupportedAmounts(answer, toolPayloads);
    let withheldAnswer: string | undefined;

    if (unsupportedAmounts.length > 0) {
      // Suppression, not annotation. Returning the answer with a warning
      // attached would put the decision on whoever renders it, and every
      // renderer would eventually show the figure — a warning beside a number
      // is read as a caveat, not a retraction.
      this.logger.error(
        `Withholding answer: ${unsupportedAmounts.length} amount(s) absent from every ` +
        `tool result: ${unsupportedAmounts.join(', ')}`,
      );
      withheldAnswer = answer;
      answer = WITHHELD_ANSWER;
      sink?.({ type: 'withheld' });
    }

    // Computed AFTER suppression and against `answer`, not against the model's
    // original text: what we publish as citations has to describe the string we
    // publish. A withheld answer names no heading, so this empties itself —
    // emergent, not a special case, which is why the spec can assert it.
    //
    // Substring match rather than the prompt's "Per <heading>" form. The model
    // wrote `According to the heading "Insufficient funds"` in the first real
    // run, and a form-matcher would have scored that correct answer as uncited.
    // The cost is over-crediting a one-word heading — "Deposits", "Currency" —
    // that the prose happens to contain; such a passage had to be retrieved to
    // be a candidate at all, so the over-credit is plausible rather than false.
    const citedSources = sources.filter((source) => answer.includes(source.heading));

    // Not an `else` on the branch above. A withheld answer cites nothing by
    // construction, so chaining them would report the guardrail working as a
    // grounding failure, at WARN, next to the ERROR that already explained it.

    if (withheldAnswer === undefined && sources.length > 0 && citedSources.length === 0) {
      this.logger.warn(
        `Answer cites none of the ${sources.length} retrieved section(s) — it may be ` +
        `prose rather than grounded in what was returned`,
      );
    }

    return {
      question,
      answer,
      withheldAnswer,
      sources,
      citedSources,
      unsupportedAmounts,
      toolCalls: audit,
      modelCalls,
      promptVersion: ASSISTANT_PROMPT_VERSION,
      model,
      usage,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Pull the citation list out of a knowledge search result.
   *
   * Duck-typed rather than switched on tool name, because the registry owns
   * tool names and this only cares about shape. `hits` with `heading` is a
   * knowledge result; anything else contributes no sources.
   */
  private collectSources(result: unknown, into: AnswerSource[]): void {
    const hits = (result as { hits?: unknown })?.hits;
    if (!Array.isArray(hits)) return;

    for (const hit of hits) {
      if (!hit || typeof hit.heading !== 'string') continue;
      into.push({
        source: hit.source,
        heading: hit.heading,
        chunkIndex: hit.chunkIndex,
        distance: hit.distance,
      });
    }
  }

}
