module.exports = {
  displayName: 'api',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/api',
  // Ground-truth specs need a seeded Postgres and run under their own target.
  // The unit suite must pass with no database at all: it is what runs on
  // every machine, in every state, before anything else is set up.
  testPathIgnorePatterns: ['/node_modules/', '\\.ground-truth\\.spec\\.ts$'],
};
