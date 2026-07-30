# Architecture Documentation

This document explains the architecture, design decisions, and code patterns used in the QuickBooks Online MCP Server.

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Directory Structure](#directory-structure)
- [Core Components](#core-components)
- [Handler Pattern](#handler-pattern)
- [Tool Registration](#tool-registration)
- [Error Handling](#error-handling)
- [Type System](#type-system)
- [Design Decisions](#design-decisions)

---

## Overview

The QuickBooks Online MCP Server is a Model Context Protocol (MCP) server that exposes QuickBooks Online API functionality as tools that can be invoked by Claude Code and other MCP-compatible clients.

### Key Metrics

| Metric | Value |
|--------|-------|
| Total Tools | 143 |
| Entity Types | 29 |
| Financial Reports | 11 |
| Handler Files | 87 |
| Test Coverage | 100% |

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         MCP Client                               │
│                    (Claude Code / IDE)                           │
└─────────────────────────────────────────────────────────────────┘
                                │
                                │ MCP Protocol (stdio)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         MCP Server                               │
│                        (src/index.ts)                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Tool Registry                         │    │
│  │              (src/tools/*.tool.ts)                       │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                │                                 │
│                                │ Tool Invocation                 │
│                                ▼                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                      Handlers                            │    │
│  │            (src/handlers/*.handler.ts)                   │    │
│  │                                                          │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │    │
│  │  │    Create    │  │     Get      │  │    Update    │   │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘   │    │
│  │  ┌──────────────┐  ┌──────────────┐                     │    │
│  │  │    Delete    │  │    Search    │                     │    │
│  │  └──────────────┘  └──────────────┘                     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                │                                 │
│                                │ API Calls                       │
│                                ▼                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │               QuickBooks Client                          │    │
│  │           (src/clients/quickbooks-client.ts)             │    │
│  │                                                          │    │
│  │  • OAuth 2.0 Token Management                           │    │
│  │  • Token Refresh                                         │    │
│  │  • Environment Configuration                             │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                                │
                                │ HTTPS
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                   QuickBooks Online API                          │
│               (sandbox.api.intuit.com / api.intuit.com)          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Directory Structure

```
src/
├── index.ts                    # MCP server entry point
│                               # - Registers all tools
│                               # - Handles MCP protocol communication
│
├── clients/
│   └── quickbooks-client.ts    # QuickBooks API client wrapper
│                               # - OAuth token management
│                               # - Authentication flow
│                               # - Environment switching (sandbox/production)
│
├── handlers/                   # Business logic layer (87 files)
│   ├── create-quickbooks-*.ts  # Create operations (14 files)
│   ├── get-quickbooks-*.ts     # Get/Read operations (25 files)
│   ├── update-quickbooks-*.ts  # Update operations (14 files)
│   ├── delete-quickbooks-*.ts  # Delete operations (14 files)
│   └── search-quickbooks-*.ts  # Search operations (20 files)
│
├── tools/                      # MCP tool definitions
│   └── *.tool.ts               # Zod schemas + tool metadata
│
├── helpers/
│   └── format-error.ts         # Standardized error formatting
│
├── types/
│   └── tool-response.ts        # Response type definitions
│
└── server/
    └── *.ts                    # Server utilities
```

---

## Core Components

### 1. MCP Server Entry Point (`src/index.ts`)

The main server file:
- Initializes the MCP server
- Registers all 143 tools with their schemas
- Routes tool invocations to appropriate handlers
- Manages the MCP stdio transport

```typescript
// Simplified structure
const server = new McpServer({ name: 'quickbooks-online', version: '0.0.1' });

// Tool registration pattern
server.tool(
  'create_payment',
  'Create a new payment',
  createPaymentSchema,
  async (args) => createQuickbooksPayment(args)
);

// Start server
await server.start();
```

### 2. QuickBooks Client (`src/clients/quickbooks-client.ts`)

Wraps the `node-quickbooks` library:

```typescript
class QuickBooksClient {
  private quickbooks: QuickBooks | null = null;

  async authenticate(): Promise<void> {
    // 1. Check if already authenticated
    // 2. Initialize QuickBooks instance with OAuth tokens
    // 3. Handle token refresh if needed
  }

  getQuickbooks(): QuickBooks {
    if (!this.quickbooks) throw new Error('Not authenticated');
    return this.quickbooks;
  }
}

export const quickbooksClient = new QuickBooksClient();
```

### 3. Handlers (`src/handlers/*.handler.ts`)

Each handler:
- Defines a typed input interface
- Authenticates with QuickBooks
- Maps input to QuickBooks API format
- Executes the API call
- Returns standardized response

### 4. Tools (`src/tools/*.tool.ts`)

Define the MCP tool interface:
- Tool name and description
- Zod schema for input validation
- Links to handler function

### 5. Helpers (`src/helpers/format-error.ts`)

Standardizes error messages:

```typescript
export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}
```

---

## Handler Pattern

All handlers follow a consistent pattern for maintainability:

### Standard Handler Structure

```typescript
// 1. Imports
import { quickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

// 2. Input Interface (typed, documented)
export interface CreatePaymentInput {
  customer_ref: string;              // Required: Customer ID
  total_amt: number;                 // Required: Payment amount
  payment_method_ref?: string;       // Optional: Payment method
  txn_date?: string;                 // Optional: Transaction date (YYYY-MM-DD)
  private_note?: string;             // Optional: Internal note
}

// 3. Handler Function
export async function createQuickbooksPayment(
  data: CreatePaymentInput
): Promise<ToolResponse<any>> {
  try {
    // 3a. Authenticate
    await quickbooksClient.authenticate();
    const quickbooks = quickbooksClient.getQuickbooks();

    // 3b. Build API payload with field mapping
    const payload: any = {
      CustomerRef: { value: data.customer_ref },
      TotalAmt: data.total_amt,
    };

    // 3c. Add optional fields conditionally
    if (data.payment_method_ref) {
      payload.PaymentMethodRef = { value: data.payment_method_ref };
    }
    if (data.txn_date) payload.TxnDate = data.txn_date;
    if (data.private_note) payload.PrivateNote = data.private_note;

    // 3d. Execute API call with Promise wrapper
    return new Promise((resolve) => {
      (quickbooks as any).createPayment(payload, (err: any, result: any) => {
        if (err) {
          resolve({ result: null, isError: true, error: formatError(err) });
        } else {
          resolve({ result, isError: false, error: null });
        }
      });
    });
  } catch (error) {
    // 3e. Handle authentication/setup errors
    return { result: null, isError: true, error: formatError(error) };
  }
}
```

### Why This Pattern?

1. **Type Safety**: TypeScript interfaces ensure compile-time validation
2. **Consistency**: Same structure across 87 handlers makes codebase predictable
3. **Error Handling**: Three-level error handling (auth, API, general)
4. **Field Mapping**: Clean separation between snake_case inputs and PascalCase API

---

## Tool Registration

Tools are registered in `src/index.ts`:

```typescript
// Tool registration connects:
// 1. Tool name (MCP protocol identifier)
// 2. Description (shown to users)
// 3. Schema (Zod validation)
// 4. Handler (business logic)

server.tool(
  'create_payment',
  'Create a new customer payment in QuickBooks',
  z.object({
    customer_ref: z.string().describe('Customer ID'),
    total_amt: z.number().describe('Payment amount'),
    payment_method_ref: z.string().optional(),
    txn_date: z.string().optional(),
    private_note: z.string().optional(),
  }),
  async (args) => {
    const result = await createQuickbooksPayment(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);
```

---

## Error Handling

### Three Layers of Error Handling

```
┌─────────────────────────────────────────────────┐
│  Layer 1: Authentication Errors                  │
│  • OAuth token expired                          │
│  • Invalid credentials                          │
│  • Network issues during auth                   │
│  Handled by: try/catch in handler               │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│  Layer 2: QuickBooks API Errors                  │
│  • Validation errors (invalid data)             │
│  • Not found errors                             │
│  • Permission errors                            │
│  Handled by: Callback err parameter             │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│  Layer 3: General Errors                         │
│  • Unexpected exceptions                        │
│  • Serialization errors                         │
│  Handled by: outer try/catch                    │
└─────────────────────────────────────────────────┘
```

### Response Format

All handlers return a consistent `ToolResponse<T>`:

```typescript
interface ToolResponse<T> {
  result: T | null;      // Data on success, null on error
  isError: boolean;      // Quick error check
  error: string | null;  // Error message, null on success
}

// Success response
{ result: { Id: '123', ... }, isError: false, error: null }

// Error response
{ result: null, isError: true, error: 'Customer not found' }
```

---

## Type System

### Input Types

Each handler defines its input interface:

```typescript
// Required fields have no optional modifier
// Optional fields use TypeScript's optional property syntax

export interface UpdateCompanyInfoInput {
  id: string;                          // Required
  sync_token: string;                  // Required
  company_name?: string;               // Optional
  company_addr?: {                     // Optional nested object
    line1?: string;
    city?: string;
    country_sub_division_code?: string;
    postal_code?: string;
    country?: string;
  };
}
```

### Field Naming Conventions

| Context | Convention | Example |
|---------|------------|---------|
| Handler inputs | snake_case | `customer_ref` |
| QuickBooks API | PascalCase | `CustomerRef` |
| Reference fields | Wrapped object | `{ value: 'id' }` |

---

## Design Decisions

### Why Separate Handlers and Tools?

**Handlers** contain business logic:
- Authentication
- Data transformation
- API interaction
- Error handling

**Tools** contain interface definition:
- Schema validation
- Description for users
- Response formatting

This separation allows:
- Testing handlers in isolation
- Reusing handlers across different tool registrations
- Cleaner code organization

### Why Callback-to-Promise Wrapping?

The `node-quickbooks` library uses callback patterns:

```typescript
quickbooks.createPayment(payload, (err, result) => { ... });
```

We wrap these in Promises for:
- Consistent async/await usage
- Better error handling flow
- Cleaner code structure

### Why 100% Test Coverage?

1. **Reliability**: Every code path is verified
2. **Regression Prevention**: Changes must pass all tests
3. **Documentation**: Tests show how handlers should behave
4. **Confidence**: Refactoring is safe

### Why ESM (ECMAScript Modules)?

1. **Modern Standard**: ESM is the JavaScript module standard
2. **Better Tree-Shaking**: Unused code can be eliminated
3. **Top-Level Await**: Cleaner async initialization
4. **Future-Proof**: Node.js is moving toward ESM

---

## Data Flow Example

**Creating a Payment:**

```
User Request
    │
    ▼
┌─────────────────────────────────────────────────┐
│ MCP Client sends tool invocation                │
│ { tool: 'create_payment', args: {...} }         │
└─────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────┐
│ MCP Server receives request                      │
│ - Validates args against Zod schema             │
│ - Routes to createQuickbooksPayment handler     │
└─────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────┐
│ Handler executes                                 │
│ 1. quickbooksClient.authenticate()              │
│ 2. Build payload (snake_case → PascalCase)      │
│ 3. quickbooks.createPayment(payload, callback)  │
└─────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────┐
│ QuickBooks API                                   │
│ - Validates request                             │
│ - Creates payment record                        │
│ - Returns created entity                        │
└─────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────┐
│ Handler processes response                       │
│ - Wraps in ToolResponse                         │
│ - Returns { result, isError, error }            │
└─────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────┐
│ MCP Server sends response                        │
│ - Formats as MCP content                        │
│ - Returns to client                             │
└─────────────────────────────────────────────────┘
    │
    ▼
User sees result
```

---

## Performance Considerations

1. **Connection Reuse**: `quickbooksClient` maintains a singleton connection
2. **Token Caching**: OAuth tokens are cached until expiry
3. **Minimal Payloads**: Only requested fields are sent to API
4. **No Polling**: Direct request/response pattern

---

## Security

1. **No Hardcoded Credentials**: All secrets via environment variables
2. **OAuth 2.0**: Industry-standard authentication
3. **Token Refresh**: Automatic token refresh on expiry
4. **Sandbox Support**: Testing without production data
5. **Input Validation**: Zod schemas validate all inputs

---

## Extending the Server

### Adding a New Entity Handler

1. Create handler file: `src/handlers/create-quickbooks-newentity.handler.ts`
2. Define input interface
3. Implement handler function
4. Add to mock in `tests/mocks/quickbooks.mock.ts`
5. Register tool in `src/index.ts`
6. Write tests with 100% coverage

### Adding a New Report

1. Create handler: `src/handlers/get-quickbooks-newreport.handler.ts`
2. Check QuickBooks API for report parameters
3. Implement with date range and filter support
4. Register tool and write tests
