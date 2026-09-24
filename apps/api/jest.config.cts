module.exports = {
  displayName: 'api',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/api',
  // Specs that need a seeded database, a network call or an API key live
  // under src/app/ai/eval/ and run under their own targets. The unit suite
  // must pass with nothing set up — no database, no key, no network.
  //
  // A directory rule rather than another filename pattern: the next eval spec
  // should not require a fourth edit here to stay out of the unit suite.
  testPathIgnorePatterns: ['/node_modules/', '\\.ground-truth\\.spec\\.ts$', '/app/ai/eval/'],
};
