import { Logger } from '@nestjs/common';
import {
  CategorisationInput,
  CategoriserService,
  TRANSACTION_CATEGORIES,
} from './categoriser.service';
import { ChatRequest, ChatResult, EmbedResult, LlmError, LlmProvider } from './llm-provider.interface';
import { MockLlmProvider } from './mock.provider';

/**
 * A stub, not a mock in the MockLlmProvider sense: MockLlmProvider produces
 * plausible answers, whereas this returns whatever a test needs — including
 * malformed answers, which is the point. Every branch in `collect` exists to
 * survive a model behaving badly, and a well-behaved double can never reach
 * any of them.
 */
class StubProvider implements LlmProvider {
  readonly name = 'stub';
  readonly chatModel = 'stub-chat';
  readonly embeddingModel = 'stub-embed';
  readonly embeddingDimensions = 1536;

  readonly prompts: string[] = [];

  constructor(private readonly replies: Array<string | Error>) {}

  async chat(request: ChatRequest): Promise<ChatResult> {
    const user = [...request.messages].reverse().find((m) => m.role === 'user');
    this.prompts.push(user?.content ?? '');

    const reply = this.replies[this.prompts.length - 1];
    if (reply instanceof Error) throw reply;

    return {
      text: reply ?? '[]',
      model: this.chatModel,
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }

  async embed(): Promise<EmbedResult> {
    throw new Error('the categoriser must never call embed()');
  }
}

const inputs = (count: number): CategorisationInput[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
    description: `MERCHANT ${i}`,
    type: 'WITHDRAWAL',
    amountPaise: BigInt((i + 1) * 100),
  }));

const verdict = (ref: number, category = 'Shopping', confidence = 0.9) => ({
  ref,
  category,
  confidence,
});

describe('CategoriserService', () => {
  beforeEach(() => {
    // The service logs a warning on every discard, and several tests
    // deliberately trigger them. Silencing keeps the run readable while
    // leaving the calls assertable.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('maps each ref back to the transaction id it was sent for', async () => {
    const items = inputs(3);
    const provider = new StubProvider([
      JSON.stringify([verdict(0, 'Groceries'), verdict(1, 'Transport'), verdict(2, 'Cash')]),
    ]);

    const { verdicts } = await new CategoriserService(provider).categorise(items);

    expect(verdicts.get(items[0].id)?.category).toBe('Groceries');
    expect(verdicts.get(items[1].id)?.category).toBe('Transport');
    expect(verdicts.get(items[2].id)?.category).toBe('Cash');
  });

  it('restarts refs at zero in every batch and still resolves the right ids', async () => {
    // THE test for ordinal refs. Refs are positions within a batch, not
    // within the whole job, so batch two's ref 0 is item 25. Getting this
    // wrong would assign batch two's categories to batch one's transactions
    // and nothing would look broken — the exact failure the UUID echo was
    // there to prevent, reintroduced by the fix for it.
    const items = inputs(26);
    const provider = new StubProvider([
      JSON.stringify(Array.from({ length: 25 }, (_, i) => verdict(i, 'Shopping'))),
      JSON.stringify([verdict(0, 'Income')]),
    ]);

    const { verdicts } = await new CategoriserService(provider).categorise(items);

    expect(provider.prompts).toHaveLength(2);
    expect(verdicts.size).toBe(26);
    expect(verdicts.get(items[25].id)?.category).toBe('Income');
    expect(verdicts.get(items[0].id)?.category).toBe('Shopping');
  });

  it('discards a ref outside the batch', async () => {
    const items = inputs(2);
    const provider = new StubProvider([JSON.stringify([verdict(0), verdict(7)])]);

    const { verdicts } = await new CategoriserService(provider).categorise(items);

    expect(verdicts.size).toBe(1);
    expect(verdicts.has(items[0].id)).toBe(true);
  });

  it('discards a non-integer ref rather than coercing it', async () => {
    const items = inputs(2);
    const provider = new StubProvider([
      JSON.stringify([{ ref: '0', category: 'Shopping', confidence: 1 }]),
    ]);

    // '0' would index correctly in JavaScript. Accepting it would mean the
    // range check silently stops applying to string refs.
    const { verdicts } = await new CategoriserService(provider).categorise(items);
    expect(verdicts.size).toBe(0);
  });

  it('keeps the first verdict for a duplicated ref and drops the second', async () => {
    const items = inputs(1);
    const provider = new StubProvider([
      JSON.stringify([verdict(0, 'Groceries'), verdict(0, 'Travel')]),
    ]);

    const { verdicts } = await new CategoriserService(provider).categorise(items);

    expect(verdicts.get(items[0].id)?.category).toBe('Groceries');
  });

  it('discards a category outside the taxonomy', async () => {
    const items = inputs(1);
    const provider = new StubProvider([JSON.stringify([verdict(0, 'Coffee Shops')])]);

    // If this ever passes, the closed vocabulary is no longer closed and
    // GROUP BY category stops being meaningful.
    const { verdicts } = await new CategoriserService(provider).categorise(items);
    expect(verdicts.size).toBe(0);
  });

  it('returns no verdicts for an unparseable response', async () => {
    const provider = new StubProvider(['I am afraid I cannot help with that.']);

    const { verdicts } = await new CategoriserService(provider).categorise(inputs(3));
    expect(verdicts.size).toBe(0);
  });

  it('tolerates a response wrapped in a markdown fence', async () => {
    const items = inputs(1);
    const provider = new StubProvider([
      '```json\n' + JSON.stringify([verdict(0, 'Health')]) + '\n```',
    ]);

    const { verdicts } = await new CategoriserService(provider).categorise(items);
    expect(verdicts.get(items[0].id)?.category).toBe('Health');
  });

  it('clamps confidence into 0..1 and defaults a missing one to 0', async () => {
    const items = inputs(3);
    const provider = new StubProvider([
      JSON.stringify([
        verdict(0, 'Shopping', 95),
        verdict(1, 'Shopping', -3),
        { ref: 2, category: 'Shopping' },
      ]),
    ]);

    const { verdicts } = await new CategoriserService(provider).categorise(items);

    expect(verdicts.get(items[0].id)?.confidence).toBe(1);
    expect(verdicts.get(items[1].id)?.confidence).toBe(0);
    expect(verdicts.get(items[2].id)?.confidence).toBe(0);
  });

  it('sends direction and amount but never the transaction id', async () => {
    const items = inputs(1);
    const provider = new StubProvider([JSON.stringify([verdict(0)])]);

    await new CategoriserService(provider).categorise(items);

    const [prompt] = provider.prompts;
    expect(prompt).toContain('WITHDRAWAL');
    expect(prompt).toContain('MERCHANT 0');
    // Every field sent to a third party is a field that can end up in
    // someone else's logs. The id cannot improve a category, so it does not
    // leave the process.
    expect(prompt).not.toContain(items[0].id);
  });

  it('converts paise to rupees', async () => {
    const items: CategorisationInput[] = [
      { id: inputs(1)[0].id, description: 'SWIGGY', type: 'WITHDRAWAL', amountPaise: 54595n },
    ];
    const provider = new StubProvider([JSON.stringify([verdict(0)])]);

    await new CategoriserService(provider).categorise(items);

    expect(provider.prompts[0]).toContain('545.95');
  });

  it('keeps earlier batches when a later one fails transiently', async () => {
    const items = inputs(26);
    const provider = new StubProvider([
      JSON.stringify(Array.from({ length: 25 }, (_, i) => verdict(i))),
      new LlmError('rate_limit', 'slow down'),
    ]);

    const { verdicts } = await new CategoriserService(provider).categorise(items);

    // Discarding 25 good verdicts because the 26th transaction hit a
    // transient limit would mean paying for them twice.
    expect(verdicts.size).toBe(25);
  });

  it('aborts the whole job on a spend limit', async () => {
    const provider = new StubProvider([new LlmError('spend_limit', 'out of credit')]);

    // Unlike a rate limit, this will not recover by itself, so continuing to
    // the next batch only produces more failures and a longer wait.
    await expect(new CategoriserService(provider).categorise(inputs(30))).rejects.toThrow(LlmError);
  });

  it('accumulates token usage across batches', async () => {
    const provider = new StubProvider([
      JSON.stringify(Array.from({ length: 25 }, (_, i) => verdict(i))),
      JSON.stringify([verdict(0)]),
    ]);

    const { inputTokens, outputTokens } = await new CategoriserService(provider).categorise(
      inputs(26),
    );

    expect(inputTokens).toBe(20);
    expect(outputTokens).toBe(10);
  });

  it('returns a usable verdict for every item when driven by MockLlmProvider', async () => {
    // The contract test between the two files. The mock builds its reply from
    // the prompt the categoriser writes, so a change to either side that the
    // other does not follow fails here — which is exactly what happened when
    // the prompt moved from ids to refs.
    const items = inputs(30);

    const { verdicts } = await new CategoriserService(new MockLlmProvider()).categorise(items);

    expect(verdicts.size).toBe(30);
    for (const item of items) {
      const category = verdicts.get(item.id)?.category;
      expect(TRANSACTION_CATEGORIES).toContain(category);
    }
  });

  it('makes no provider call for an empty batch', async () => {
    const provider = new StubProvider([]);

    const { verdicts } = await new CategoriserService(provider).categorise([]);

    expect(verdicts.size).toBe(0);
    expect(provider.prompts).toHaveLength(0);
  });
});
