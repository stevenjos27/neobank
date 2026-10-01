/**
 * Mobile's tests run under jest-expo, with mobile's OWN Jest (29.7, which
 * jest-expo 57 is built for). The root's Jest 30 never sees this file:
 * nx.json excludes apps/mobile from the Jest plugin's inference.
 *
 * Jest does not read tsconfig `paths`, so the @neobank/utils alias is
 * mapped here as well, to the same source file tsconfig.json points at.
 * Two declarations of one alias is a drift risk; the test below fails if
 * they ever disagree in a way that matters, because it renders App, which
 * imports the alias.
 */
module.exports = {
  preset: 'jest-expo',
  moduleNameMapper: {
    '^@neobank/utils$': '<rootDir>/../../libs/utils/src/index.ts',
  },
};
