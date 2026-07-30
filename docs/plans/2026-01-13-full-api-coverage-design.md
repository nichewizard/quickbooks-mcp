# QuickBooks Online MCP Server - Full API Coverage Design

## Overview

Extend the existing Intuit QuickBooks Online MCP server to provide complete API coverage with 100% unit test coverage, suitable for contribution back to the upstream repository.

## Goals

1. **Complete Entity Coverage** - All 40+ QuickBooks Online entities
2. **Financial Reports** - 15+ read-only report tools
3. **100% Test Coverage** - Jest with mocks for all tools, handlers, and utilities
4. **Production Quality** - Ready for open-source contribution

## Architecture

### Existing Structure (Preserved)

```
src/
├── clients/quickbooks-client.ts   # OAuth + API client
├── server/qbo-mcp-server.ts       # MCP server setup
├── tools/*.tool.ts                # MCP tool definitions (Zod schemas)
├── handlers/*.handler.ts          # Business logic
├── helpers/                       # Utilities
└── types/                         # TypeScript definitions
```

### New Additions

```
src/
├── tools/reports/                 # Report tools (new directory)
└── ...existing...

tests/
├── unit/
│   ├── tools/                     # Tool unit tests
│   ├── handlers/                  # Handler unit tests
│   ├── helpers/                   # Helper unit tests
│   └── client/                    # Client unit tests
├── mocks/
│   ├── quickbooks.mock.ts         # QBO client mock
│   └── responses/                 # API response fixtures
└── integration/
    └── mcp-server.test.ts         # MCP protocol tests
```

## Entity Coverage

### Currently Implemented (11 entities)

| Entity | Create | Get | Update | Delete | Search |
|--------|--------|-----|--------|--------|--------|
| Account | ✅ | ❌ | ✅ | ❌ | ✅ |
| Bill | ✅ | ✅ | ✅ | ✅ | ✅ |
| BillPayment | ✅ | ✅ | ✅ | ✅ | ✅ |
| Customer | ✅ | ✅ | ✅ | ✅ | ✅ |
| Employee | ✅ | ✅ | ✅ | ❌ | ✅ |
| Estimate | ✅ | ✅ | ✅ | ✅ | ✅ |
| Invoice | ✅ | ✅ | ✅ | ❌ | ✅ |
| Item | ✅ | ✅ | ✅ | ❌ | ✅ |
| JournalEntry | ✅ | ✅ | ✅ | ✅ | ✅ |
| Purchase | ✅ | ✅ | ✅ | ✅ | ✅ |
| Vendor | ✅ | ✅ | ✅ | ✅ | ✅ |

### To Add - Sales & Receivables

| Entity | Create | Get | Update | Delete | Search |
|--------|--------|-----|--------|--------|--------|
| Payment | ✅ | ✅ | ✅ | ✅ | ✅ |
| SalesReceipt | ✅ | ✅ | ✅ | ✅ | ✅ |
| CreditMemo | ✅ | ✅ | ✅ | ✅ | ✅ |
| RefundReceipt | ✅ | ✅ | ✅ | ✅ | ✅ |

### To Add - Purchasing & Payables

| Entity | Create | Get | Update | Delete | Search |
|--------|--------|-----|--------|--------|--------|
| PurchaseOrder | ✅ | ✅ | ✅ | ✅ | ✅ |
| VendorCredit | ✅ | ✅ | ✅ | ✅ | ✅ |

### To Add - Banking

| Entity | Create | Get | Update | Delete | Search |
|--------|--------|-----|--------|--------|--------|
| Deposit | ✅ | ✅ | ✅ | ✅ | ✅ |
| Transfer | ✅ | ✅ | ✅ | ✅ | ✅ |

### To Add - Time & Employees

| Entity | Create | Get | Update | Delete | Search |
|--------|--------|-----|--------|--------|--------|
| TimeActivity | ✅ | ✅ | ✅ | ✅ | ✅ |

### To Add - Settings & Reference

| Entity | Create | Get | Update | Delete | Search |
|--------|--------|-----|--------|--------|--------|
| Class | ✅ | ✅ | ✅ | N/A | ✅ |
| Department | ✅ | ✅ | ✅ | N/A | ✅ |
| Term | ✅ | ✅ | ✅ | N/A | ✅ |
| PaymentMethod | ✅ | ✅ | ✅ | N/A | ✅ |
| TaxCode | N/A | ✅ | N/A | N/A | ✅ |
| TaxRate | N/A | ✅ | N/A | N/A | ✅ |
| CompanyInfo | N/A | ✅ | ✅ | N/A | N/A |
| Attachable | ✅ | ✅ | ✅ | ✅ | ✅ |

## Reports

### Financial Reports
- `report_balance_sheet` - Balance Sheet
- `report_profit_and_loss` - Profit & Loss
- `report_cash_flow` - Cash Flow Statement
- `report_trial_balance` - Trial Balance
- `report_general_ledger` - General Ledger

### Sales & Receivables Reports
- `report_customer_sales` - Sales by Customer Summary
- `report_sales_by_product` - Sales by Product/Service
- `report_aged_receivables` - A/R Aging Summary
- `report_aged_receivables_detail` - A/R Aging Detail
- `report_customer_balance` - Customer Balance Summary

### Expenses & Payables Reports
- `report_aged_payables` - A/P Aging Summary
- `report_aged_payables_detail` - A/P Aging Detail
- `report_expenses_by_vendor` - Expenses by Vendor Summary
- `report_vendor_balance` - Vendor Balance Summary

### Tax Reports
- `report_sales_tax_liability` - Sales Tax Liability

## Testing Strategy

### Framework
- Jest with TypeScript support
- 100% coverage threshold enforced

### Mocking Approach
- Mock `node-quickbooks` library at module level
- Fixture files for API responses
- No actual API calls in tests

### Test Structure
Each tool/handler has corresponding test file:
```
src/tools/create-invoice.tool.ts
tests/unit/tools/create-invoice.tool.test.ts
```

## Implementation Order

1. Jest infrastructure setup
2. Fill gaps in existing entities (missing delete operations)
3. Add new entities by category
4. Add reports
5. Achieve 100% test coverage
6. Update README

## Authentication

Preserved from existing implementation:
- Environment variables: `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_REFRESH_TOKEN`, `QUICKBOOKS_REALM_ID`
- Optional OAuth flow for initial token acquisition
- Automatic token refresh

## Distribution

- npm package: `@nichewizard/quickbooks-mcp` (upstream was `@qboapi/qbo-mcp-server`)
- Claude Code MCP plugin configuration
- Contribution back to upstream Intuit repository
