/**
 * The labelled question set for the retrieval eval.
 *
 * WHAT THIS REPLACES. `DEFAULT_MAX_DISTANCE = 0.62` was chosen in Step 3 from
 * eight questions — five the corpus answers, three it does not. Enough to prove
 * the first guess (0.55) was wrong in the dangerous direction; not enough to be
 * a measurement. Its own comment says so: "eight samples is a sample, not a
 * distribution". This set is large enough to compute recall and a
 * false-positive rate, and to sweep the threshold rather than pick it.
 *
 * HOW IT WAS WRITTEN, which matters more than its size. Every question was
 * written from the corpus text, BEFORE running any of them through retrieval. A
 * set written while watching results is fitted to the system's current
 * behaviour and then measures nothing — it would score whatever the system
 * already does as correct by construction. If a question turns out to retrieve
 * badly, that is a finding about retrieval, not a licence to reword the
 * question.
 *
 * WHAT THIS SET DOES NOT MEASURE. It scores retrieval for a given query. In the
 * answering loop there is a step before that: the model rewrites the customer's
 * question into the `q` argument it passes to search_knowledge. Measured once,
 * the rewrite scored WORSE than the literal question (0.4499 against 0.4325)
 * and pulled in a third passage the literal question did not. So distances from
 * these cases are NOT comparable to distances logged by /ai/ask, and tuning the
 * threshold from those logs would tune against a different distribution.
 * Whether the model's rewrite retrieves the right section is a Layer C
 * property, checkable against these same labels.
 *
 * `expect` IS A LIST, not a single heading. A corpus can legitimately answer one
 * question from more than one section — "can you reverse a transfer?" is
 * answered by both "Why payee confirmation matters" and "Transferring to
 * someone else" — and scoring those as misses would measure the labeller's
 * choices rather than the retrieval. An EMPTY list means the corpus does not
 * answer the question, and the correct behaviour is to return nothing.
 *
 * EVERY SECTION OF THE CORPUS IS NAMED BY AT LEAST ONE CASE. All 17 headings
 * appear across the 22 covered questions. That is deliberate: a section nobody
 * asks about is a section that can quietly become unretrievable. The eval
 * asserts this both ways — no label naming a heading that does not exist, and
 * no heading without a question.
 *
 * The questions deliberately avoid echoing their section's heading words where
 * a customer plausibly would not use them. "How far back does my statement go?"
 * shares no vocabulary with "Transaction history" — the case embeddings are
 * supposed to handle and keyword search is not.
 *
 * TREAT EDITS LIKE TEST EDITS. This file is the specification of what retrieval
 * should do. Loosening a label to make a number go up is the same mistake as
 * loosening an assertion to make a test pass.
 */

export type RetrievalCase = {
  /** Phrased as a customer would ask it, not as the corpus states it. */
  q: string;
  /** Headings that legitimately answer it. Empty = the corpus does not. */
  expect: string[];
};

/** Questions the FAQ answers. */
const COVERED: RetrievalCase[] = [
  // The three carried over from Step 3's calibration, so the old measurement
  // and the new one have common ground. "Is there a charge for using the app?"
  // is the one that scored 0.574 and would have been silently dropped at 0.55.
  { q: 'what happens if I do not have enough money in my account?', expect: ['Insufficient funds'] },
  { q: 'is there a charge for using the app?', expect: ['Fees and charges'] },
  { q: 'how many times can I check a payee name in an hour?', expect: ['Payee lookup limits'] },

  { q: 'can I have more than one account?', expect: ['Account types', 'Opening an account'] },
  { q: 'what is the difference between the two kinds of account you offer?', expect: ['Account types'] },
  { q: 'how long does it take to open another account?', expect: ['Opening an account'] },
  { q: 'what is your IFSC code?', expect: ['Account numbers and IFSC'] },
  {
    q: 'what details do I need from someone before I can send them money?',
    expect: ['Adding a payee', 'Account numbers and IFSC'],
  },
  { q: 'why do you show me the recipient name before saving them?', expect: ['Why payee confirmation matters'] },
  {
    q: 'I sent money to the wrong person, can you reverse it?',
    expect: ['Why payee confirmation matters', 'Transferring to someone else'],
  },
  {
    q: 'can I move money between my savings and current account instantly?',
    expect: ['Transferring between your own accounts'],
  },
  { q: 'why does my statement show wording I did not write?', expect: ['Transferring to someone else'] },
  { q: 'will a transfer go through partially if I am short?', expect: ['Insufficient funds'] },
  { q: 'how do I put money in?', expect: ['Deposits'] },
  { q: 'can I pay in a cheque?', expect: ['Deposits'] },
  { q: 'how far back does my statement go?', expect: ['Transaction history'] },
  { q: 'do you support dollars or euros?', expect: ['Currency'] },
  { q: 'how long does my login last before it expires?', expect: ['Keeping your account secure'] },
  {
    q: 'someone called claiming to be from your bank and asked for my password',
    expect: ['What NeoBank staff will never ask you'],
  },
  { q: 'can an administrator take money out of my account?', expect: ['Roles and administrator access'] },
  { q: 'can another customer see my transactions?', expect: ['Roles and administrator access'] },
  { q: 'how do I delete my account?', expect: ['Closing an account'] },
];

/**
 * Questions the FAQ does NOT answer. Deliberately hard: each is an ordinary
 * thing to ask a bank, and several sit lexically close to a real section —
 * "joint account" beside Account types, "dispute a transaction" beside
 * Transaction history, "customer care number" beside the staff-contact section.
 * Easy negatives ("what is the capital of France?") would make the
 * false-positive rate look good and measure nothing.
 */
const NOT_COVERED: RetrievalCase[] = [
  { q: 'how do I apply for a home loan?', expect: [] },
  { q: 'what are your branch opening hours?', expect: [] },
  { q: 'what interest rate do you pay on savings?', expect: [] },
  { q: 'can I get a credit card?', expect: [] },
  { q: 'how do I order a chequebook?', expect: [] },
  { q: 'what is the daily ATM withdrawal limit?', expect: [] },
  { q: 'do you offer fixed deposits?', expect: [] },
  { q: 'how do I update my registered mobile number?', expect: [] },
  { q: 'can I open a joint account with my spouse?', expect: [] },
  { q: 'how do I dispute a transaction I did not make?', expect: [] },
  { q: 'what is your customer care number?', expect: [] },
  { q: 'do you have a mobile app for Android?', expect: [] },
];

export const RETRIEVAL_CASES: RetrievalCase[] = [...COVERED, ...NOT_COVERED];
