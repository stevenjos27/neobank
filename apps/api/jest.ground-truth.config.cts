/**
 * Runs ONLY the *.ground-truth.spec.ts files — the specs that need a
 * database seeded to match prisma/.seed-facts.json.
 *
 * Built on the unit config rather than copied from it, so the transform and
 * preset cannot drift apart: a spec that compiles under one runner and not
 * the other would be a failure unrelated to what either suite tests. Only
 * the file selection differs.
 *
 * passWithNoTests is deliberately NOT set. The unit target sets it; here it
 * would be dangerous. If this pattern ever stops matching — a rename, a
 * moved file — "no tests found" must fail the run, not quietly skip the
 * only layer that checks the tools against ground truth.
 */
const base = require('./jest.config.cts');

module.exports = {
  ...base,
  displayName: 'api-ground-truth',
  testMatch: ['<rootDir>/src/**/*.ground-truth.spec.ts'],
  // Replaces the unit config's list, which excludes exactly these files.
  testPathIgnorePatterns: ['/node_modules/'],
};
