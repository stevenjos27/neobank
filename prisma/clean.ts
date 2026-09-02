/**
 * CLI entry point for the e2e cleanup — `pnpm db:clean`.
 *
 * Deliberately separate from clean-test-data.ts: that module must stay
 * side-effect-free so Playwright can import it as globalTeardown without
 * the act of importing deleting rows. Executable scripts and importable
 * modules are different things; conflating them is what made the old
 * `require.main === module` guard necessary — and unreliable under tsx,
 * where CJS-vs-ESM decides whether `require.main` exists at all.
 */

import runCleanup from './clean-test-data';

runCleanup().catch((e) => {
  console.error(e);
  process.exit(1);
});
