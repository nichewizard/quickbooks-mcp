/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/types/**/*.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    // The OAuth client spins up an interactive browser flow and a local HTTP
    // callback server, which can't be fully unit-covered. Jest subtracts
    // path-matched files from the global group, so the 100% gate above still
    // applies to everything else. Before quickbooks-client.auth.test.ts this
    // file had no tests at all (it was never imported, so istanbul never saw
    // it); these floors reflect what the new behavioral tests cover.
    './src/clients/quickbooks-client.ts': {
      branches: 45,
      functions: 70,
      lines: 70,
      statements: 70,
    },
    // update_account's normalizePatch carries a scalar field-type-map switch
    // whose `default` arm is unreachable (the map only ever maps to
    // string/boolean/number). The behavioral tests cover every reachable path;
    // this floor accounts for that one dead arm.
    './src/handlers/update-quickbooks-account.handler.ts': {
      branches: 89,
      functions: 100,
      lines: 97,
      statements: 95,
    },
    // create_account's normalizeAccountPayload carries a scalar field-type-map
    // switch whose boolean/number/default arms are not reachable from the
    // public surface (the fixed payload feeds only string fields; the ParentRef
    // object is attached separately). The behavioral tests cover the reachable
    // paths (top-level create, sub-account create via parent_id, errors); this
    // floor accounts for the dead arms.
    './src/handlers/create-quickbooks-account.handler.ts': {
      branches: 60,
      functions: 100,
      lines: 75,
      statements: 75,
    },
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts'],
  clearMocks: true,
  restoreMocks: true,
};
