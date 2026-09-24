import { ToolCall } from './llm-provider.interface';
import { PERIODS } from './period';
import { MAX_LIMIT, RetrievalService } from './retrieval.service';
import { AggregatesService } from './aggregates.service';
import { ToolRegistryService } from './tool-registry.service';

/**
 * Fakes that RECORD rather than assert, so each test can make its own claim
 * about what reached the service underneath. The interesting properties here
 * are about what gets passed through — especially the identity — so the
 * arguments have to be inspectable.
 */
class FakeRetrieval {
  calls: Array<{ q: string; limit?: number }> = [];

  async searchKnowledge(q: string, options?: { limit?: number }) {
    this.calls.push({ q, limit: options?.limit });
    return { query: q, embeddingModel: 'fake', limit: options?.limit ?? 5, maxDistance: 0.62, hits: [] };
  }
}

class FakeAggregates {
  calls: Array<{ userId: string; period: string; now: Date }> = [];

  async spendByCategory(userId: string, period: string, now: Date) {
    this.calls.push({ userId, period, now });
    return { total: '₹0.00' };
  }
}

const call = (name: string, argumentsJson: string): ToolCall => ({
  id: 'call-1',
  name,
  argumentsJson,
});

/**
 * A fixed instant rather than `new Date()`. A spec that reads the wall clock
 * has expectations that depend on when it runs — and the property under test
 * here is precisely that the clock arrives through the context rather than
 * from ambient state, so reading ambient state to check it would be circular.
 *
 * The project's canonical anchor, so there is one reference instant across
 * the harness. Nothing in this file touches the fixture; it is the same date
 * for the same reason, not a dependency on it.
 */
const NOW = new Date('2026-09-15T12:00:00Z');

describe('ToolRegistryService', () => {
  const CONTEXT = { userId: 'user-under-test', now: NOW };

  let retrieval: FakeRetrieval;
  let aggregates: FakeAggregates;
  let registry: ToolRegistryService;

  beforeEach(() => {
    retrieval = new FakeRetrieval();
    aggregates = new FakeAggregates();
    registry = new ToolRegistryService(
      retrieval as unknown as RetrievalService,
      aggregates as unknown as AggregatesService,
    );
  });

  describe('the schemas handed to the model', () => {
    it('exposes neither an identity nor the retrieval threshold', () => {
      // A test on ABSENCE, the same species as "the prompt does not contain
      // the transaction id". Adding `userId` would be an account-enumeration
      // hole; adding `maxDistance` would hand the model the dial that
      // disables grounding by widening the threshold until something comes
      // back. Both are the kind of thing added later for convenience by
      // someone who hasn't read this file, and this is what notices.
      const serialised = JSON.stringify(registry.definitions());

      expect(serialised).not.toMatch(/userid/i);
      expect(serialised).not.toMatch(/accountid/i);
      expect(serialised).not.toMatch(/maxdistance/i);
    });

    it('offers exactly the two tools Step 3 built', () => {
      expect(registry.definitions().map((tool) => tool.name).sort()).toEqual([
        'search_knowledge',
        'spend_by_category',
      ]);
    });
  });

  describe('argument parsing', () => {
    it('reports malformed JSON as data rather than throwing', async () => {
      await expect(
        registry.execute(call('search_knowledge', '{"q": '), CONTEXT),
      ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('valid JSON') });
    });

    it('rejects a JSON array where an object is required', async () => {
      await expect(
        registry.execute(call('search_knowledge', '["overdraft"]'), CONTEXT),
      ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('JSON object') });
    });

    it('treats empty arguments as an empty object, not a parse error', async () => {
      // Providers send "" for a tool they believe takes nothing. The error
      // must then name the MISSING ARGUMENT rather than blaming the JSON,
      // because only one of those is something the model can act on.
      await expect(
        registry.execute(call('search_knowledge', ''), CONTEXT),
      ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('"q"') });
    });
  });

  it('names the real tools when the model invents one', async () => {
    await expect(
      registry.execute(call('transfer_money', '{}'), CONTEXT),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/search_knowledge[\s\S]*spend_by_category/),
    });
  });

  describe('search_knowledge', () => {
    it('requires a non-empty q and does not reach retrieval', async () => {
      await expect(
        registry.execute(call('search_knowledge', '{"q": "   "}'), CONTEXT),
      ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('"q"') });

      expect(retrieval.calls).toHaveLength(0);
    });

    it('rejects a q over 500 characters', async () => {
      await expect(
        registry.execute(
          call('search_knowledge', JSON.stringify({ q: 'a'.repeat(501) })),
          CONTEXT,
        ),
      ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('500') });
    });

    it('rejects a non-integer limit — a shape error the model must fix', async () => {
      await expect(
        registry.execute(call('search_knowledge', '{"q":"fees","limit":2.5}'), CONTEXT),
      ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('integer') });
    });

    it('CLAMPS an out-of-range limit instead of rejecting it', async () => {
      // The asymmetry, asserted rather than merely commented. A non-integer
      // is a misunderstanding of the contract; an over-large integer is
      // overreach within it, and killing a whole turn over that trades a
      // trivial excess for no answer at all.
      const result = await registry.execute(
        call('search_knowledge', '{"q":"fees","limit":50}'),
        CONTEXT,
      );

      expect(result).toMatchObject({ ok: true });
      expect(retrieval.calls[0].limit).toBe(MAX_LIMIT);
    });
  });

  describe('spend_by_category', () => {
    it('enumerates the valid periods when given a bad one', async () => {
      await expect(
        registry.execute(call('spend_by_category', '{"period":"last_week"}'), CONTEXT),
      ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('last_month') });

      expect(aggregates.calls).toHaveLength(0);
    });

    it('accepts every declared period', async () => {
      for (const period of PERIODS) {
        await expect(
          registry.execute(call('spend_by_category', JSON.stringify({ period })), CONTEXT),
        ).resolves.toMatchObject({ ok: true });
      }

      expect(aggregates.calls).toHaveLength(PERIODS.length);
    });

    it('IGNORES an identity supplied in the arguments and uses the JWT subject', async () => {
      // The test this whole step exists for.
      //
      // A model persuaded — by a crafted transaction description, a pasted
      // message, anything at all — to ask for someone else's spending must be
      // STRUCTURALLY unable to get it, not merely discouraged from asking.
      //
      // Note it still succeeds rather than erroring: the identity is ignored
      // and logged, not rejected. Ignoring is exactly as safe, because no
      // code path reads an identity from arguments, and it avoids turning a
      // stray field into a dead conversation turn. The warning is what makes
      // a run of these visible as a prompt-injection signal.
      await registry.execute(
        call('spend_by_category', '{"period":"last_month","userId":"someone-elses-id"}'),
        CONTEXT,
      );

      expect(aggregates.calls).toEqual([
        { userId: 'user-under-test', period: 'last_month', now: NOW },
      ]);
    });

    it('ignores a time supplied in the arguments and uses the context instant', async () => {
      // The companion to the identity test above, and for the same reason.
      //
      // `now` is not the model's to choose. A model that could supply the
      // current instant could resolve "last month" against a date it
      // invented, and the answer would be confidently wrong about which
      // month it was describing — wrong in a way no reader could detect,
      // because the figures would be internally consistent.
      //
      // As with identity, the call SUCCEEDS with the stray field ignored
      // rather than rejected. Nothing reads a date from arguments, so
      // ignoring is exactly as safe and does not cost a conversation turn.
      await registry.execute(
        call('spend_by_category', '{"period":"last_month","now":"2020-01-01T00:00:00Z"}'),
        CONTEXT,
      );

      expect(aggregates.calls).toEqual([
        { userId: 'user-under-test', period: 'last_month', now: NOW },
      ]);
    });
  });
});
