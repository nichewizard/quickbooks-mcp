# Testing Documentation

This document explains the testing strategy, patterns, and practices used in the QuickBooks Online MCP Server.

## Table of Contents

- [Overview](#overview)
- [Test Configuration](#test-configuration)
- [ESM Testing Pattern](#esm-testing-pattern)
- [Mock System](#mock-system)
- [Test Structure](#test-structure)
- [Coverage Strategy](#coverage-strategy)
- [Running Tests](#running-tests)
- [Writing New Tests](#writing-new-tests)
- [Troubleshooting](#troubleshooting)

---

## Overview

### Test Statistics

| Metric | Value |
|--------|-------|
| Test Suites | 12 |
| Total Tests | 335 |
| Statement Coverage | 100% |
| Branch Coverage | 100% |
| Function Coverage | 100% |
| Line Coverage | 100% |

### Test Framework Stack

- **Jest** - Test runner and assertion library
- **ts-jest** - TypeScript compilation for Jest
- **ESM Preset** - Native ECMAScript module support

---

## Test Configuration

### jest.config.js

```javascript
/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  // Use ESM preset for native module support
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',

  // Test file discovery
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],

  // Coverage configuration
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/types/**/*.ts',  // Exclude type definitions
  ],

  // Enforce 100% coverage
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },

  // ESM support configuration
  moduleNameMapper: {
    // Handle .js extensions in imports
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

  // Mock cleanup
  clearMocks: true,
  restoreMocks: true,
};
```

### tsconfig.test.json

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true
  }
}
```

### package.json Test Script

```json
{
  "scripts": {
    "test": "NODE_OPTIONS='--experimental-vm-modules' jest"
  }
}
```

The `--experimental-vm-modules` flag enables Jest's ESM support.

---

## ESM Testing Pattern

### The Challenge

Jest's traditional mocking (`jest.mock()`) doesn't work with native ESM modules because:
1. ESM imports are hoisted and resolved before test code runs
2. ESM bindings are immutable

### The Solution

Use `jest.unstable_mockModule()` with dynamic imports:

```typescript
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// STEP 1: Define mock BEFORE any imports that use the mocked module
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
}));

// STEP 2: Dynamic import AFTER mock is defined
const { createQuickbooksPayment } = await import('../../../src/handlers/create-quickbooks-payment.handler');

// STEP 3: Tests can now use the mocked module
describe('Payment Handlers', () => {
  beforeEach(() => {
    resetAllMocks();  // Reset mock state between tests
  });

  it('should create payment', async () => {
    mockQuickBooksInstance.createPayment.mockImplementation((payload, cb) =>
      cb(null, { Id: '123' })
    );

    const result = await createQuickbooksPayment({ customer_ref: '1', total_amt: 100 });

    expect(result.isError).toBe(false);
  });
});
```

### Why This Order Matters

```
1. jest.unstable_mockModule() ─────────────────────────────────┐
   • Registers mock factory                                     │
   • Must happen BEFORE dynamic import                          │
                                                                │
2. await import() ──────────────────────────────────────────────┤
   • Triggers module resolution                                 │
   • Jest intercepts and provides mock                          │
   • Handler gets mocked client                                 │
                                                                │
3. Tests run with mocked dependencies ─────────────────────────┘
```

---

## Mock System

### Mock File: tests/mocks/quickbooks.mock.ts

```typescript
import { jest } from '@jest/globals';

// Mock QuickBooks instance with all API methods
export const mockQuickBooksInstance = {
  // Entity CRUD operations
  createPayment: jest.fn(),
  getPayment: jest.fn(),
  updatePayment: jest.fn(),
  deletePayment: jest.fn(),
  findPayments: jest.fn(),

  createCustomer: jest.fn(),
  getCustomer: jest.fn(),
  // ... all other entity methods

  // Report methods
  reportBalanceSheet: jest.fn(),
  reportProfitAndLoss: jest.fn(),
  // ... all other report methods

  // Company info
  getCompanyInfo: jest.fn(),
  updateCompanyInfo: jest.fn(),

  // Realm ID for company info
  realmId: '123456789',
};

// Mock client that returns the mock instance
export const mockQuickbooksClient = {
  authenticate: jest.fn().mockResolvedValue(undefined),
  getQuickbooks: jest.fn().mockReturnValue(mockQuickBooksInstance),
};

// Reset all mocks between tests
export function resetAllMocks() {
  jest.clearAllMocks();
  mockQuickbooksClient.authenticate.mockResolvedValue(undefined);
  mockQuickbooksClient.getQuickbooks.mockReturnValue(mockQuickBooksInstance);
}
```

### Mock Usage Patterns

**Successful API Call:**
```typescript
mockQuickBooksInstance.createPayment.mockImplementation((payload, cb) => {
  cb(null, { Id: '123', TotalAmt: 100 });
});
```

**API Error:**
```typescript
mockQuickBooksInstance.createPayment.mockImplementation((payload, cb) => {
  cb(new Error('Validation failed'), null);
});
```

**Authentication Error:**
```typescript
(mockQuickbooksClient.authenticate as any).mockRejectedValue(
  new Error('Token expired')
);
```

**Empty Search Results:**
```typescript
mockQuickBooksInstance.findPayments.mockImplementation((criteria, cb) => {
  cb(null, { QueryResponse: {} });  // No Payment array
});
```

---

## Test Structure

### File Organization

```
tests/
├── mocks/
│   └── quickbooks.mock.ts          # Shared mock definitions
│
└── unit/
    ├── handlers/
    │   ├── class.handlers.test.ts
    │   ├── company-attachable.handlers.test.ts
    │   ├── credit-memo.handlers.test.ts
    │   ├── department-term-paymentmethod.handlers.test.ts
    │   ├── deposit-transfer.handlers.test.ts
    │   ├── payment.handlers.test.ts
    │   ├── refund-purchase-order-vendor-credit.handlers.test.ts
    │   ├── reports.handlers.test.ts
    │   ├── sales-receipt.handlers.test.ts
    │   ├── tax-entities.handlers.test.ts
    │   └── time-activity.handlers.test.ts
    │
    └── helpers/
        └── format-error.test.ts
```

### Test File Template

```typescript
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// Mock setup BEFORE imports
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
}));

// Dynamic imports AFTER mock setup
const { createQuickbooksEntity } = await import('../../../src/handlers/create-quickbooks-entity.handler');
const { getQuickbooksEntity } = await import('../../../src/handlers/get-quickbooks-entity.handler');
const { updateQuickbooksEntity } = await import('../../../src/handlers/update-quickbooks-entity.handler');
const { deleteQuickbooksEntity } = await import('../../../src/handlers/delete-quickbooks-entity.handler');
const { searchQuickbooksEntities } = await import('../../../src/handlers/search-quickbooks-entities.handler');

describe('Entity Handlers', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  describe('createQuickbooksEntity', () => {
    it('should create entity successfully', async () => { /* ... */ });
    it('should create with all optional fields', async () => { /* ... */ });
    it('should handle API errors', async () => { /* ... */ });
    it('should handle authentication errors', async () => { /* ... */ });
  });

  describe('getQuickbooksEntity', () => {
    it('should get entity by ID', async () => { /* ... */ });
    it('should handle not found errors', async () => { /* ... */ });
    it('should handle authentication errors', async () => { /* ... */ });
  });

  describe('updateQuickbooksEntity', () => {
    it('should update entity', async () => { /* ... */ });
    it('should update with optional fields', async () => { /* ... */ });
    it('should handle API errors', async () => { /* ... */ });
    it('should handle authentication errors', async () => { /* ... */ });
  });

  describe('deleteQuickbooksEntity', () => {
    it('should delete entity', async () => { /* ... */ });
    it('should handle API errors', async () => { /* ... */ });
    it('should handle authentication errors', async () => { /* ... */ });
  });

  describe('searchQuickbooksEntities', () => {
    it('should search entities', async () => { /* ... */ });
    it('should search with filters', async () => { /* ... */ });
    it('should handle empty QueryResponse', async () => { /* ... */ });
    it('should handle API errors', async () => { /* ... */ });
    it('should handle authentication errors', async () => { /* ... */ });
  });
});
```

---

## Coverage Strategy

### What 100% Coverage Means

- **Statement Coverage**: Every line of code executed
- **Branch Coverage**: Every `if`/`else` path taken
- **Function Coverage**: Every function called
- **Line Coverage**: Every line executed

### Achieving 100% Branch Coverage

Each conditional requires tests for BOTH branches:

```typescript
// Handler code
if (data.optional_field) {
  payload.OptionalField = data.optional_field;
}

// Tests needed:
// 1. With optional_field (true branch)
it('should create with optional field', async () => {
  const result = await createEntity({ required: 'x', optional_field: 'y' });
  expect(result.isError).toBe(false);
});

// 2. Without optional_field (false branch)
it('should create without optional field', async () => {
  const result = await createEntity({ required: 'x' });
  expect(result.isError).toBe(false);
});
```

### Common Branch Coverage Patterns

**1. Ternary Operators**
```typescript
// Code
const value = data.field ? data.field : undefined;

// Tests
it('with field', () => { /* provide field */ });
it('without field', () => { /* omit field */ });
```

**2. Null Coalescing in Search**
```typescript
// Code
result?.QueryResponse?.Entity || []

// Test for empty response
it('should handle empty QueryResponse', async () => {
  mockQuickBooksInstance.findEntities.mockImplementation((criteria, cb) =>
    cb(null, { QueryResponse: {} })  // No Entity array
  );

  const result = await searchEntities({});

  expect(result.result).toEqual([]);
});
```

**3. Nested Optional Objects**
```typescript
// Code
if (data.address) {
  payload.Address = {};
  if (data.address.line1) payload.Address.Line1 = data.address.line1;
  if (data.address.city) payload.Address.City = data.address.city;
}

// Tests
it('with address.line1 only', async () => {
  await update({ ..., address: { line1: '123 Main' } });
});

it('with address.city only', async () => {
  await update({ ..., address: { city: 'Boston' } });
});
```

**4. Error Handling Branches**
```typescript
// Tests for error paths
it('should handle API errors', async () => {
  mockQuickBooksInstance.createEntity.mockImplementation((p, cb) =>
    cb(new Error('API error'), null)
  );
  const result = await createEntity({ ... });
  expect(result.isError).toBe(true);
});

it('should handle auth errors', async () => {
  (mockQuickbooksClient.authenticate as any).mockRejectedValue(
    new Error('Auth failed')
  );
  const result = await createEntity({ ... });
  expect(result.isError).toBe(true);
});
```

---

## Running Tests

### Run All Tests
```bash
npm test
```

### Run with Coverage Report
```bash
npm test -- --coverage
```

### Run Specific Test File
```bash
npm test -- tests/unit/handlers/payment.handlers.test.ts
```

### Run Tests Matching Pattern
```bash
npm test -- --testNamePattern="should create"
```

### Watch Mode (for development)
```bash
npm test -- --watch
```

### View HTML Coverage Report
```bash
npm test
open coverage/lcov-report/index.html
```

---

## Writing New Tests

### Checklist for New Handler Tests

1. **Import mock utilities**
   ```typescript
   import { mockQuickbooksClient, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';
   ```

2. **Add mock method to quickbooks.mock.ts if needed**
   ```typescript
   export const mockQuickBooksInstance = {
     // ... existing mocks
     newMethod: jest.fn(),
   };
   ```

3. **Set up mock BEFORE dynamic imports**

4. **Test all code paths:**
   - Success case
   - All optional field combinations
   - API error case
   - Authentication error case
   - Empty response case (for search)

5. **Verify coverage passes**
   ```bash
   npm test
   ```

### Test Case Template

```typescript
describe('handlerFunction', () => {
  it('should succeed with required fields only', async () => {
    mockQuickBooksInstance.method.mockImplementation((p, cb) =>
      cb(null, { Id: '1' })
    );

    const result = await handlerFunction({ required: 'value' });

    expect(result.isError).toBe(false);
    expect(result.result).toEqual({ Id: '1' });
  });

  it('should succeed with all optional fields', async () => {
    mockQuickBooksInstance.method.mockImplementation((p, cb) =>
      cb(null, { Id: '1' })
    );

    const result = await handlerFunction({
      required: 'value',
      optional1: 'a',
      optional2: 'b',
    });

    expect(result.isError).toBe(false);
  });

  it('should handle API errors', async () => {
    mockQuickBooksInstance.method.mockImplementation((p, cb) =>
      cb(new Error('Failed'), null)
    );

    const result = await handlerFunction({ required: 'value' });

    expect(result.isError).toBe(true);
    expect(result.error).toBeDefined();
  });

  it('should handle authentication errors', async () => {
    (mockQuickbooksClient.authenticate as any).mockRejectedValue(
      new Error('Auth failed')
    );

    const result = await handlerFunction({ required: 'value' });

    expect(result.isError).toBe(true);
    expect(result.error).toContain('Auth failed');
  });
});
```

---

## Troubleshooting

### Common Issues

**1. "Cannot use import statement outside a module"**

Ensure `NODE_OPTIONS='--experimental-vm-modules'` is set in the test script.

**2. Mock not being applied**

Check that `jest.unstable_mockModule()` is called BEFORE `await import()`.

**3. "jest is not defined"**

Import jest explicitly:
```typescript
import { jest } from '@jest/globals';
```

**4. Coverage below 100%**

Run with `--coverage` and check the HTML report:
```bash
npm test
open coverage/lcov-report/index.html
```

Look for red/yellow highlighted lines indicating uncovered code.

**5. Tests affecting each other**

Ensure `resetAllMocks()` is called in `beforeEach()`:
```typescript
beforeEach(() => {
  resetAllMocks();
});
```

### Debug Mode

```bash
npm test -- --detectOpenHandles --forceExit
```

### Verbose Output

```bash
npm test -- --verbose
```
