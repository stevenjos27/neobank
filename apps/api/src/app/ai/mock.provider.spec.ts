import { ChatRequest } from './llm-provider.interface';
import { MockLlmProvider } from './mock.provider';

/**
 * The provider seam's streaming contract, asserted rather than assumed.
 *
 * llm-provider.interface.ts states that `result.text` equals the
 * concatenation of every delta passed to `onText`, and gives the reason: the
 * answering service publishes the deltas and runs the fabricated-amount
 * guardrail over `result.text`. If those two could differ, a figure could
 * reach the customer that the guardrail never examined.
 *
 * The real provider cannot be tested here without a key and a network, so
 * this covers the implementation CI actually runs. The equivalent check
 * against OpenAI is the warning that fires inside chatStream when the
 * assembled content and the streamed deltas disagree.
 */

const ask = (content: string, tools?: ChatRequest['tools']): ChatRequest => ({
  messages: [{ role: 'user', content }],
  ...(tools ? { tools } : {}),
});

const SPEND_TOOL: NonNullable<ChatRequest['tools']>[number] = {
  name: 'spend_by_category',
  description: 'Spending by category over a named period.',
  parameters: {
    type: 'object',
    properties: { period: { type: 'string', enum: ['last_month'] } },
    required: ['period'],
  },
};

const collect = async (provider: MockLlmProvider, request: ChatRequest) => {
  const deltas: string[] = [];
  const result = await provider.chatStream(request, (delta) => deltas.push(delta));
  return { deltas, result };
};

describe('MockLlmProvider streaming', () => {
  let provider: MockLlmProvider;

  beforeEach(() => {
    provider = new MockLlmProvider();
  });

  const prompts: Array<[string, string]> = [
    ['prose', 'what is my balance?'],
    ['a categorisation batch', JSON.stringify([{ ref: 1, description: 'SWIGGY*ORDER' }])],
  ];

  for (const [name, prompt] of prompts) {
    it(`${name}: the deltas concatenate to result.text`, async () => {
      const { deltas, result } = await collect(provider, ask(prompt));

      expect(deltas.join('')).toBe(result.text);
      // An empty delta is not a failure of the contract, but it is a wasted
      // SSE frame and a sign the chunking has gone wrong.
      expect(deltas.filter((delta) => delta.length === 0)).toEqual([]);
    });
  }

  it('answers identically whether streamed or buffered', async () => {
    const request = ask('what is my balance?');

    const streamed = (await collect(provider, request)).result;
    const buffered = await provider.chat(request);

    // Not merely the text: tool calls, finish reason and usage must match
    // too, because the answering loop reads all of them and must behave the
    // same way on both paths.
    expect(streamed).toEqual(buffered);
  });

  it('emits more than one delta, so CI exercises the stream guard', async () => {
    const { deltas, result } = await collect(provider, ask('what is my balance?'));

    // THE REASON THIS TEST EXISTS. The guard's only interesting behaviour is
    // holding text back mid-amount, which never happens if the answer arrives
    // in one piece. Someone "simplifying" the mock to emit a single delta
    // would leave CI green while silently retiring that coverage.
    expect({
      length: result.text.length > 10,
      deltas: deltas.length > 1,
    }).toEqual({ length: true, deltas: true });
  });

  it('emits no delta for a tool call, which carries no content', async () => {
    const { deltas, result } = await collect(provider, ask('what did I spend?', [SPEND_TOOL]));

    // The shape of the first two rounds of the answering loop. User-visible
    // text exists only on the final call, so "no deltas" is the normal case
    // rather than an edge one.
    expect({
      deltas: deltas.length,
      text: result.text,
      toolCalls: result.toolCalls.length,
    }).toEqual({ deltas: 0, text: '', toolCalls: 1 });
  });
});
