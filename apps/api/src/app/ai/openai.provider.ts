import OpenAI, { APIError } from 'openai';
import {
  ChatRequest,
  ChatResult,
  EmbedResult,
  LlmError,
  LlmErrorKind,
  LlmProvider
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

    this.client = new OpenAI({
      apiKey,
      // Stated rather than inherited, so the retry and timeout behaviour of
      // this app is visible in this file. Note the SDK will retry a
      // spend-limit 429 twice before we ever see it — a small, known waste we
      // can remove later with a custom shouldRetry if it starts to matter.
      maxRetries: 2,
      timeout: 30_000,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    try {
      const completion = await this.client.chat.completions.create({
        model: this.chatModel,
        messages: request.messages,
        // Deterministic by default. A bank answering the same question two
        // different ways is a support ticket; callers opt IN to variation.
        temperature: request.temperature ?? 0,
        max_completion_tokens: request.maxOutputTokens ?? 800,
      });

      const text = completion.choices[0]?.message?.content;
      if (!text) {
        throw new LlmError('unknown', 'Model returned an empty completion');
      }

      return {
        text,
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
