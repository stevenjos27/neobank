import { AnswerResult } from '../answering.service';
import { AnswerCase } from './answer-questions';

/**
 * The scorers for the answer eval, as PURE FUNCTIONS over an AnswerResult.
 *
 * WHY THIS IS NOT INSIDE THE SPEC. A scorer that always returns `ok: true`
 * makes the eval permanently green, and the eval is the most expensive and
 * least frequently run thing in the harness — the worst possible place for a
 * silent always-pass. Keeping the scoring pure means the fast unit suite can
 * feed it synthetic AnswerResults and assert that each property fails when it
 * should, in CI, for free, with no key and no network.
 *
 * Who tests the tests: this file's answer is "answer-scoring.spec.ts does,
 * and it runs on every pull request."
 *
 * NOTHING HERE READS A FILE OR CALLS A SERVICE. Expectations arrive already
 * computed, so the eval owns the I/O and this owns the judgement. That split
 * is what makes the synthetic tests possible.
 */

export type PropertyName =
  | 'no-fabricated-amounts'
  | 'expected-tools-called'
  | 'forbidden-tools-absent'
  | 'cites-expected-section'
  | 'quotes-ground-truth-total'
  | 'absolute-period-label'
  | 'refusal-has-no-figure';

/**
* Exhaustive by construction. `Record<PropertyName, true>` forces the object
* literal to name every member of the union, so adding a property above
* without adding it here is a compile error rather than a silently untested
* scorer.
*
* Exported because the spec's strongest assertion needs it: every property in
* this list must be observed FAILING at least once across the test scenarios.
* A scorer that can only return true is an always-green check, and the eval it
* feeds is the most expensive and least frequently run thing in the harness —
* the worst place for one to hide.
*/
const PROPERTY_SET: Record<PropertyName, true> = {
  'no-fabricated-amounts': true,
  'expected-tools-called': true,
  'forbidden-tools-absent': true,
  'cites-expected-section': true,
  'quotes-ground-truth-total': true,
  'absolute-period-label': true,
  'refusal-has-no-figure': true,
};

export const ALL_PROPERTIES = Object.keys(PROPERTY_SET) as PropertyName[];

export type Finding = {
  property: PropertyName;
  ok: boolean;
  /** Human-readable, printed in the report and in the failure message. */
  detail: string;
};

export type Expectation = {
  /**
   * The ground-truth debit total for this case's user and period, formatted
   * exactly as the assistant renders money.
   *
   * The FIGURE is independent ground truth — it comes from .seed-facts.json,
   * which the seed computed without touching the aggregate SQL. Only the
   * FORMATTING is shared with the system under test, and that is deliberate:
   * this property is about which number the answer quotes, not about how
   * rupees are punctuated. Layer A asserts the raw paise, and libs/utils has
   * its own tests for the formatter, so the composition still covers both.
   */
  totalDisplay?: string;

  /**
   * The absolute period label the answer must carry, e.g. "August 2026".
   *
   * Present ONLY for calendar-month periods. last_30_days renders as a
   * formatted date range, and re-deriving that string here would produce a
   * check that goes red when the date format changes rather than when the
   * answer is wrong — a test measuring its own expectation.
   *
   * Derived by the eval from the facts file's window, NOT by importing
   * period.ts. Ground truth that shares code with the system is wrong in
   * lockstep with it; the same rule Layer A follows for the IST calendar.
   */
  periodLabel?: string;
};

/**
 * Any rupee amount at all. Independent of answering.service.ts's RUPEE_AMOUNT
 * on purpose — if that regex ever stops matching what the assistant emits,
 * this one should still see the figure and the two should disagree, which is
 * a finding. A shared regex would hide exactly that drift.
 */
const ANY_RUPEE_AMOUNT = /₹\s?[\d,]+(?:\.\d{1,2})?/;

/**
 * Every property that applies to this case, scored.
 *
 * Properties that do not apply are OMITTED rather than reported as passing.
 * A finding that cannot fail is noise in the report and inflates the pass
 * count — `expectTools: []` on a refusal case would otherwise contribute a
 * green "expected tools called" that asserts nothing. The spec guards the
 * other side of this by requiring every case to yield at least three
 * findings, so "omitted" can never quietly become "unscored".
 */
export function scoreAnswer(
  testCase: AnswerCase,
  result: AnswerResult,
  expected: Expectation,
): Finding[] {
  const findings: Finding[] = [];
  const calledOk = new Set(
    result.toolCalls.filter((call) => call.ok).map((call) => call.name),
  );
  const calledAtAll = new Set(result.toolCalls.map((call) => call.name));

  // ── the figure. For a banking assistant this is the one that matters most:
  // a fabricated amount is worse than a refusal, because the customer cannot
  // tell it from a correct answer.
  findings.push({
    property: 'no-fabricated-amounts',
    ok: result.unsupportedAmounts.length === 0,
    detail:
      result.unsupportedAmounts.length === 0
        ? 'every amount traced to a tool result'
        : `untraceable: ${result.unsupportedAmounts.join(', ')}`,
  });

  // ── the tools.
  //
  // Required tools must have SUCCEEDED; forbidden tools must not have been
  // attempted. The asymmetry is deliberate. A required tool that errored and
  // was retried correctly is fine — that is Step 3's "tool failures are data
  // the model can correct from" working as designed. A forbidden tool is
  // forbidden because calling it at all means the question was misread, and
  // the misreading happened before the call returned anything.
  if (testCase.expectTools.length > 0) {
    const missing = testCase.expectTools.filter((name) => !calledOk.has(name));
    findings.push({
      property: 'expected-tools-called',
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `called: ${testCase.expectTools.join(', ')}`
          : `never succeeded: ${missing.join(', ')}`,
    });
  }

  if (testCase.forbidTools?.length) {
    const violations = testCase.forbidTools.filter((name) => calledAtAll.has(name));
    findings.push({
      property: 'forbidden-tools-absent',
      ok: violations.length === 0,
      detail:
        violations.length === 0
          ? `absent: ${testCase.forbidTools.join(', ')}`
          : `called anyway: ${violations.join(', ')}`,
    });
  }

  // ── the citations. Scored against citedSources, never `sources`: the
  // former is the subset the answer actually names, and crediting a passage
  // that was merely retrieved is the error Step 4 exists to have fixed.
  //
  // The failure detail carries BOTH what came back and what was asked for,
  // because "cited nothing" has three different causes and they need
  // different fixes:
  //
  //   retrieved contains the heading  → the model had it and did not use it
  //   retrieved is empty              → nothing survived the threshold
  //   searched is not the question    → the model's rewrite is the problem
  //
  // All three are already in AnswerResult. Leaving them out turns a
  // diagnosable failure into a second paid run.
  const cited = result.citedSources.map((source) => source.heading);
  const retrieved = [...new Set(result.sources.map((source) => source.heading))];
  const searched = result.toolCalls
    .filter((call) => call.name === 'search_knowledge')
    .map((call) => call.argumentsJson);

  if (testCase.expectSources.length === 0) {
    findings.push({
      property: 'cites-expected-section',
      ok: cited.length === 0,
      detail:
        cited.length === 0
          ? 'cited nothing, as expected'
          : `cited unexpectedly: ${cited.join(' | ')}`,
    });
  } else {
    const hit = testCase.expectSources.find((heading) => cited.includes(heading));
    findings.push({
      property: 'cites-expected-section',
      ok: hit !== undefined,
      detail:
        hit !== undefined
          ? `cited "${hit}"`
          : `cited ${cited.length ? cited.join(' | ') : 'nothing'}; ` +
          `expected one of ${testCase.expectSources.join(' | ')}; ` +
          `retrieved ${retrieved.length ? retrieved.join(' | ') : 'nothing'}; ` +
          `searched ${searched.length ? searched.join(' ') : 'never'}`,
    });
  }

  // ── the total, and the date it belongs to.
  if (expected.totalDisplay !== undefined) {
    const ok = result.answer.includes(expected.totalDisplay);
    findings.push({
      property: 'quotes-ground-truth-total',
      ok,
      detail: ok
        ? `quoted ${expected.totalDisplay}`
        : `expected ${expected.totalDisplay}; answer contains ` +
        `${result.answer.match(new RegExp(ANY_RUPEE_AMOUNT, 'g'))?.join(', ') ?? 'no amount'}`,
    });
  }

  if (expected.periodLabel !== undefined) {
    // "In August 2026 you spent ..." rather than "Last month you spent ...".
    // A relative phrase is true on the day it is written and wrong the
    // following month, and a customer reading a saved chat has no way to
    // know which month it meant.
    const ok = result.answer.includes(expected.periodLabel);
    findings.push({
      property: 'absolute-period-label',
      ok,
      detail: ok
        ? `named "${expected.periodLabel}"`
        : `answer does not name "${expected.periodLabel}"`,
    });
  }

  // ── the refusal.
  //
  // KNOWN WEAK, and stated here as well as in the question set so that
  // nobody reading only this file mistakes it for a strong check. It catches
  // an invented FIGURE and an invented CITATION. It does not catch a fluent,
  // uncited, entirely made-up policy answer, because no mechanical signal
  // distinguishes that from a proper refusal. That gap is the harness's only
  // serious candidate for a model judge.
  if (testCase.expectRefusal) {
    const amount = result.answer.match(ANY_RUPEE_AMOUNT);
    findings.push({
      property: 'refusal-has-no-figure',
      ok: amount === null,
      detail: amount === null ? 'no figure quoted' : `quoted ${amount[0]}`,
    });
  }

  return findings;
}
