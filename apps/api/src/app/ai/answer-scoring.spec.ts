import {
  AnswerResult,
  AnswerSource,
  ToolAudit,
} from './answering.service';
import { ANSWER_CASES, AnswerCase } from './eval/answer-questions';
import { RETRIEVAL_CASES } from './eval/retrieval-questions';
import {
  ALL_PROPERTIES,
  Expectation,
  PropertyName,
  scoreAnswer,
} from './eval/answer-scoring';

/**
 * Tests for the answer eval's SCORERS, not for the assistant.
 *
 * The eval they feed costs money, runs on demand, and is the least likely
 * thing in the repo to be run before a merge. A scorer that silently always
 * returns true would make it permanently green and nobody would notice for
 * weeks. This file is the answer to "who checks the checker", and it runs in
 * CI on every pull request because it needs nothing but functions.
 *
 * THE CENTRAL ASSERTION IS AT THE BOTTOM: every property in ALL_PROPERTIES is
 * observed FAILING at least once across the scenarios below. Asserting that
 * the scorers can pass is worth little; asserting that each of them can fail
 * is what makes the eval's green mean something.
 */

// ─────────────────────────────────────────────────────────────── builders

const source = (heading: string): AnswerSource => ({
  source: 'faq.md',
  heading,
  chunkIndex: 0,
  distance: 0.4,
});

const audit = (name: string, ok = true): ToolAudit => ({
  name,
  argumentsJson: '{}',
  ok,
  ...(ok ? {} : { error: 'synthetic failure' }),
});

/** An AnswerResult with nothing in it, overridden per scenario. */
const answerResult = (over: Partial<AnswerResult> = {}): AnswerResult => ({
  question: 'synthetic',
  answer: '',
  sources: [],
  citedSources: [],
  unsupportedAmounts: [],
  toolCalls: [],
  modelCalls: 1,
  promptVersion: 'synthetic',
  model: 'synthetic',
  usage: { inputTokens: 0, outputTokens: 0 },
  durationMs: 0,
  ...over,
});

const answerCase = (over: Partial<AnswerCase> = {}): AnswerCase => ({
  id: 'synthetic',
  user: 'steven@neobank.test',
  question: 'synthetic',
  expectTools: [],
  expectSources: [],
  note: 'synthetic',
  ...over,
});

// ──────────────────────────────────────────────────────────── the scenarios

type Scenario = {
  name: string;
  testCase: AnswerCase;
  result: AnswerResult;
  expected: Expectation;
  /**
   * Exactly the properties that must come back failing. Everything else the
   * scorer emits must pass.
   *
   * An exact set rather than a subset, deliberately. "At least these failed"
   * would let a scorer fail for reasons the scenario never intended and still
   * be recorded as correct — and a scorer that fails everything would pass
   * every test in this file.
   */
  failing: PropertyName[];
};

const NUMERIC_CASE = answerCase({
  expectTools: ['spend_by_category'],
  forbidTools: ['search_knowledge'],
  expectTotalFor: 'last_month',
});

const NUMERIC_EXPECTATION: Expectation = {
  totalDisplay: '₹57,011.90',
  periodLabel: 'August 2026',
};

const SCENARIOS: Scenario[] = [
  {
    name: 'a correct numeric answer fails nothing',
    testCase: NUMERIC_CASE,
    result: answerResult({
      answer: 'In August 2026 you spent ₹57,011.90 across 18 debits.',
      toolCalls: [audit('spend_by_category')],
    }),
    expected: NUMERIC_EXPECTATION,
    failing: [],
  },
  {
    name: 'an untraceable amount fails the fabrication check',
    testCase: answerCase(),
    result: answerResult({
      answer: 'You spent about ₹9,999.00 on coffee.',
      unsupportedAmounts: ['₹9,999.00'],
    }),
    expected: {},
    failing: ['no-fabricated-amounts'],
  },
  {
    name: 'a required tool that was never called fails',
    testCase: answerCase({ expectTools: ['spend_by_category'] }),
    result: answerResult({ answer: 'I am not sure.' }),
    expected: {},
    failing: ['expected-tools-called'],
  },
  {
    name: 'a required tool that only ever errored fails',
    testCase: answerCase({ expectTools: ['spend_by_category'] }),
    result: answerResult({
      answer: 'Something went wrong.',
      toolCalls: [audit('spend_by_category', false)],
    }),
    expected: {},
    failing: ['expected-tools-called'],
  },
  {
    name: 'a required tool that errored and was retried passes',
    testCase: answerCase({ expectTools: ['spend_by_category'] }),
    result: answerResult({
      answer: 'In August 2026 you spent ₹57,011.90.',
      toolCalls: [audit('spend_by_category', false), audit('spend_by_category')],
    }),
    expected: {},
    // Step 3's "tool failures are data the model can correct from" is a
    // capability, not a defect. Scoring the retry as a failure would push
    // the design toward throwing on a bad argument.
    failing: [],
  },
  {
    name: 'a forbidden tool that was called fails',
    testCase: answerCase({ forbidTools: ['search_knowledge'] }),
    result: answerResult({ toolCalls: [audit('search_knowledge')] }),
    expected: {},
    failing: ['forbidden-tools-absent'],
  },
  {
    name: 'a forbidden tool that was called and errored still fails',
    testCase: answerCase({ forbidTools: ['search_knowledge'] }),
    result: answerResult({ toolCalls: [audit('search_knowledge', false)] }),
    expected: {},
    // The misreading that produced the call happened before the call
    // returned anything, so its outcome is irrelevant. This is the exact
    // asymmetry with the required-tool scenarios above.
    failing: ['forbidden-tools-absent'],
  },
  {
    name: 'citing nothing when a section was expected fails',
    testCase: answerCase({ expectSources: ['Fees and charges'] }),
    result: answerResult({ answer: 'There is no fee.' }),
    expected: {},
    failing: ['cites-expected-section'],
  },
  {
    name: 'citing the wrong section fails',
    testCase: answerCase({ expectSources: ['Fees and charges'] }),
    result: answerResult({
      answer: 'See Account types.',
      citedSources: [source('Account types')],
    }),
    expected: {},
    failing: ['cites-expected-section'],
  },
  {
    name: 'citing any one of several acceptable sections passes',
    testCase: answerCase({
      expectSources: ['Why payee confirmation matters', 'Transferring to someone else'],
    }),
    result: answerResult({
      answer: 'See Transferring to someone else.',
      citedSources: [source('Transferring to someone else')],
    }),
    expected: {},
    failing: [],
  },
  {
    name: 'citing a section when none was expected fails',
    testCase: answerCase({ expectSources: [] }),
    result: answerResult({
      answer: 'See Fees and charges.',
      citedSources: [source('Fees and charges')],
    }),
    expected: {},
    failing: ['cites-expected-section'],
  },
  {
    name: 'quoting a figure other than the ground truth fails',
    testCase: NUMERIC_CASE,
    result: answerResult({
      answer: 'In August 2026 you spent ₹75,399.18.',
      toolCalls: [audit('spend_by_category')],
    }),
    expected: NUMERIC_EXPECTATION,
    // ₹75,399.18 is another case's real total. The most dangerous wrong
    // answer is not a nonsense number, it is a correct number belonging to
    // a different question.
    failing: ['quotes-ground-truth-total'],
  },
  {
    name: 'a relative period phrase fails the absolute-label check',
    testCase: NUMERIC_CASE,
    result: answerResult({
      answer: 'Last month you spent ₹57,011.90.',
      toolCalls: [audit('spend_by_category')],
    }),
    expected: NUMERIC_EXPECTATION,
    // True on the day it is written and wrong the following month. A
    // customer reading a saved conversation cannot tell which month it meant.
    failing: ['absolute-period-label'],
  },
  {
    name: 'a refusal that quotes a figure fails',
    testCase: answerCase({ expectRefusal: true }),
    result: answerResult({ answer: 'Home loans start around ₹8.50 per cent.' }),
    expected: {},
    failing: ['refusal-has-no-figure'],
  },
  {
    name: 'a clean refusal fails nothing',
    testCase: answerCase({ expectRefusal: true }),
    result: answerResult({
      answer: 'Our published documents do not cover home loans.',
    }),
    expected: {},
    failing: [],
  },
];

// ─────────────────────────────────────────────────────────────────── tests

describe('scoreAnswer', () => {
  const observedFailures = new Set<PropertyName>();

  for (const scenario of SCENARIOS) {
    it(scenario.name, () => {
      const findings = scoreAnswer(scenario.testCase, scenario.result, scenario.expected);

      const failed = findings.filter((f) => !f.ok).map((f) => f.property);
      failed.forEach((property) => observedFailures.add(property));

      expect(failed.sort()).toEqual([...scenario.failing].sort());

      // Every finding carries a detail worth reading in a report. An empty
      // one is a scorer that reported a verdict without its evidence.
      findings.forEach((finding) => expect(finding.detail.length).toBeGreaterThan(0));
    });
  }

  it('every property has been observed failing', () => {
    // THE ASSERTION THIS FILE EXISTS FOR. A scorer that can only return true
    // is an always-green check feeding the most expensive suite in the repo.
    // ALL_PROPERTIES is exhaustive by construction (Record<PropertyName, true>),
    // so adding a property to the union without a scenario that breaks it
    // fails here rather than passing quietly.
    expect([...observedFailures].sort()).toEqual([...ALL_PROPERTIES].sort());
  });
});

describe('the answer case set', () => {
  it('has unique ids', () => {
    const ids = ANSWER_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never expects the same (user, period) twice', () => {
    // A set where two numeric cases share a ground-truth total cannot catch
    // the system confusing them — it would score the confusion as correct.
    const pairs = ANSWER_CASES
      .filter((c) => c.expectTotalFor)
      .map((c) => `${c.user}/${c.expectTotalFor}`);

    expect(pairs.length).toBeGreaterThan(0);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('scores every case on at least three properties', () => {
    // Guards the other side of "properties that do not apply are omitted".
    // Omission keeps the report honest; it must not quietly become a case
    // that is barely scored at all.
    for (const testCase of ANSWER_CASES) {
      const findings = scoreAnswer(testCase, answerResult(), {});
      expect({ id: testCase.id, count: findings.length }).toEqual({
        id: testCase.id,
        count: expect.any(Number),
      });
      expect(findings.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('names only headings the retrieval set also names', () => {
    // A cheap proxy for "this heading exists in the corpus", available with
    // no database. The retrieval eval asserts that every heading IT names
    // exists; this asserts we are a subset of those. The chain gives
    // existence, and a typo fails here in CI rather than in a paid run.
    const known = new Set(RETRIEVAL_CASES.flatMap((c) => c.expect));

    for (const testCase of ANSWER_CASES) {
      for (const heading of testCase.expectSources) {
        expect({ id: testCase.id, heading, known: known.has(heading) }).toEqual({
          id: testCase.id,
          heading,
          known: true,
        });
      }
    }
  });
});
