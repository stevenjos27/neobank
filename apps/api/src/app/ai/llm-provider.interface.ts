/**
 * The single seam between NeoBank and any LLM.
 *
 * Its real value isn't "swap to Gemini later" — it's that cost tracking,
 * prompt versioning, retries, and the mock that lets Step 5's evals run in
 * CI without a key all have exactly one place to live.
 */

export const LLM_PROVIDER_TOKEN = 'LLM_PROVIDER_TOKEN';

// ──────────────────────────────────────────────────────────────────── tools

/**
 * A tool the model may choose to call.
 *
 * `parameters` is raw JSON Schema, and that is a deliberate limit on how
 * provider-agnostic this seam pretends to be. JSON Schema is what OpenAI,
 * Anthropic and Gemini all accept, so inventing a neutral schema language
 * and a translator for it would be machinery solving a problem nobody has.
 * Where the providers genuinely agree, agreeing with them is the abstraction.
 */
export type ToolDefinition = {
  name: string;
  /**
   * The model reads this to decide WHEN to call the tool, so it is part of
   * the prompt, not documentation. Vague descriptions are the usual cause of
   * a model answering a numeric question from thin air instead of calling
   * the tool that knows the answer.
   */
  description: string;
  parameters: Record<string, unknown>;
};

/**
 * A tool call the model asked for.
 *
 * `argumentsJson` is the RAW string the model produced, not a parsed object,
 * and that is the most important decision in this file.
 *
 * Models emit malformed JSON. Parsing in the adapter would mean either
 * throwing away an otherwise usable response, or making the adapter decide
 * what counts as valid — a judgement that belongs with the rest of the
 * argument validation, in one place, next to the schema it validates
 * against. Keeping the string raw means the adapter's job stays transport,
 * a parse failure joins every other validation failure on one code path,
 * and the exact text the model produced survives into the logs.
 *
 * Same reasoning as the categoriser parsing defensively in one spot rather
 * than trusting the shape at three.
 */
export type ToolCall = {
  /** Provider-assigned. Must be echoed on the `tool` message that answers it. */
  id: string;
  name: string;
  argumentsJson: string;
};

// ───────────────────────────────────────────────────────────────── messages

/**
 * A discriminated union rather than one shape with optional fields.
 *
 * A `tool` message without a `toolCallId` is meaningless — the provider
 * cannot match it to the call it answers — and a flat type with
 * `toolCallId?: string` lets you construct exactly that and find out at
 * runtime. Same principle as the exhaustive `Record<TransactionType, …>` in
 * the aggregates service: make the compiler refuse the malformed question.
 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export type ChatRequest = {
  messages: ChatMessage[];
  /** Callers choose per use case: 0 for categorisation, low for answers. */
  temperature?: number;
  /** A cost ceiling, not a style preference. */
  maxOutputTokens?: number;
  /**
   * Offered, never forced. There is deliberately no `toolChoice` option:
   * model-driven routing was chosen precisely so questions are not
   * pre-classified, and adding a way to force a tool would smuggle the
   * deterministic router back in through a side door. The trigger for
   * revisiting is explicit — if Step 5's evals show the model answering
   * numeric questions without calling a tool, `toolChoice: 'required'` is
   * the lever, justified by measurement rather than by anticipation.
   */
  tools?: ToolDefinition[];
  /**
   * `'json'` asks the provider to constrain output to a JSON object.
   * Closes gap #15: the categoriser currently asks for JSON in prose and
   * parses hopefully.
   *
   * NOTE for the adapter: OpenAI's JSON mode requires the word "JSON" to
   * appear somewhere in the messages and will error without it. That
   * constraint belongs in the adapter, not in every caller.
   */
  responseFormat?: 'text' | 'json';
};

/**
 * Why the model stopped. Required, not optional.
 *
 * `'length'` is the one that earns this field's existence: it means the
 * response was truncated against `maxOutputTokens`. Today the categoriser
 * cannot see that — a truncated JSON array arrives looking exactly like a
 * model that produced garbage, and the discard path fires for the wrong
 * reason. Batch size is tuned to avoid this, which is a guess that this
 * field turns into an observation.
 */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other';

export type ChatResult = {
  text: string;
  /**
   * Always an array — empty when the model requested nothing, never
   * undefined. Optionality here would buy nothing and cost a `?.length` at
   * every call site; "no tools requested" is a normal value, not an absence.
   */
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
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
