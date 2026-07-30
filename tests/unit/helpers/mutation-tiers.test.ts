import { describe, it, expect } from "@jest/globals";
import {
  normalizeToolName,
  classifyTool,
  extractAmount,
  ALWAYS_TOOLS,
  AUTO_TOOLS,
} from "../../../src/helpers/mutation-tiers";

describe("normalizeToolName", () => {
  it("strips the mcp server prefix", () =>
    expect(normalizeToolName("mcp__qbo-write__delete_invoice")).toBe("delete_invoice"));
  it("keeps a bare name unchanged", () =>
    expect(normalizeToolName("delete_invoice")).toBe("delete_invoice"));
  it("converts hyphen verb form to underscore", () =>
    expect(normalizeToolName("create-bill")).toBe("create_bill"));
  it("handles prefix and hyphen together", () =>
    expect(normalizeToolName("mcp__qbo-write__update-vendor")).toBe("update_vendor"));
  it("trims surrounding whitespace", () =>
    expect(normalizeToolName("  delete_invoice  ")).toBe("delete_invoice"));
});

describe("classifyTool", () => {
  it("classifies every delete as ALWAYS", () =>
    expect(classifyTool("delete_invoice")).toBe("ALWAYS"));
  it("classifies money movement as ALWAYS", () =>
    expect(classifyTool("create_payment")).toBe("ALWAYS"));
  it("classifies journal entries as ALWAYS", () =>
    expect(classifyTool("create_journal_entry")).toBe("ALWAYS"));
  it("classifies attachable writes as ALWAYS", () =>
    expect(classifyTool("create_attachable")).toBe("ALWAYS"));
  it("classifies update_account as ALWAYS", () =>
    expect(classifyTool("update_account")).toBe("ALWAYS"));
  it("classifies update_company_info as ALWAYS", () =>
    expect(classifyTool("update_company_info")).toBe("ALWAYS"));
  it("classifies transaction documents as ALWAYS", () =>
    expect(classifyTool("create_invoice")).toBe("ALWAYS"));
  it("classifies document updates as ALWAYS", () =>
    expect(classifyTool("update_bill")).toBe("ALWAYS"));
  it("classifies master data as AUTO", () =>
    expect(classifyTool("create_customer")).toBe("AUTO"));
  it("classifies create_account as AUTO", () =>
    expect(classifyTool("create_account")).toBe("AUTO"));
  it("returns null for an unrecognized tool", () =>
    expect(classifyTool("create_widget")).toBeNull());
  it("returns null for a read tool", () =>
    expect(classifyTool("search_invoices")).toBeNull());
});

// The THRESHOLD tier was removed after four separate regressions in
// extractAmount-based gating (partial line-item sums, a decoy amount field,
// NaN-poisoned Math.max, and a skipped-instead-of-poisoning unusable line
// array), plus two understatement paths that cannot be fixed in code at all:
// QuickBooks computes tax on top of line totals, and a caller-supplied
// TxnTaxDetail is invisible to the gate. Every money document now always
// prompts. This table asserts the tier tables reflect that: all 52 ALWAYS
// tools classify as ALWAYS, all 19 AUTO tools classify as AUTO, the two sets
// are disjoint, and the total is 71 - the full, unchanged count of mutating
// tools this gate covers.
describe("tier table completeness (THRESHOLD removed)", () => {
  it("has exactly 52 ALWAYS tools", () => expect(ALWAYS_TOOLS.size).toBe(52));
  it("has exactly 19 AUTO tools", () => expect(AUTO_TOOLS.size).toBe(19));
  it("has no overlap between ALWAYS and AUTO", () => {
    const overlap = [...ALWAYS_TOOLS].filter((t) => AUTO_TOOLS.has(t));
    expect(overlap).toEqual([]);
  });
  it("totals 71 tiered tools", () => {
    expect(ALWAYS_TOOLS.size + AUTO_TOOLS.size).toBe(71);
  });
  it("classifies every ALWAYS tool as ALWAYS", () => {
    for (const tool of ALWAYS_TOOLS) {
      expect(classifyTool(tool)).toBe("ALWAYS");
    }
  });
  it("classifies every AUTO tool as AUTO", () => {
    for (const tool of AUTO_TOOLS) {
      expect(classifyTool(tool)).toBe("AUTO");
    }
  });
});

describe("extractAmount", () => {
  it("returns null for a non-object", () => expect(extractAmount("x")).toBeNull());
  it("returns null for null", () => expect(extractAmount(null)).toBeNull());
  it("reads TotalAmt", () => expect(extractAmount({ TotalAmt: 1500 })).toBe(1500));
  it("reads total_amount", () => expect(extractAmount({ total_amount: 42 })).toBe(42));
  it("reads totalAmt", () => expect(extractAmount({ totalAmt: 7 })).toBe(7));
  it("reads Amount", () => expect(extractAmount({ Amount: 12.5 })).toBe(12.5));
  it("reads amount", () => expect(extractAmount({ amount: 3 })).toBe(3));
  it("coerces a numeric string", () => expect(extractAmount({ TotalAmt: "250.75" })).toBe(250.75));
  it("ignores an empty string", () => expect(extractAmount({ TotalAmt: "" })).toBeNull());
  it("ignores a non-numeric string", () => expect(extractAmount({ TotalAmt: "abc" })).toBeNull());
  it("ignores Infinity", () => expect(extractAmount({ TotalAmt: Infinity })).toBeNull());
  it("ignores NaN", () => expect(extractAmount({ TotalAmt: NaN })).toBeNull());
  it("ignores a boolean", () => expect(extractAmount({ TotalAmt: true })).toBeNull());
  it("reads entity.TotalAmt", () =>
    expect(extractAmount({ entity: { TotalAmt: 900 } })).toBe(900));
  it("reads entity.Amount", () =>
    expect(extractAmount({ entity: { Amount: 80 } })).toBe(80));
  it("reads entity.total_amount", () =>
    expect(extractAmount({ entity: { total_amount: 65 } })).toBe(65));
  // Previously missing per the final review's Finding 4 note.
  it("reads entity.totalAmt", () =>
    expect(extractAmount({ entity: { totalAmt: 33 } })).toBe(33));
  it("reads entity.amount", () =>
    expect(extractAmount({ entity: { amount: 21 } })).toBe(21));
  it("ignores a non-object entity", () =>
    expect(extractAmount({ entity: "nope" })).toBeNull());
  it("sums line_items qty * unit_price", () =>
    expect(extractAmount({ line_items: [{ qty: 2, unit_price: 100 }, { qty: 1, unit_price: 50 }] })).toBe(250));
  // create_vendor_credit / update_vendor_credit lines carry `amount`
  // directly rather than qty/unit_price (see vendorCreditLineItemSchema in
  // src/tools/create-vendor-credit.tool.ts).
  it("sums line_items[].amount directly when qty/unit_price are absent", () =>
    expect(extractAmount({ line_items: [{ amount: 150 }, { amount: 50 }] })).toBe(200));
  it("takes the higher of a row's direct .amount and qty * unit_price when both are present", () =>
    expect(extractAmount({ line_items: [{ amount: 999, qty: 1, unit_price: 1 }] })).toBe(999));
  it("fails closed when a line_items row has neither .amount nor a usable qty/unit_price pair", () =>
    expect(extractAmount({ line_items: [{ amount: 100 }, { qty: 1 }] })).toBeNull());
  // Fails closed rather than returning a partial sum: an understated total
  // could slip under the prompt threshold and execute unprompted.
  it("fails closed when any line_items entry has a missing number", () =>
    expect(extractAmount({ line_items: [{ qty: 2, unit_price: 100 }, { qty: null }] })).toBeNull());
  it("fails closed on a non-object line_items entry", () =>
    expect(extractAmount({ line_items: ["x", { qty: 1, unit_price: 5 }] })).toBeNull());
  it("fails closed on a multi-line total with one malformed line", () =>
    expect(extractAmount({ line_items: [
      { qty: 1, unit_price: 900 },
      { qty: 1, unit_price: "n/a" },
      { qty: 1, unit_price: 50 },
    ] })).toBeNull());
  it("returns null when no line_items entry is usable", () =>
    expect(extractAmount({ line_items: [{ qty: null }] })).toBeNull());
  it("returns null for an empty line_items array", () =>
    expect(extractAmount({ line_items: [] })).toBeNull());
  it("sums Line[].Amount", () =>
    expect(extractAmount({ Line: [{ Amount: 10 }, { Amount: 15 }] })).toBe(25));
  it("fails closed on a null Line entry", () =>
    expect(extractAmount({ Line: [null, { Amount: 4 }] })).toBeNull());
  it("fails closed on a garbled Line amount", () =>
    expect(extractAmount({ Line: [{ Amount: 5 }, { Amount: "garbled" }] })).toBeNull());
  it("returns null when no Line entry is usable", () =>
    expect(extractAmount({ Line: [{ Amount: "x" }] })).toBeNull());
  it("returns null for an empty Line array", () =>
    expect(extractAmount({ Line: [] })).toBeNull());
  it("returns absolute value for a negative amount", () =>
    expect(extractAmount({ TotalAmt: -500 })).toBe(500));
  it("returns 0 for an explicit zero", () => expect(extractAmount({ TotalAmt: 0 })).toBe(0));
  it("returns null when nothing matches", () => expect(extractAmount({ foo: "bar" })).toBeNull());

  // Finding 3 (final review): every prior test above used a synthetic
  // { TotalAmt: n } shape at the top level. No registered tool actually
  // produces that shape - describeMutation calls extractAmount with
  // unwrap(tool_input), i.e. `tool_input.params` verbatim, and the amount is
  // nested under an envelope key (or missing entirely) for 15 of the 16
  // THRESHOLD tools. These tests use the real params shape each tool in
  // src/tools/*.tool.ts actually produces.
  describe("extractAmount against real tool param shapes", () => {
    // create-bill.tool.ts / update-bill.tool.ts: { bill: { Line: [...], ... } }
    it("create_bill: reads bill.TotalAmt when the caller supplies it", () =>
      expect(extractAmount({ bill: { VendorRef: { value: "1" }, TotalAmt: 742.5 } })).toBe(742.5));
    it("create_bill: sums bill.Line[].Amount when TotalAmt is omitted (Amount is required per line)", () =>
      expect(
        extractAmount({
          bill: {
            VendorRef: { value: "1" },
            Line: [
              { Amount: 100, DetailType: "AccountBasedExpenseLineDetail" },
              { Amount: 25.5, DetailType: "AccountBasedExpenseLineDetail" },
            ],
          },
        })
      ).toBe(125.5));
    it("update_bill: fails closed when a bill.Line row omits Amount (optional on update)", () =>
      expect(
        extractAmount({
          bill: { Id: "9", Line: [{ Id: "1", Amount: 10 }, { Id: "2", DetailType: "x" }] },
        })
      ).toBeNull());

    // create-estimate.tool.ts / update-estimate.tool.ts: { estimate: <any QBO Estimate> }
    it("create_estimate: sums estimate.Line[].Amount", () =>
      expect(
        extractAmount({
          estimate: {
            CustomerRef: { value: "1" },
            Line: [{ Amount: 400, DetailType: "SalesItemLineDetail" }],
          },
        })
      ).toBe(400));
    it("update_estimate: reads estimate.TotalAmt", () =>
      expect(extractAmount({ estimate: { Id: "1", TotalAmt: 88 } })).toBe(88));

    // create-purchase.tool.ts / update-purchase.tool.ts: { purchase: <any QBO Purchase> }
    it("create_purchase: sums purchase.Line[].Amount", () =>
      expect(extractAmount({ purchase: { Line: [{ Amount: 60 }, { Amount: 15 }] } })).toBe(75));
    it("update_purchase: reads purchase.total_amount", () =>
      expect(extractAmount({ purchase: { Id: "1", total_amount: 30 } })).toBe(30));

    // update-invoice.tool.ts: { invoice_id, patch: {...} } (sparse update)
    it("update_invoice: reads patch.TotalAmt", () =>
      expect(extractAmount({ invoice_id: "42", patch: { TotalAmt: 260 } })).toBe(260));
    it("update_invoice: sums patch.Line[].Amount when the patch replaces lines", () =>
      expect(
        extractAmount({ invoice_id: "42", patch: { Line: [{ Amount: 12 }, { Amount: 8 }] } })
      ).toBe(20));
    it("update_invoice: returns null for a patch touching only non-amount fields", () =>
      expect(extractAmount({ invoice_id: "42", patch: { DocNumber: "1099" } })).toBeNull());

    // create-vendor-credit.tool.ts / update-vendor-credit.tool.ts: top-level
    // line_items[] with `amount` (vendorCreditLineItemSchema), no envelope.
    it("create_vendor_credit: sums top-level line_items[].amount", () =>
      expect(
        extractAmount({
          vendor_ref: "1",
          line_items: [{ amount: 45 }, { amount: 55 }],
        })
      ).toBe(100));
    it("update_vendor_credit: sums top-level line_items[].amount", () =>
      expect(
        extractAmount({ id: "1", sync_token: "1", line_items: [{ amount: 10 }] })
      ).toBe(10));

    // update-credit-memo.tool.ts, update-purchase-order.tool.ts,
    // update-sales-receipt.tool.ts: no amount field anywhere in the schema.
    // These correctly still return null (and therefore still always ask) -
    // there is nothing to widen for them.
    it("update_credit_memo: has no amount field in its schema, so this always returns null", () =>
      expect(
        extractAmount({ id: "1", sync_token: "1", customer_ref: "2", doc_number: "CM-1" })
      ).toBeNull());
    it("update_purchase_order: has no amount field in its schema, so this always returns null", () =>
      expect(
        extractAmount({ id: "1", sync_token: "1", vendor_ref: "2", doc_number: "PO-1" })
      ).toBeNull());
    it("update_sales_receipt: has no amount field in its schema, so this always returns null", () =>
      expect(
        extractAmount({ id: "1", sync_token: "1", customer_ref: "2", doc_number: "SR-1" })
      ).toBeNull());
  });

  // Critical fix: a one-field decoy used to shadow the real total because
  // extractAmount returned the FIRST candidate it found rather than the
  // highest. lineItemSchema/etc. have no `amount` field, so zod strips a
  // decoy like this before it ever reaches QuickBooks - but the gate saw it
  // and approved a payload it should have escalated. "Highest wins" closes
  // this because overstating an amount only ever produces more prompts,
  // never fewer.
  describe("amount-decoy fail-open (highest wins, not first)", () => {
    it("a lowball line_items[].amount cannot shadow the real qty * unit_price total", () =>
      expect(
        extractAmount({ line_items: [{ qty: 100, unit_price: 500, amount: 1 }] })
      ).toBe(50000));
    it("a lowball top-level TotalAmt cannot shadow a real Line[] total", () =>
      expect(extractAmount({ TotalAmt: 1, Line: [{ Amount: 50000 }] })).toBe(50000));
    it("a lowball top-level TotalAmt cannot shadow a real envelope TotalAmt (create_bill shape)", () =>
      expect(extractAmount({ TotalAmt: 1, bill: { TotalAmt: 50000 } })).toBe(50000));
    it("a lowball envelope TotalAmt cannot shadow a real envelope Line[] total", () =>
      expect(
        extractAmount({ bill: { TotalAmt: 1, Line: [{ Amount: 50000 }] } })
      ).toBe(50000));
  });

  // Pins two branches the reviewer found were covered but not actually
  // tested: mutation testing could remove them and all 809 tests still
  // passed. Both are genuine security properties of the envelope path, not
  // incidental - a future edit must not be able to silently drop either.
  describe("envelope path branches (mutation-tested, previously unpinned)", () => {
    it("returns the absolute value for a negative amount nested in an envelope", () =>
      expect(extractAmount({ bill: { TotalAmt: -500 } })).toBe(500));

    it("does not treat an array assigned to an envelope key as an envelope object", () => {
      // Plain JSON can never produce this shape (array literals can't carry
      // named properties), so it has to be constructed - but it is the only
      // input that actually distinguishes "skip arrays" from "no guard at
      // all": extractFromFlat looks up obj["TotalAmt"] etc. by name, which
      // is undefined on every ordinary array (even one full of {TotalAmt}
      // objects), so ordinary array-shaped decoys read as null with or
      // without the guard. Attaching TotalAmt directly onto the array is
      // what makes the two behaviors observably different, and pins that
      // `!Array.isArray(envelope)` in the guard is load-bearing.
      const arrayEnvelope: unknown = Object.assign([1, 2, 3], { TotalAmt: 777 });
      expect(extractAmount({ bill: arrayEnvelope })).toBeNull();
    });
  });

  // Regression 4 (THRESHOLD-tier removal): an unusable line array used to be
  // skipped rather than poisoning the result, so a lowball sibling field won.
  // extractFromFlat now returns null immediately when sumBy can't make sense
  // of line_items or Line, discarding every other candidate on that object -
  // it never falls through to a sibling amount field. These tests would FAIL
  // if that `if (s === null) return null;` guard were reverted to the old
  // "skip and fall through" behavior (each would return the lowball sibling
  // value instead of null).
  describe("unusable line array poisons the result (does not fall through)", () => {
    it("an unusable Line[] entry poisons the result even though a top-level TotalAmt is present", () =>
      expect(
        extractAmount({ TotalAmt: 1, Line: [{ Amount: 50000 }, { Description: "note" }] })
      ).toBeNull());
    it("an unusable line_items[] entry poisons the result even though a top-level TotalAmt is present", () =>
      expect(
        extractAmount({ TotalAmt: 1, line_items: [{ qty: 1, unit_price: 500 }, { note: "n/a" }] })
      ).toBeNull());
    // Exact shape from the verify table: update_bill with bill.Id present
    // (usable, not amount-bearing) alongside a partially-unusable bill.Line[]
    // and a lowball bill.TotalAmt.
    it("update_bill: an unusable bill.Line[] row poisons the result despite bill.TotalAmt", () =>
      expect(
        extractAmount({
          bill: {
            Id: "5",
            TotalAmt: 1,
            Line: [{ Id: "1", Amount: 50000 }, { Id: "2", Description: "note" }],
          },
        })
      ).toBeNull());
  });

  // Regression 3 (THRESHOLD-tier removal): qty * unit_price can overflow to
  // Infinity, and Infinity + (-Infinity) from a second line collapses the sum
  // to NaN. Math.max propagates that NaN, and `NaN > threshold` reads as
  // "under threshold" - the opposite of fail-closed. extractAmount now
  // requires its own Math.max result to be finite. This test would FAIL if
  // that `Number.isFinite(max) ? max : null` guard were reverted (it would
  // return NaN instead of null).
  describe("NaN from multiplication overflow poisons Math.max (fails closed)", () => {
    it("cancelling-overflow line_items entries collapse to NaN and return null", () =>
      expect(
        extractAmount({
          line_items: [
            { qty: 1e200, unit_price: 1e200 },
            { qty: -1e200, unit_price: 1e200 },
          ],
        })
      ).toBeNull());
    // Exact shape from the verify table: a legitimate small line_items total
    // at the top level alongside an overflow-NaN pair nested under `entity`.
    // The NaN candidate must poison the overall max, not merely lose to the
    // legitimate one.
    it("an overflow-NaN candidate under an envelope key poisons a legitimate top-level candidate", () =>
      expect(
        extractAmount({
          line_items: [{ qty: 100, unit_price: 500 }],
          entity: {
            line_items: [
              { qty: 1e200, unit_price: 1e200 },
              { qty: -1e200, unit_price: 1e200 },
            ],
          },
        })
      ).toBeNull());
  });
});
