import { Period } from '../period';

/**
 * The labelled question set for the answer eval — Layer C.
 *
 * WHAT THIS MEASURES THAT THE OTHER LAYERS DO NOT. Layer A proves the tools
 * return the right numbers. Layer B proves retrieval finds the right passage
 * for a given query. Neither says anything about the thing a customer
 * actually receives: whether the model called the tool at all, quoted the
 * figure it was given rather than one it composed, named the month instead of
 * saying "last month", and said "not documented" when the documents do not
 * cover the question.
 *
 * SCORED ON PROPERTIES, NOT PROSE. Every field below is checkable against
 * `AnswerResult` without a second model reading the text. The moment a label
 * requires judgement to score, it stops being a regression test and becomes a
 * second system needing evals of its own.
 *
 * WRITTEN BEFORE RUNNING ANY OF THEM, for the same reason as the retrieval
 * set: a case written while watching output is fitted to current behaviour and
 * scores whatever the system already does as correct. If a case fails, that is
 * a finding about the assistant, not a licence to reword the case.
 *
 * EXPECTED FIGURES ARE NOT IN THIS FILE. They are looked up from
 * prisma/.seed-facts.json at run time, keyed by `user` and `period`. Hardcoding
 * them here would make the set wrong the first time anyone reseeds, and — worse
 * — would make it *quietly* wrong, since a stale expectation and a broken tool
 * are indistinguishable from the failure message.
 *
 * EVERY CASE NAMES THE USER WHO ASKS, and NO TWO NUMERIC CASES EXPECT THE SAME
 * FIGURE. The six `expectTotalFor` cases cover six distinct (user, period)
 * pairs whose ground-truth totals are all different, so a wrong identity and a
 * wrong period both surface as a figure belonging to another case. A set where
 * two cases share a total cannot catch the system confusing them — it would
 * score the confusion as correct. The spec asserts this rather than trusting
 * that whoever edits this file next preserves it by hand.
 */

export type ToolName = 'search_knowledge' | 'spend_by_category';

export type SeededUser =
  | 'admin@neobank.test'
  | 'steven@neobank.test'
  | 'priya@neobank.test';

export type AnswerCase = {
  /** Stable. Used in the Jest test name and in the report, so a failure in CI
   *  logs can be traced to a line in this file without counting cases. */
  id: string;

  /** Whose context the question is asked in. */
  user: SeededUser;

  question: string;

  /** Tools that MUST appear in the audit. */
  expectTools: ToolName[];

  /**
   * Tools that must NOT appear. Separate from "not listed in expectTools"
   * on purpose: for most cases an extra tool call is wasteful but harmless,
   * and only where it indicates a real misunderstanding is it worth failing.
   * Asserting the absence of everything unlisted would turn every harmless
   * extra search into a red eval.
   */
  forbidTools?: ToolName[];

  /**
   * Corpus headings, at least ONE of which must appear in `citedSources`.
   *
   * A list, not a single heading, for the same reason as the retrieval set: a
   * corpus can legitimately answer one question from more than one section,
   * and scoring the alternatives as misses would measure the labeller rather
   * than the assistant.
   *
   * An EMPTY list means the answer must cite NOTHING — either because the
   * question is about the customer's own money (no document answers it) or
   * because the corpus does not cover it at all. Which of those it is comes
   * from `expectRefusal`.
   */
  expectSources: string[];

  /**
   * When set, the ground-truth debit total for this user and period must
   * appear in the answer, and the answer must carry the period's absolute
   * label rather than the relative phrase the customer used.
   */
  expectTotalFor?: Period;

  /**
   * The corpus does not answer this. The answer must cite nothing and must
   * contain no rupee figure.
   *
   * KNOWN WEAK. A fluent answer from general knowledge that happens to cite
   * nothing passes this check. That is the one property in the harness with no
   * mechanical signal, and the only serious candidate so far for a model
   * judge. Recorded rather than pretended away.
   */
  expectRefusal?: boolean;

  /** Why this case exists. Read when it fails. */
  note: string;
};

export const ANSWER_CASES: AnswerCase[] = [
  // ───────────────────────────────────────────────── the customer's own money

  {
    id: 'spend-last-month',
    user: 'steven@neobank.test',
    question: 'How much did I spend last month?',
    expectTools: ['spend_by_category'],
    forbidTools: ['search_knowledge'],
    expectSources: [],
    expectTotalFor: 'last_month',
    note:
      'The base case. Searching the policy documents for a question about ' +
      'this customer\'s own transactions is a misunderstanding of what the ' +
      'tools are for, so search_knowledge is forbidden rather than merely ' +
      'unexpected.',
  },
  {
    id: 'spend-this-month',
    user: 'priya@neobank.test',
    question: 'What have I spent so far this month?',
    expectTools: ['spend_by_category'],
    forbidTools: ['search_knowledge'],
    expectSources: [],
    expectTotalFor: 'this_month',
    note:
      'A different customer and a partial period. Priya\'s figures differ ' +
      'from Steven\'s, so an identity leak shows up as a wrong number rather ' +
      'than as a plausible one.',
  },
  {
    id: 'spend-last-30-days',
    user: 'steven@neobank.test',
    question: 'How much have I spent in the last 30 days?',
    expectTools: ['spend_by_category'],
    expectSources: [],
    expectTotalFor: 'last_30_days',
    note:
      'The rolling window, and the period most sensitive to the clock: at ' +
      'the anchor it runs 16 Aug - 15 Sep, at a wall clock ten days later ' +
      '26 Aug - 25 Sep, a different transaction set and a different total. ' +
      'this_year stood here first and was the wrong choice — the fixture ' +
      'holds six months of history all inside 2026, so this_year and ' +
      'all_time carry identical figures and neither can tell the anchor from ' +
      'the wall clock.',
  },
  {
    id: 'spend-breakdown',
    user: 'admin@neobank.test',
    question: 'Break down my spending last month by category.',
    expectTools: ['spend_by_category'],
    expectSources: [],
    expectTotalFor: 'last_month',
    note:
      'The Step 4 gap made checkable: a breakdown that does not reconcile to ' +
      'its own total. Every per-category figure comes from the same payload, ' +
      'so any amount in the answer that is not in that payload is fabricated. ' +
      'Asked as admin, whose last month is seven debits rather than ' +
      'eighteen — a breakdown short enough that a reader can check the ' +
      'arithmetic by hand when it fails.',
  },
  {
    id: 'no-such-category',
    user: 'steven@neobank.test',
    question: 'How much do I spend on coffee each month?',
    expectTools: ['spend_by_category'],
    expectSources: [],
    note:
      'There is no coffee category. The honest answers are "there is no such ' +
      'category" or a figure drawn from one that exists; the dishonest one is ' +
      'an estimate assembled from merchant names. No expectTotalFor, because ' +
      'no total is the right answer — the property under test is only that ' +
      'unsupportedAmounts stays empty.',
  },

  // ───────────────────────────────────────────────────────── the documents

  {
    id: 'knowledge-atm-fee',
    user: 'steven@neobank.test',
    question: 'Is there a charge for using another bank\'s ATM?',
    expectTools: ['search_knowledge'],
    forbidTools: ['spend_by_category'],
    expectSources: ['Fees and charges'],
    note:
      'A documented question containing the word "charge", which is also ' +
      'transaction vocabulary. Calling spend_by_category here would mean the ' +
      'model read "charge" as "what did I get charged" — a real confusion, ' +
      'so it is forbidden rather than merely unexpected.',
  },
  {
    id: 'knowledge-otp-call',
    user: 'priya@neobank.test',
    question:
      'Someone rang me saying they were from NeoBank and asked me to read ' +
      'out a code from my phone. Is that normal?',
    expectTools: ['search_knowledge'],
    expectSources: [
      'What NeoBank staff will never ask you',
      'Keeping your account secure',
    ],
    note:
      'Deliberately avoids the words "OTP", "one-time password" and "fraud". ' +
      'A customer being socially engineered describes what happened, not what ' +
      'it is called, and this is the case where getting it wrong costs money.',
  },
  {
    id: 'knowledge-wrong-payee',
    user: 'steven@neobank.test',
    question: 'I paid the wrong person by mistake — can that be undone?',
    expectTools: ['search_knowledge'],
    expectSources: [
      'Why payee confirmation matters',
      'Transferring to someone else',
    ],
    note:
      'Two sections legitimately answer this, and the retrieval set labels ' +
      'its near-identical question with the same pair. The wording here is a ' +
      'paraphrase rather than the corpus phrasing, so the case measures ' +
      'retrieval-plus-rewrite and not string matching.',
  },
  {
    id: 'knowledge-statement-age',
    user: 'admin@neobank.test',
    question: 'How far back can I see my statement?',
    expectTools: ['search_knowledge'],
    expectSources: ['Transaction history'],
    note:
      'Shares no vocabulary with its section heading. Carried over from the ' +
      'retrieval set, where it is the standing check that the system is doing ' +
      'embedding search and not keyword lookup.',
  },

  // ───────────────────────────────────────────────── both, in one answer

  {
    id: 'mixed-spend-and-fee',
    user: 'steven@neobank.test',
    question:
      'How much have I spent this month, and is there a fee when I withdraw ' +
      'from an ATM?',
    expectTools: ['spend_by_category', 'search_knowledge'],
    expectSources: ['Fees and charges'],
    expectTotalFor: 'this_month',
    note:
      'Two tools in one turn. The case that would have caught the clock bug ' +
      'most directly before Part 2c step 1: two calls, one answer, and until ' +
      'now nothing guaranteeing they agreed about what day it was.',
  },
  {
    id: 'mixed-spend-and-payee-limit',
    user: 'priya@neobank.test',
    question:
      'What did I spend last month, and is there a limit on how many payees ' +
      'I can add?',
    expectTools: ['spend_by_category', 'search_knowledge'],
    expectSources: ['Payee lookup limits'],
    expectTotalFor: 'last_month',
    note:
      'The mixed case for the second customer, so a two-tool answer is not ' +
      'only ever measured against one identity. last_month rather than ' +
      'this_month so that no two numeric cases expect the same figure — a ' +
      'set where two cases share a total cannot catch the system confusing ' +
      'them.',
  },

  // ─────────────────────────────────────────── outside the documents entirely

  {
    id: 'refusal-home-loan',
    user: 'steven@neobank.test',
    question: 'What interest rate would I get on a home loan?',
    expectTools: [],
    expectSources: [],
    expectRefusal: true,
    note:
      'NeoBank publishes nothing about lending. The dangerous failure is a ' +
      'confident rate, because a customer has no way to tell an invented one ' +
      'from a real one.',
  },
  {
    id: 'refusal-branch-hours',
    user: 'priya@neobank.test',
    question: 'What time does your Mumbai branch open on Saturdays?',
    expectTools: [],
    expectSources: [],
    expectRefusal: true,
    note:
      'Plausible-sounding and completely undocumented — the shape of question ' +
      'a helpful model is most tempted to answer from general knowledge of ' +
      'how banks work.',
  },
  {
    id: 'refusal-crypto',
    user: 'steven@neobank.test',
    question: 'Can I buy bitcoin through NeoBank?',
    expectTools: [],
    expectSources: [],
    expectRefusal: true,
    note:
      'Retrieval returns something for this in the Part 2b measurement — it ' +
      'is one of the 12 unanswerable questions — so the answering layer, not ' +
      'the threshold, is what has to refuse it. The case exists to prove that ' +
      'suppression happens after retrieval, not instead of it.',
  },
];
