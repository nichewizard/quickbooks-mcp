import { describe, it, expect } from "@jest/globals";
import { describeMutation, SUMMARY_MAX_CHARS } from "../../../src/helpers/describe-mutation";

describe("describeMutation fail-closed rules", () => {
  it("escalates an unrecognized tool to ALWAYS", () => {
    const d = describeMutation("create_widget", {});
    expect(d.tier).toBe("ALWAYS");
    expect(d.reasons).toContain("unrecognized-tool");
    expect(d.summary).toContain("Unrecognized tool");
  });

  it("leaves ALWAYS tools as ALWAYS", () => {
    expect(describeMutation("delete_invoice", { idOrEntity: "1042" }).tier).toBe("ALWAYS");
  });

  // Transaction documents used to be a separate THRESHOLD tier that only
  // prompted above a dollar amount. That tier was removed after four
  // separate regressions in the amount-inference mechanism, plus two
  // understatement paths (QBO tax computation, an invisible TxnTaxDetail)
  // that cannot be fixed in code at all. create_invoice is now ALWAYS
  // regardless of amount - see src/helpers/mutation-tiers.ts for the full
  // account. This pins that a money document always prompts even when a
  // large, confidently-known amount is present.
  it("always asks for a transaction document (create_invoice), regardless of amount", () => {
    const small = describeMutation("create_invoice", { TotalAmt: 40 });
    expect(small.tier).toBe("ALWAYS");
    const large = describeMutation("create_invoice", { TotalAmt: 5000 });
    expect(large.tier).toBe("ALWAYS");
  });

  it("leaves AUTO tools as AUTO", () => {
    expect(describeMutation("create_customer", { DisplayName: "Acme" }).tier).toBe("AUTO");
  });

  it("does not escalate AUTO tools regardless of any amount-shaped field present", () => {
    const d = describeMutation("create_customer", { TotalAmt: 99999 });
    expect(d.tier).toBe("AUTO");
  });

  it("accepts the mcp-prefixed tool name", () => {
    expect(describeMutation("mcp__qbo-write__delete_invoice", {}).tier).toBe("ALWAYS");
  });

  it("accepts the hyphen tool name", () => {
    expect(describeMutation("delete-vendor", {}).tier).toBe("ALWAYS");
  });
});

describe("describeMutation summary", () => {
  it("names the verb, entity, and live books", () => {
    const s = describeMutation("delete_invoice", { idOrEntity: "1042" }).summary;
    expect(s).toContain("DELETE");
    expect(s).toContain("invoice");
    expect(s).toContain("LIVE books");
  });

  it("formats the amount as USD with separators when a confident amount is present", () => {
    const s = describeMutation("create_invoice", { TotalAmt: 5000 }).summary;
    expect(s).toContain("$5,000.00");
  });

  it("warns about irreversibility on deletes", () => {
    expect(describeMutation("delete_invoice", {}).summary).toContain("Audit Log");
  });

  it("omits the amount line when no amount is known", () => {
    const s = describeMutation("delete_invoice", { idOrEntity: "1" }).summary;
    expect(s).not.toContain("Amount:");
  });

  // extractAmount is now display-only and can only ever overstate or return
  // null (see its docstring). This pins that describeMutation never renders
  // a garbled figure: when extractAmount returns null (e.g. a NaN-producing
  // overflow, or a poisoned unusable-line-array result), the Amount: line is
  // omitted entirely rather than showing NaN, null, or undefined.
  it("omits the amount line rather than rendering NaN when extractAmount returns null", () => {
    const d = describeMutation("create_invoice", {
      line_items: [
        { qty: 1e200, unit_price: 1e200 },
        { qty: -1e200, unit_price: 1e200 },
      ],
    });
    expect(d.amount).toBeNull();
    expect(d.summary).not.toContain("Amount:");
    expect(d.summary).not.toContain("NaN");
    expect(d.summary).not.toContain("$NaN");
  });

  it("includes a display name when present", () => {
    const s = describeMutation("create_customer", { DisplayName: "Acme Supply" }).summary;
    expect(s).toContain("Acme Supply");
  });

  it("includes a doc number when present", () => {
    const s = describeMutation("create_invoice", { doc_number: "1042", TotalAmt: 10 }).summary;
    expect(s).toContain("1042");
  });

  it("includes a txn date when present", () => {
    const s = describeMutation("create_invoice", { txn_date: "2026-07-14", TotalAmt: 10 }).summary;
    expect(s).toContain("2026-07-14");
  });

  it("never invents a field that is absent", () => {
    const s = describeMutation("create_customer", {}).summary;
    expect(s).not.toContain("undefined");
    expect(s).not.toContain("null");
  });

  it("truncates an oversized summary", () => {
    const d = describeMutation("create_customer", { DisplayName: "x".repeat(5000) });
    expect(d.summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(d.summary).toContain("(truncated)");
  });

  it("does not truncate a normal summary", () => {
    expect(describeMutation("create_customer", { DisplayName: "Acme" }).summary)
      .not.toContain("(truncated)");
  });

  it("handles a non-object params payload", () => {
    const d = describeMutation("delete_invoice", null);
    expect(d.tier).toBe("ALWAYS");
    expect(typeof d.summary).toBe("string");
  });

  it("unwraps a params envelope", () => {
    const d = describeMutation("create_invoice", { params: { TotalAmt: 5000 } });
    expect(d.amount).toBe(5000);
  });

  it("does not unwrap when the params envelope value is null", () => {
    const d = describeMutation("create_invoice", { params: null, TotalAmt: 50 });
    expect(d.amount).toBe(50);
  });

  it("does not unwrap when the params envelope value is an array", () => {
    const d = describeMutation("create_invoice", { params: [1, 2, 3], TotalAmt: 60 });
    expect(d.amount).toBe(60);
  });

  it("falls back to the raw name for a tool name with no verb prefix or underscore", () => {
    const s = describeMutation("widget", {}).summary;
    expect(s).toContain("WIDGET widget on LIVE books");
  });
});

// Finding 3 (final review, pre-THRESHOLD-removal): end-to-end proof, using
// the exact MCP tool_input shape (`{ params: {...} }`) that Claude Code hands
// the hook, that a real tool's params flow through unwrap -> extractAmount
// correctly for display purposes. Now that THRESHOLD is gone, every one of
// these tools is ALWAYS regardless of amount - these tests pin that the
// amount is still surfaced for display (when confidently known) without
// affecting the tier.
describe("describeMutation against real tool_input shapes (display-only amount, tier always ALWAYS)", () => {
  it("create_bill: bill.Line[].Amount is surfaced for display; tier is ALWAYS regardless", () => {
    const d = describeMutation(
      "mcp__qbo-write__create_bill",
      { params: { bill: { VendorRef: { value: "1" }, Line: [{ Amount: 50 }] } } }
    );
    expect(d.tier).toBe("ALWAYS");
    expect(d.amount).toBe(50);
    expect(d.summary).toContain("$50.00");
  });

  it("create_bill: a large bill is also ALWAYS", () => {
    const d = describeMutation(
      "mcp__qbo-write__create_bill",
      { params: { bill: { VendorRef: { value: "1" }, Line: [{ Amount: 5000 }] } } }
    );
    expect(d.tier).toBe("ALWAYS");
    expect(d.amount).toBe(5000);
  });

  it("create_vendor_credit: top-level line_items[].amount is surfaced for display", () => {
    const d = describeMutation(
      "mcp__qbo-write__create_vendor_credit",
      { params: { vendor_ref: "1", line_items: [{ amount: 25 }] } }
    );
    expect(d.tier).toBe("ALWAYS");
    expect(d.amount).toBe(25);
  });

  it("update_invoice: patch.TotalAmt is surfaced for display", () => {
    const d = describeMutation(
      "mcp__qbo-write__update_invoice",
      { params: { invoice_id: "1", patch: { TotalAmt: 10 } } }
    );
    expect(d.tier).toBe("ALWAYS");
    expect(d.amount).toBe(10);
  });

  it("update_credit_memo: has no amount field anywhere, so amount is null and it still asks", () => {
    const d = describeMutation(
      "mcp__qbo-write__update_credit_memo",
      { params: { id: "1", sync_token: "1", doc_number: "CM-1" } }
    );
    expect(d.tier).toBe("ALWAYS");
    expect(d.amount).toBeNull();
  });
});
