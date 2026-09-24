/**
 * Runs the eval specs under src/app/ai/eval/ — the ones that need a real
 * provider, an API key and the network, and that cost money.
 *
 * Separate from the ground-truth config because the prerequisites differ.
 * Ground truth needs a seeded database and runs in CI on every pull request.
 * These need an API key, which CI does not have and should not have: a key in
 * CI is a spend surface reachable by anyone who can open a pull request.
 *
 * passWithNoTests stays unset. A pattern that stops matching must fail rather
 * than quietly skip the only measurement of retrieval quality.
 */
const base = require('./jest.config.cts');

module.exports = {
  ...base,
  displayName: 'api-eval',
  testMatch: ['<rootDir>/src/app/ai/eval/**/*.spec.ts'],
  // Replaces the unit config's list, which excludes exactly this directory.
  testPathIgnorePatterns: ['/node_modules/'],
  /**
   * One embedding call per question, over the network. Jest's 5s default is a
   * local-CPU budget. This machine has demonstrated multi-second TCP
   * retransmission stalls (Step 2: 15s, 28.9s, 42s on healthy requests), so a
   * tight ceiling would fail for the network rather than for retrieval — and
   * that failure would look like a quality regression. Bounded rather than
   * unlimited, and it costs nothing in practice: this target runs on demand.
   */
  testTimeout: 300_000,
};
