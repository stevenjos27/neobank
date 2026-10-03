/**
 * Mobile's tests run under jest-expo, with mobile's OWN Jest (29.7, which
 * jest-expo 57 is built for). The root's Jest 30 never sees this file:
 * nx.json excludes apps/mobile from the Jest plugin's inference.
 *
 * Jest does not read tsconfig `paths`, so every workspace alias mobile uses is
 * mapped here as well, to the same source file tsconfig.json points at. Two
 * declarations of one alias is a drift risk; the App test renders screens
 * that import both aliases, so a mapping that disagrees with tsconfig fails
 * there rather than silently.
 *
 * jest-expo installs Expo's runtime globals (its setup requires
 * expo/src/winter), so tests here use Expo's TextDecoder polyfill — the same
 * one Hermes uses on the phone — not Node's.
 */
module.exports = {
  preset: 'jest-expo',
  moduleNameMapper: {
    '^@neobank/utils$': '<rootDir>/../../libs/utils/src/index.ts',
    '^@neobank/contracts$': '<rootDir>/../../libs/contracts/src/index.ts',
  },
};
