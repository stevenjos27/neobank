import OpenAI, { APIError } from 'openai';
import {
  ChatMessage,
  ChatRequest,
  ChatResult,
  EmbedResult,
  FinishReason,
  LlmError,
  LlmErrorKind,
  LlmProvider,
  ToolCall,
  ToolDefinition
} from './llm-provider.interface';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Dimensions are a property of the MODEL, not an independent setting. Keeping
 * them here rather than in an env var means the two can never disagree — the
 * model name is the single input, the width is derived.
 */
const EMBEDDING_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
};

/** 429 codes that mean "out of money", not "slow down". */
const SPEND_LIMIT_CODES = new Set([
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'insufficient_quota',
]);

@Injectable()
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  readonly chatModel: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;

  private readonly logger = new Logger(OpenAiProvider.name);
  private readonly client: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set. Add it to .env (see .env.example).');
    }

    this.chatModel = process.env.AI_CHAT_MODEL ?? 'gpt-4o-mini';
    this.embeddingModel = process.env.AI_EMBEDDING_MODEL ?? 'text-embedding-3-small';

    const dimensions = EMBEDDING_DIMENSIONS[this.embeddingModel];
    if (!dimensions) {
      throw new Error(
        `Unknown embedding model "${this.embeddingModel}". Add its dimensions to ` +
        `EMBEDDING_DIMENSIONS in openai.provider.ts — the pgvector column width ` +
        `must match, so this cannot be guessed at runtime.`,
      );
    }

    this.embeddingDimensions = dimensions;

    /**
 * Env-configurable, default 30 seconds.
 *
 * Production measures ~1.2s per embedding call, so 30s is 25x headroom
 * there, and a hung request should not hold a connection longer than that.
 * But a developer machine is not production. On 24 Sep five consecutive
 * curl calls to the embeddings endpoint from this repo's dev machine
 * returned 200 in 70.9s, 32.9s, 0.9s and 99.9s, plus one 502 at 55.2s,
 * with OpenAI reporting no API incident.
 *
 * A 30s client timeout on that link aborts precisely the calls that would
 * have succeeded, retries twice, and surfaces "Connection error" — a
 * failure caused by our own ceiling rather than by the network. Raise it
 * locally (AI_REQUEST_TIMEOUT_MS=120000) when the link is bad; leave the
 * default alone in production, where 30s is the right ceiling.
 */
    const timeoutMs = Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 30_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `AI_REQUEST_TIMEOUT_MS must be a positive number of milliseconds, got ` +
        `"${process.env.AI_REQUEST_TIMEOUT_MS}".`,
      );
    }

    this.client = new OpenAI({
      apiKey,
      // Stated rather than inherited, so the retry and timeout behaviour of
      // this app is visible in this file. Note the SDK will retry a
      // spend-limit 429 twice before we ever see it — a small, known waste we
      // can remove later with a custom shouldRetry if it starts to matter.
      maxRetries: 2,
      timeout: timeoutMs,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    // Checked BEFORE the try, because this is a programming error in our own
    // caller, not a provider condition. OpenAI's JSON mode rejects a request
    // whose messages never mention JSON, with an error that explains nothing
    // about why. Failing here names the actual requirement.
    if (request.responseFormat === 'json') {
      const mentionsJson = request.messages.some((message) => /json/i.test(message.content));
      if (!mentionsJson) {
        throw new Error(
          `responseFormat 'json' requires the word "JSON" to appear in the messages. ` +
          `This is OpenAI's constraint on json_object mode, not ours.`,
        );
      }
    }

    try {
      const completion = await this.client.chat.completions.create({
        model: this.chatModel,
        messages: this.toOpenAiMessages(request.messages),
        // Deterministic by default. A bank answering the same question two
        // different ways is a support ticket; callers opt IN to variation.
        // This applies to TOOL SELECTION too, which is the more important
        // half now: a model that picks a different tool for the same question
        // on alternate runs makes every eval meaningless.
        temperature: request.temperature ?? 0,
        max_completion_tokens: request.maxOutputTokens ?? 800,
        ...(request.tools?.length ? { tools: this.toOpenAiTools(request.tools) } : {}),
        ...(request.responseFormat === 'json'
          ? { response_format: { type: 'json_object' as const } }
          : {}),
      });

      const choice = completion.choices[0];
      const toolCalls = this.readToolCalls(choice?.message?.tool_calls);
      const text = choice?.message?.content ?? '';

      // THE CHANGE THAT MAKES TOOL CALLING POSSIBLE AT ALL.
      //
      // This used to throw whenever `content` was falsy. But when a model
      // requests a tool, `content` is null BY DESIGN and the payload lives in
      // `tool_calls` — so the old guard would have rejected every successful
      // tool call as an empty completion. Emptiness is only a failure when
      // the model returned neither prose nor a tool request.
      if (text.length === 0 && toolCalls.length === 0) {
        throw new LlmError('unknown', 'Model returned neither content nor a tool call');
      }

      return {
        text,
        toolCalls,
        finishReason: this.toFinishReason(choice?.finish_reason),
        model: completion.model,
        usage: {
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
        },
      };
    }
    catch (error) {
      throw this.toLlmError(error, 'chat');
    }
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) {
      // Not an error, and not worth a round trip.
      return { vectors: [], model: this.embeddingModel, usage: { inputTokens: 0 } };
    }

    try {
      const response = await this.client.embeddings.create({
        model: this.embeddingModel,
        input: texts,
      });

      // The API does NOT guarantee response order — each item carries an
      // `index`. Zipping by array position without sorting can attach the
      // wrong vector to the wrong transaction, and nothing downstream would
      // look wrong: searches would just quietly return nonsense.
      const vectors = [...response.data]
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);

      if (vectors.length !== texts.length) {
        throw new LlmError(
          'unknown',
          `Expected ${texts.length} embeddings, received ${vectors.length}`,
        );
      }

      const width = vectors[0]?.length;
      if (width !== this.embeddingDimensions) {
        // Catches a model whose real width disagrees with our registry before
        // Postgres rejects the insert with an error naming neither.
        throw new LlmError(
          'unknown',
          `Model "${this.embeddingModel}" returned ${width}-dimension vectors,` + ` expected ${this.embeddingDimensions}`);
      }

      return {
        vectors,
        model: response.model,
        usage: { inputTokens: response.usage?.prompt_tokens ?? 0 },
      };
    }
    catch (error) {
      throw this.toLlmError(error, 'embed');
    }
  }

  /**
 * Our message shape → OpenAI's.
 *
 * This mapper should always have existed. Until the interface grew a `tool`
 * role, `messages: request.messages` was passed straight through and
 * typechecked purely because our `{role, content}` happened to be a
 * structural subset of OpenAI's. The message half of this "provider-
 * agnostic" seam was a coincidence, and a second provider would have been
 * the thing to discover that. The compiler found it instead, the moment the
 * two shapes first disagreed.
 *
 * No return annotation, deliberately: the SDK's message type lives behind a
 * deep import path that moves between versions, and the assignability check
 * happens at the `create()` call site anyway. An annotation here would only
 * relocate the error message, not add a check.
 */
  private toOpenAiMessages(messages: ChatMessage[]) {
    return messages.map((message) => {
      switch (message.role) {
        case 'tool':
          // camelCase → snake_case. This single rename is what broke the
          // pass-through, and it is the whole reason this method exists.
          return {
            role: 'tool' as const,
            tool_call_id: message.toolCallId,
            content: message.content,
          };

        case 'assistant':
          return message.toolCalls?.length
            ? {
              role: 'assistant' as const,
              content: message.content,
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                // `arguments` goes back as the RAW string we received.
                // Re-serialising a parsed object would change the bytes the
                // model saw, and the provider matches on them.
                function: { name: call.name, arguments: call.argumentsJson },
              })),
            }
            : { role: 'assistant' as const, content: message.content };

        default:
          return { role: message.role, content: message.content };
      }
    });
  }

  private toOpenAiTools(tools: ToolDefinition[]) {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        // Deliberately NOT `strict: true`. Structured Outputs' strict mode
        // requires every property to appear in `required` and
        // `additionalProperties: false` throughout — which our optional
        // `limit` and `maxDistance` arguments violate by design. The trigger
        // for revisiting is the model inventing argument names, which the
        // registry's validation will report.
      },
    }));
  }

  private toFinishReason(reason: string | null | undefined): FinishReason {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'tool_calls':
        return 'tool_calls';
      case 'length':
        return 'length';
      default:
        // Covers content_filter, the legacy function_call, and anything
        // OpenAI adds later. Collapsed rather than enumerated, because a
        // caller can act on the three above and not on the rest.
        return 'other';
    }
  }

  private readToolCalls(calls: unknown): ToolCall[] {
    if (!Array.isArray(calls)) return [];

    const out: ToolCall[] = [];
    for (const call of calls) {
      // OpenAI has begun adding non-function tool call types. Skipping what
      // we don't understand beats crashing on a field we never requested.
      if (call?.type !== 'function' || !call.function) continue;
      out.push({
        id: call.id,
        name: call.function.name,
        argumentsJson: call.function.arguments,
      });
    }
    return out;
  }

  /**
   * Collapse the SDK's error surface into the five kinds callers can act on.
   *
   * The important split is inside 429: OpenAI uses it both for "you are
   * sending requests too fast" (retryable, transient) and "you have hit your
   * spend cap" (not retryable by anyone but us). Treating them alike means a
   * retry loop against a dead endpoint and a user told to slow down when the
   * real problem is billing.
   */

  private toLlmError(error: unknown, operation: string): LlmError {
    if (error instanceof LlmError) return error;

    if (error instanceof APIError) {
      const code = typeof error.code === 'string' ? error.code : '';

      let kind: LlmErrorKind = 'unknown';

      if (error.status === 429) {
        kind = SPEND_LIMIT_CODES.has(code) ? 'spend_limit' : 'rate_limit';
      } else if (error.status === 401 || error.status === 403) {
        kind = 'auth';
      } else if (error.status === 408) {
        kind = 'timeout';
      }

      // Log the kind and status, never the request body — prompts can carry
      // user financial data, and the key must never reach a log line.
      this.logger.warn(`${operation} failed: ${kind} (status ${error.status}, code ${code})`);
      return new LlmError(kind, `LLM ${operation} failed: ${kind}`, error);
    }

    if (error instanceof Error && error.name === 'APIConnectionTimeoutError') {
      return new LlmError('timeout', `LLM ${operation} timed out`, error);
    }

    this.logger.error(`${operation} failed with an unrecognised error`);
    return new LlmError('unknown', `LLM ${operation} failed`, error);
  }
}
