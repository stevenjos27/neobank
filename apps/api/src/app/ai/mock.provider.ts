import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  ChatRequest,
  ChatResult,
  EmbedResult,
  LlmProvider,
  ToolDefinition
} from './llm-provider.interface';

/**
 * Must match the pgvector column width, exactly as the real provider's does.
 * A mock that produced 8-dimension vectors would pass every unit test and
 * fail on the INSERT, which is the one place a mock must not diverge.
 */
const MOCK_DIMENSIONS = 1536;

/**
 * A deterministic, offline LlmProvider.
 *
 * WHAT THIS IS FOR: letting CI exercise the whole AI pipeline — chunking,
 * batching, the ref-echo validation, the vector writes, the pgvector column
 * width — with no API key, no network, no spend, and byte-identical results
 * on every run.
 *
 * WHAT THIS IS NOT FOR, and the distinction matters: this provider has no
 * semantics. Its vectors are hashes, so "how much did I spend on food" and
 * "what is my balance" land in unrelated directions with no relationship to
 * meaning. Retrieval QUALITY therefore cannot be measured against it. Step 5
 * has to run two kinds of eval and must not confuse them:
 *
 *   - plumbing evals, on the mock, in CI, on every PR
 *   - answer-quality evals, on the real model, on demand, costing money
 *
 * A green CI run here says the pipeline is wired correctly. It says nothing
 * at all about whether the assistant gives good answers.
 */
@Injectable()
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  readonly chatModel = 'mock-chat-v1';
  readonly embeddingModel = 'mock-embedding-v1';
  readonly embeddingDimensions = MOCK_DIMENSIONS;

  private readonly logger = new Logger(MockLlmProvider.name);

  constructor() {
    // Loud on purpose. A mock selected by accident in an environment that was
    // meant to use the real model would otherwise look like a working system
    // producing meaningless categories.
    this.logger.warn(
      'Using the MOCK LLM provider. Responses are deterministic and carry no ' +
      'semantic meaning. Never enable this outside tests and CI.',
    );
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    const prompt = lastUser?.content ?? '';

    // ── tool selection ───────────────────────────────────────────────────
    //
    // Chosen BY HASH, not by reading the question. That is the point, and it
    // is worth being explicit about because a keyword router would be easy
    // and would quietly destroy this file's honesty: the mock would start to
    // look as though it understood intent, and Step 5's plumbing evals could
    // then be mistaken for routing-quality evals.
    //
    // Deterministic and meaningless is exactly the contract. It gives CI what
    // it actually needs — both tool paths exercised, arguments well formed,
    // byte-identical across runs — while proving nothing whatsoever about
    // whether the routing is sensible. That question costs money and belongs
    // in the answer-quality suite.
    if (request.tools?.length) {
      const tool = request.tools[this.hashInt(prompt) % request.tools.length];

      return {
        text: '',
        toolCalls: [
          {
            id: `mock-call-${this.hashInt(prompt).toString(16)}`,
            name: tool.name,
            argumentsJson: JSON.stringify(this.synthesiseArguments(tool, prompt)),
          },
        ],
        finishReason: 'tool_calls',
        model: this.chatModel,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    const text = this.respondTo(prompt);

    return {
      // If JSON was requested, the reply must BE JSON. `respondTo` already
      // returns JSON for the categorisation shape it recognises; for anything
      // else it returns prose, which would violate the contract the caller
      // just asked for. Checked by parsing rather than by string-sniffing, and
      // handled here rather than inside `respondTo` so the categorisation
      // branch that the contract test covers stays untouched.
      text: request.responseFormat === 'json' && !this.isJson(text)
        ? JSON.stringify({ note: 'mock response', model: this.chatModel })
        : text,
      toolCalls: [],
      finishReason: 'stop',
      model: this.chatModel,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  private isJson(value: string): boolean {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    return {
      vectors: texts.map((text) => this.pseudoVector(text)),
      model: this.embeddingModel,
      usage: { inputTokens: 0 },
    };
  }

  // ───────────────────────────────────────────────────────────────── chat

  /**
   * The categoriser asks for a JSON array keyed by numeric `ref`. Recognising
   * that shape and answering it correctly is what lets CI exercise the
   * categorisation write path end to end — the upserts, the taxonomy
   * validation, the ref-echo and duplicate checks — rather than silently
   * producing zero verdicts.
   *
   * Sniffing the request to decide the response shape is admittedly a hack.
   * It is contained to this file, it is the only thing that makes the mock
   * useful rather than merely present, and the alternative (a second mock per
   * call site) is worse.
   */
  private respondTo(prompt: string): string {
    const items = this.parseCategorisationRequest(prompt);
    if (items) {
      return JSON.stringify(
        items.map((item) => ({
          ref: item.ref,
          // Seeded on the DESCRIPTION, not the ref. A ref is only a position
          // within its batch, so seeding on it would give every batch the
          // same category sequence — batch 3 item 7 would always match batch
          // 9 item 7. Seeding on the description keeps a category stable per
          // transaction across runs, which is what determinism should mean
          // here.
          category: this.pseudoCategory(item.description ?? String(item.ref)),
          confidence: 0.5,
        })),
      );
    }

    return 'This is a mock response. No model was called.';
  }

  private parseCategorisationRequest(
    prompt: string,
  ): Array<{ ref: number; description?: string }> | null {
    try {
      const value = JSON.parse(prompt.trim());
      if (!Array.isArray(value)) return null;
      return value.every((v) => v && Number.isInteger(v.ref)) ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Deliberately NOT importing TRANSACTION_CATEGORIES from the categoriser.
   *
   * A mock that draws from the same constant as the code under test can never
   * fail the taxonomy check, so that validation would go permanently
   * unexercised. Listing a few values independently means the mock is a real
   * second opinion: if someone renames a category, this file keeps returning
   * the old name and the discard path lights up, which is exactly what should
   * happen.
   */
  private pseudoCategory(seed: string): string {
    const options = ['Food & Dining', 'Transport', 'Shopping', 'Transfers', 'Income'];
    return options[this.hashInt(seed) % options.length];
  }

  /**
 * Build arguments FROM THE TOOL'S OWN SCHEMA, never from knowledge of what
 * the tool is called.
 *
 * The alternative — `if (tool.name === 'spendByCategory') return { period:
 * 'last_month' }` — is the same anti-pattern this file already refuses for
 * categories. A double that hardcodes what the code under test expects can
 * never disagree with it, so the validation it is supposed to exercise goes
 * permanently dead. Generating generically keeps the mock a second opinion:
 * a schema the registry's validator cannot actually accept shows up as a
 * rejected mock call in CI, which is precisely what should happen.
 *
 * Happy path only. Malformed arguments are `StubProvider`'s job — the same
 * division of labour as `categoriser.service.spec.ts`, where the mock
 * behaves and the stub misbehaves on demand.
 */
  private synthesiseArguments(tool: ToolDefinition, seed: string): Record<string, unknown> {
    const schema = tool.parameters as {
      properties?: Record<string, { type?: string; enum?: unknown[] }>;
      required?: string[];
    };

    const properties = schema.properties ?? {};
    // No `required` list means every property is fair game — more coverage,
    // and a schema that forgot to declare `required` is worth surfacing.
    const required = schema.required ?? Object.keys(properties);

    const args: Record<string, unknown> = {};

    for (const name of required) {
      const property = properties[name];
      if (!property) continue;

      // Enums are picked by hash of seed AND property name, so one question
      // does not send every enum argument to the same index — that would
      // leave most of `resolvePeriod` unexercised across a whole eval suite.
      if (Array.isArray(property.enum) && property.enum.length > 0) {
        args[name] = property.enum[this.hashInt(`${seed}:${name}`) % property.enum.length];
        continue;
      }

      switch (property.type) {
        case 'string':
          // The question itself, which is genuinely the right value for a
          // search query and harmless anywhere else.
          args[name] = seed.slice(0, 120);
          break;
        case 'integer':
        case 'number':
          args[name] = 3;
          break;
        case 'boolean':
          args[name] = true;
          break;
        default:
          // Loud, like the chunker on an oversized section. Silently emitting
          // null would fail the registry's validation with an error pointing
          // at the model instead of at this file.
          throw new Error(
            `MockLlmProvider cannot synthesise an argument of type ` +
            `"${property.type}" for "${tool.name}.${name}". Add it to ` +
            `synthesiseArguments in mock.provider.ts.`,
          );
      }
    }

    return args;
  }

  // ──────────────────────────────────────────────────────────── embeddings

  /**
   * A unit vector derived from sha256 of the text.
   *
   * Deterministic (same text, same vector, every run and every machine) and
   * normalised, so cosine distance behaves numerically like a real embedding
   * even though the direction is meaningless. Normalising matters: pgvector's
   * HNSW index with `vector_cosine_ops` is built for unit-ish vectors, and an
   * unnormalised mock would exercise a different code path in the index than
   * production does.
   */
  private pseudoVector(text: string): number[] {
    const out = new Array<number>(MOCK_DIMENSIONS);
    let digest = createHash('sha256').update(text).digest();
    let cursor = 0;

    for (let i = 0; i < MOCK_DIMENSIONS; i++) {
      if (cursor + 2 > digest.length) {
        // Re-hash rather than repeat: repeating 32 bytes for 1536 slots would
        // make every vector periodic, and periodic vectors are unnaturally
        // similar to one another.
        digest = createHash('sha256').update(digest).digest();
        cursor = 0;
      }
      // Centre on zero — an all-positive vector sits in one hyperoctant and
      // makes every pair look similar.
      out[i] = digest.readUInt16BE(cursor) / 65535 - 0.5;
      cursor += 2;
    }

    const norm = Math.sqrt(out.reduce((sum, v) => sum + v * v, 0)) || 1;
    return out.map((v) => v / norm);
  }

  private hashInt(seed: string): number {
    return createHash('sha256').update(seed).digest().readUInt32BE(0);
  }
}
