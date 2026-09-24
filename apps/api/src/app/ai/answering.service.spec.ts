import {
  ChatRequest,
  ChatResult,
  EmbedResult,
  LlmProvider,
  ToolCall,
} from './llm-provider.interface';
import { AggregatesService } from './aggregates.service';
import { RetrievalService } from './retrieval.service';
import { ToolRegistryService } from './tool-registry.service';
import { AnsweringService } from './answering.service';
import { ASSISTANT_PROMPT_VERSION, ASSISTANT_SYSTEM_PROMPT } from './assistant-prompt';

/**
 * A provider that replays a scripted sequence and records what it was asked.
 *
 * Recording the requests is the point: several properties of this service are
 * about what it SENDS — that the final call carries no tools, that the system
 * prompt leads, that a tool error reaches the model — and none of those are
 * visible in the return value.
 */
class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly chatModel = 'scripted-chat';
  readonly embeddingModel = 'scripted-embed';
  readonly embeddingDimensions = 1536;

  readonly requests: ChatRequest[] = [];
  private readonly queue: ChatResult[];

  constructor(...replies: Array<Partial<ChatResult>>) {
    this.queue = replies.map((reply) => ({
      text: '',
      toolCalls: [],
      finishReason: 'stop',
      model: 'scripted-chat',
      usage: { inputTokens: 5, outputTokens: 7 },
      ...reply,
    }));
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (!next) {
      // A failure message that names the actual problem. Running dry means the
      // service made more model calls than the test expected, which is a
      // finding about the loop rather than about the stub.
      throw new Error(
        'ScriptedProvider ran out of replies — the service made more model calls than scripted',
      );
    }
    return next;
  }

  async embed(): Promise<EmbedResult> {
    // AnsweringService must never embed directly; retrieval owns that.
    throw new Error('embed() must not be called by AnsweringService');
  }
}

class FakeRetrieval {
  async searchKnowledge(q: string) {
    return {
      query: q,
      embeddingModel: 'fake',
      limit: 5,
      maxDistance: 0.62,
      // TWO hits, the second irrelevant to any question the tests ask.
      //
      // This mirrors the first real run: three passages retrieved, one used.
      // A single-hit fake cannot express the difference between "retrieved"
      // and "cited", so under it the bug we are fixing was invisible — the
      // old assertions passed while the route shipped over-broad citations.
      // Its distance is 0.58, comfortably inside the 0.62 threshold: this is
      // a passage that legitimately cleared retrieval and is still the wrong
      // answer, not a near-miss that better tuning would have excluded.
      hits: [
        {
          source: 'neobank-faq.md',
          heading: 'Insufficient funds',
          chunkIndex: 8,
          content: 'NeoBank does not offer an overdraft.',
          distance: 0.43,
        },
        {
          source: 'neobank-faq.md',
          heading: 'Closing an account',
          chunkIndex: 16,
          content: 'You can close an account from Settings once its balance is zero.',
          distance: 0.58,
        },
      ],
    };
  }
}

class FakeAggregates {
  readonly calls: Array<{ userId: string; period: string; now: Date }> = [];

  async spendByCategory(userId: string, period: string, now: Date) {
    this.calls.push({ userId, period, now });
    return {
      period,
      periodLabel: 'August 2026',
      from: '2026-07-31T18:30:00.000Z',
      to: '2026-08-31T18:30:00.000Z',
      currency: 'INR',
      categories: [
        { category: 'Cash', totalPaise: '1000000', total: '₹10,000.00', count: 1 },
      ],
      totalPaise: '1000000',
      total: '₹10,000.00',
      uncategorisedCount: 0,
    };
  }
}

const toolCall = (name: string, args: unknown): ToolCall => ({
  id: `call-${name}`,
  name,
  argumentsJson: JSON.stringify(args),
});

const SEARCH = toolCall('search_knowledge', { q: 'overdraft?' });
const SPEND = toolCall('spend_by_category', { period: 'last_month' });

/**
 * A fixed instant rather than `new Date()`. A spec that reads the wall clock
 * has expectations that depend on when it runs — and what this file asserts
 * is that the clock arrives through the context rather than from ambient
 * state, so reading ambient state to check it would be circular.
 *
 * Deliberately duplicated from tool-registry.service.spec.ts rather than
 * shared. Extracting it would imply these unit specs depend on the seed
 * fixture; they do not. It is the project's reference instant used for
 * recognisability, not a coupling.
 */
const NOW = new Date('2026-09-15T12:00:00Z');

describe('AnsweringService', () => {
  const CONTEXT = { userId: 'user-under-test', now: NOW };

  let retrieval: FakeRetrieval;
  let aggregates: FakeAggregates;

  const build = (provider: ScriptedProvider) => {
    retrieval = new FakeRetrieval();
    aggregates = new FakeAggregates();
    const registry = new ToolRegistryService(
      retrieval as unknown as RetrievalService,
      aggregates as unknown as AggregatesService,
    );
    return new AnsweringService(provider, registry);
  };

  describe('the loop', () => {
    it('offers no tools on the final call, structurally capping the rounds', async () => {
      // Two tool rounds then a forced answer. The third request must carry no
      // tools at all — the cap is enforced by withholding them, not by us
      // ignoring what the model asks for, so there is no ignore-branch to get
      // wrong.
      const provider = new ScriptedProvider(
        { toolCalls: [SEARCH], finishReason: 'tool_calls' },
        { toolCalls: [SPEND], finishReason: 'tool_calls' },
        { text: 'NeoBank does not offer an overdraft.' },
      );

      const result = await build(provider).answer('do I have an overdraft?', CONTEXT);

      expect(provider.requests).toHaveLength(3);
      expect(provider.requests[0].tools).toBeDefined();
      expect(provider.requests[1].tools).toBeDefined();
      expect(provider.requests[2].tools).toBeUndefined();
      expect(result.modelCalls).toBe(3);
    });

    it('leads with the system prompt and the question', async () => {
      const provider = new ScriptedProvider({ text: 'I cannot move money.' });
      await build(provider).answer('transfer ₹500 for me', CONTEXT);

      expect(provider.requests[0].messages[0]).toEqual({
        role: 'system',
        content: ASSISTANT_SYSTEM_PROMPT,
      });
      expect(provider.requests[0].messages[1]).toEqual({
        role: 'user',
        content: 'transfer ₹500 for me',
      });
    });

    it('answers in one call when the model requests no tools', async () => {
      // The "can you transfer money for me?" shape: refusable from the prompt
      // alone, with nothing to retrieve.
      const provider = new ScriptedProvider({
        text: 'I cannot move money — use the Transfer screen.',
      });

      const result = await build(provider).answer('send ₹100 to Priya', CONTEXT);

      expect(result.modelCalls).toBe(1);
      expect(result.toolCalls).toHaveLength(0);
      expect(result.sources).toHaveLength(0);
    });

    it('accumulates usage across every call', async () => {
      const provider = new ScriptedProvider(
        { toolCalls: [SEARCH], finishReason: 'tool_calls' },
        { text: 'No overdraft.' },
      );

      const result = await build(provider).answer('overdraft?', CONTEXT);

      // 5 in / 7 out per scripted reply, two replies.
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 14 });
    });
  });

  describe('tool errors are data the model can act on', () => {
    it('returns a rejected argument to the model, which corrects it', async () => {
      // This is what makes Step 3's error-as-data design a capability rather
      // than decoration: without a second tool round the model could never
      // act on the message the registry produced.
      const provider = new ScriptedProvider(
        {
          toolCalls: [toolCall('spend_by_category', { period: 'last_week' })],
          finishReason: 'tool_calls',
        },
        { toolCalls: [SPEND], finishReason: 'tool_calls' },
        { text: 'In August 2026 you spent ₹10,000.00.' },
      );

      const result = await build(provider).answer('what did I spend?', CONTEXT);

      expect(result.toolCalls[0]).toMatchObject({
        name: 'spend_by_category',
        ok: false,
        error: expect.stringContaining('period'),
      });
      expect(result.toolCalls[1]).toMatchObject({ ok: true });

      // And the error genuinely reached the model rather than only the audit.
      const secondCall = JSON.stringify(provider.requests[1].messages);
      expect(secondCall).toContain('last_month');
      expect(aggregates.calls).toEqual([{ userId: 'user-under-test', period: 'last_month', now: NOW }]);
    });
  });

  describe('the context crosses the loop unchanged', () => {
    it('uses the JWT subject even when the model supplies a userId argument', async () => {
      // The Step 3 property, re-asserted one layer up. The registry has its
      // own test for this; what this covers is that AnsweringService passes
      // the context through rather than assembling one from the model's turn.
      //
      // The assertion now covers `now` as well as `userId`, which is the
      // point of naming the block after the context rather than after
      // identity: the invariant is that nothing between the controller and
      // the tool gets to rewrite what the server knows, and it should keep
      // holding as fields are added.
      const provider = new ScriptedProvider(
        {
          toolCalls: [
            toolCall('spend_by_category', { period: 'last_month', userId: 'someone-else' }),
          ],
          finishReason: 'tool_calls',
        },
        { text: 'In August 2026 you spent ₹10,000.00.' },
      );

      await build(provider).answer('what did I spend?', CONTEXT);

      expect(aggregates.calls).toEqual([
        { userId: 'user-under-test', period: 'last_month', now: NOW },
      ]);
    });
  });

  describe('fabricated amounts', () => {
    it('flags an amount that appears in no tool result', async () => {
      // The worst failure a banking assistant has: a figure that is
      // indistinguishable from a correct one to whoever reads it.
      const provider = new ScriptedProvider(
        { toolCalls: [SPEND], finishReason: 'tool_calls' },
        { text: 'In August 2026 you spent ₹99,999.00.' },
      );

      const result = await build(provider).answer('what did I spend?', CONTEXT);

      expect(result.unsupportedAmounts).toEqual(['₹99,999.00']);
      expect(result.answer).not.toContain('₹99,999.00');
      expect(result.withheldAnswer).toBe('In August 2026 you spent ₹99,999.00.');
    });

    it('accepts an amount quoted verbatim from a tool result', async () => {
      const provider = new ScriptedProvider(
        { toolCalls: [SPEND], finishReason: 'tool_calls' },
        { text: 'In August 2026 you spent ₹10,000.00.' },
      );

      const result = await build(provider).answer('what did I spend?', CONTEXT);

      expect(result.unsupportedAmounts).toEqual([]);
      expect(result.answer).toBe('In August 2026 you spent ₹10,000.00.');
      expect(result.withheldAnswer).toBeUndefined();
    });

    it('flags a REFORMATTED amount, deliberately', async () => {
      // ₹10000.00 is arithmetically the same as the ₹10,000.00 the tool
      // returned, and it is still flagged. The instruction is to quote
      // exactly; a model that reformats is processing figures rather than
      // repeating them, which is one step from computing them. A false
      // positive here is a useful signal, not noise.
      const provider = new ScriptedProvider(
        { toolCalls: [SPEND], finishReason: 'tool_calls' },
        { text: 'In August 2026 you spent ₹10000.00.' },
      );

      const result = await build(provider).answer('what did I spend?', CONTEXT);

      expect(result.unsupportedAmounts).toEqual(['₹10000.00']);
    });
  });

  describe('citations', () => {
    const INSUFFICIENT_FUNDS = {
      source: 'neobank-faq.md',
      heading: 'Insufficient funds',
      chunkIndex: 8,
      distance: 0.43,
    };
    const CLOSING_AN_ACCOUNT = {
      source: 'neobank-faq.md',
      heading: 'Closing an account',
      chunkIndex: 16,
      distance: 0.58,
    };

    it('credits only the passage the answer names, not everything retrieved', async () => {
      const provider = new ScriptedProvider(
        { toolCalls: [SEARCH], finishReason: 'tool_calls' },
        { text: 'Per Insufficient funds, NeoBank does not offer an overdraft.' },
      );

      const result = await build(provider).answer('overdraft?', CONTEXT);

      // Both retrieved — that is the audit trail, and Step 5 needs it whole.
      expect(result.sources).toEqual([INSUFFICIENT_FUNDS, CLOSING_AN_ACCOUNT]);
      // One named — that is the citation list, and it is what the customer sees.
      expect(result.citedSources).toEqual([INSUFFICIENT_FUNDS]);
    });

    it('credits nothing when the answer names nothing', async () => {
      // Empty is the correct result here, not a fallback to `sources`. An
      // ungrounded answer with no citations is honest; the same answer with
      // two citations attached is a false evidence claim. The WARN log is how
      // we find out the model drifted.
      const provider = new ScriptedProvider(
        { toolCalls: [SEARCH], finishReason: 'tool_calls' },
        { text: 'You cannot go overdrawn.' },
      );

      const result = await build(provider).answer('overdraft?', CONTEXT);

      expect(result.sources).toHaveLength(2);
      expect(result.citedSources).toEqual([]);
    });

    it('credits nothing for a WITHHELD answer, even though the model cited one', async () => {
      // The ordering test, and the only one in this block that distinguishes
      // "derived from the returned answer" from "derived from the model's
      // text". The model named a heading and that text survives in
      // `withheldAnswer`, but the customer is shown the withheld notice, which
      // names nothing — so nothing may be credited. Deriving `citedSources`
      // one block earlier passes the two tests above and fails only this one.
      const provider = new ScriptedProvider(
        { toolCalls: [SEARCH], finishReason: 'tool_calls' },
        { text: 'Per Insufficient funds, the shortfall was ₹99,999.00.' },
      );

      const result = await build(provider).answer('overdraft?', CONTEXT);

      expect(result.unsupportedAmounts).toEqual(['₹99,999.00']);
      expect(result.withheldAnswer).toContain('Insufficient funds');
      expect(result.citedSources).toEqual([]);
    });
  });

  it('carries the prompt version, so a score can be attributed to a prompt', async () => {
    const provider = new ScriptedProvider({ text: 'No.' });
    const result = await build(provider).answer('anything', CONTEXT);

    expect(result.promptVersion).toBe(ASSISTANT_PROMPT_VERSION);
  });
});
