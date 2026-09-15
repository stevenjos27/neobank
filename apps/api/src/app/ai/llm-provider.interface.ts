/**
 * The single seam between NeoBank and any LLM.
 *
 * Its real value isn't "swap to Gemini later" — it's that cost tracking,
 * prompt versioning, retries, and the mock that lets Step 5's evals run in
 * CI without a key all have exactly one place to live.
 */

/**
 * Nest injection token. An `interface` does not exist at runtime, so it
 * cannot be used as a DI token — hence a string constant, injected with
 * `@Inject(LLM_PROVIDER_TOKEN)`.
 */

export const LLM_PROVIDER_TOKEN = 'LLM_PROVIDER_TOKEN';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ChatRequest = {
  messages: ChatMessage[];
  /** Callers choose per use case: 0 for categorisation, low for answers. */
  temperature?: number;
  /** A cost ceiling, not a style preference. */
  maxOutputTokens?: number;
};

export type ChatResult = {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; };
};

export type EmbedResult = {
  vectors: number[][];
  model: string;
  usage: { inputTokens: number };
};

export type LlmErrorKind =
  | 'rate_limit'    // provider throttling — retryable
  | 'spend_limit'   // out of money — NOT retryable
  | 'auth'          // bad or revoked key
  | 'timeout'
  | 'unknown';

/**
 * OpenAI signals both provider throttling and "you have hit your spend cap"
 * with HTTP 429 — the same status our own ThrottlerGuard uses. Collapsing
 * those three into one error means a retry loop that hammers a dead endpoint,
 * and a user told to "slow down" when the real problem is a billing cap only
 * we can fix. The adapter separates them; `kind` is how callers tell.
 */

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmProvider {
  readonly name: string;
  readonly chatModel: string;
  readonly embeddingModel: string;
  /** Derived from embeddingModel — must match the pgvector column width. */
  readonly embeddingDimensions: number;

  chat(request: ChatRequest): Promise<ChatResult>;
  embed(texts: string[]): Promise<EmbedResult>;
}
