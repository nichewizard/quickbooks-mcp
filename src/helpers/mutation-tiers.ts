/**
 * Tier data for the confirmation gate.
 *
 * This file is the part that changes when upstream adds a tool. Keep it as
 * data: the 100% coverage gate in jest.config.js means every branch needs a
 * test, and Set membership has no branches.
 */

export type Tier = "ALWAYS" | "AUTO";

/**
 * Ask regardless of amount: deletes, money movement, journal entries, file
 * uploads, structural edits that can misstate the books, and every
 * transaction document (invoices, bills, estimates, purchases, purchase
 * orders, sales receipts, credit memos, vendor credits).
 *
 * Transaction documents used to be a separate THRESHOLD tier that only
 * prompted above a dollar amount inferred from the payload by
 * `extractAmount`. That inference was removed as a gating input after four
 * separate regressions surfaced in the same mechanism (a new traversal path
 * outrunning its arithmetic bounds), plus two understatement paths that are
 * not fixable in code at all — see the block comment on `extractAmount`
 * below for the full account. Every money document now always prompts.
 */
export const ALWAYS_TOOLS: ReadonlySet<string> = new Set([
  "create_attachable", "create_bill", "create_bill_payment",
  "create_credit_memo", "create_deposit", "create_estimate",
  "create_invoice", "create_journal_entry", "create_payment",
  "create_purchase", "create_purchase_order", "create_refund_receipt",
  "create_sales_receipt", "create_transfer", "create_vendor_credit",
  "delete_attachable", "delete_bill", "delete_bill_payment",
  "delete_credit_memo", "delete_customer", "delete_deposit",
  "delete_employee", "delete_estimate", "delete_invoice", "delete_item",
  "delete_journal_entry", "delete_payment", "delete_purchase",
  "delete_purchase_order", "delete_refund_receipt", "delete_sales_receipt",
  "delete_time_activity", "delete_transfer", "delete_vendor",
  "delete_vendor_credit",
  "update_account", "update_attachable", "update_bill",
  "update_bill_payment", "update_company_info", "update_credit_memo",
  "update_deposit", "update_estimate", "update_invoice",
  "update_journal_entry", "update_payment", "update_purchase",
  "update_purchase_order", "update_refund_receipt", "update_sales_receipt",
  "update_transfer", "update_vendor_credit",
]);

/** Execute and report afterwards: master data. */
export const AUTO_TOOLS: ReadonlySet<string> = new Set([
  "create_account", "create_class", "create_customer", "create_department",
  "create_employee", "create_item", "create_payment_method", "create_term",
  "create_time_activity", "create_vendor",
  "update_class", "update_customer", "update_department", "update_employee",
  "update_item", "update_payment_method", "update_term",
  "update_time_activity", "update_vendor",
]);

/**
 * `mcp__qbo-write__delete_invoice` -> `delete_invoice`.
 * The non-greedy `.+?` stops at the first `__` pair, which is correct even
 * though the server name contains a hyphen.
 */
export function normalizeToolName(raw: string): string {
  return raw.trim().replace(/^mcp__.+?__/, "").replace(/-/g, "_");
}

/** Returns null for anything not in the tables — callers must fail closed. */
export function classifyTool(normalized: string): Tier | null {
  if (ALWAYS_TOOLS.has(normalized)) return "ALWAYS";
  if (AUTO_TOOLS.has(normalized)) return "AUTO";
  return null;
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Sums an array of rows, failing closed on ANY unusable row.
 *
 * Deliberately does NOT skip bad rows and return a partial sum. `extractAmount`
 * is display-only now (see its docstring), but a partial sum is still a wrong
 * sum, and a wrong displayed figure is worse than none - the same
 * "unknown reads as safe" failure the null-escalation rule always guarded
 * against. Returns null so callers can tell "nothing usable" from a real 0.
 */
function sumBy(arr: unknown[], pick: (row: Record<string, unknown>) => number | null): number | null {
  let sum = 0;
  let found = false;
  for (const row of arr) {
    if (row === null || typeof row !== "object") return null;
    const n = pick(row as Record<string, unknown>);
    if (n === null) return null;
    sum += n;
    found = true;
  }
  return found ? sum : null;
}

const AMOUNT_FIELD_NAMES = ["TotalAmt", "total_amount", "totalAmt", "Amount", "amount"] as const;

/**
 * Per-row candidate for a line_items[] entry: the higher of a direct
 * .amount and qty*unit_price, whichever route(s) yield a number. A one-field
 * decoy (a lowball .amount alongside a real qty/unit_price pair, or vice
 * versa) must not be able to shadow the larger of the two - the gate has to
 * see whichever value is bigger, not whichever field happens to be checked
 * first.
 */
function pickLineItemAmount(r: Record<string, unknown>): number | null {
  const direct = toFiniteNumber(r.amount);
  const q = toFiniteNumber(r.qty);
  const u = toFiniteNumber(r.unit_price);
  const computed = q !== null && u !== null ? q * u : null;
  if (direct !== null && computed !== null) return Math.max(direct, computed);
  if (direct !== null) return direct;
  return computed;
}

/**
 * Amount fields, line_items[], and Line[], all tried against a single flat
 * object (no envelope-unwrapping here — that is the caller's job). Returns
 * the highest of whichever routes yielded a finite number, rather than the
 * first: a low decoy in one field must not be able to shadow a larger real
 * total sitting in another field on the same object. Overstating an amount
 * only ever causes more prompts, never fewer, so "highest wins" is
 * fail-safe. Fails closed: `sumBy` returns null on any unusable row rather
 * than a partial sum, and this function returns null (not 0) when nothing
 * usable is found anywhere, exactly like the pre-widening version did at
 * the top level.
 */
function extractFromFlat(obj: Record<string, unknown>): number | null {
  const candidates: number[] = [];

  for (const key of AMOUNT_FIELD_NAMES) {
    const n = toFiniteNumber(obj[key]);
    if (n !== null) {
      candidates.push(n);
      break;
    }
  }

  // A present-but-unusable line array must poison the result rather than be
  // skipped in favor of some other candidate (a top-level amount field, or
  // nothing at all). Falling through here previously let an unusable line
  // array be silently discarded while a lowball sibling field won - the
  // fourth of the four gating regressions this file's tests pin.
  if (Array.isArray(obj.line_items)) {
    const s = sumBy(obj.line_items, pickLineItemAmount);
    if (s === null) return null;
    candidates.push(s);
  }

  if (Array.isArray(obj.Line)) {
    const s = sumBy(obj.Line, (r) => toFiniteNumber(r.Amount));
    if (s === null) return null;
    candidates.push(s);
  }

  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/**
 * Envelope keys that nest the whole mutating payload under a single property
 * instead of carrying the amount at the top level of the tool params:
 *   - `entity` — the original (pre-widening) generic wrapper, kept for
 *     back-compat with anything that used it.
 *   - `bill` / `estimate` / `purchase` — create_bill, create_estimate,
 *     create_purchase and their update_ counterparts nest the whole record
 *     under a key matching the entity name (see src/tools/create-bill.tool.ts
 *     et al.).
 *   - `patch` — update_invoice's sparse-update shape (`{ invoice_id, patch }`).
 * A small loop over known envelope keys, rather than four copy-pasted
 * blocks, so a new envelope-shaped tool is a one-line addition here.
 */
const AMOUNT_ENVELOPE_KEYS = ["entity", "bill", "estimate", "purchase", "patch"] as const;

/**
 * Best-effort amount, absolute value. Returns null when it cannot be
 * determined.
 *
 * DISPLAY-ONLY. Nothing in this codebase gates a permission decision on this
 * value — every ALWAYS-tier tool always prompts regardless of what this
 * returns. It exists solely to put a dollar figure in the human-readable
 * confirmation prompt when one is confidently known.
 *
 * This function used to be a gating input for a THRESHOLD tier that skipped
 * the prompt below a dollar amount. That design was abandoned after four
 * separate regressions surfaced in the same mechanism - a new traversal path
 * outrunning its arithmetic bounds each time:
 *   1. partial line-item sums understated a total (fixed: `sumBy` fails
 *      closed on any unusable row instead of summing the rest)
 *   2. a decoy `amount` field on a line item shadowed `qty * unit_price`
 *      (fixed: `pickLineItemAmount` takes the max of the two, not the first)
 *   3. `NaN` from multiplication overflow poisoned `Math.max`, so
 *      `NaN > threshold` read as "under threshold" (fixed: the finite check
 *      at the bottom of this function)
 *   4. an unusable line array was skipped rather than poisoning the result,
 *      letting a lowball sibling field win (fixed: `extractFromFlat` returns
 *      null immediately instead of falling through)
 * Two more understatement paths are not fixable in code at all: QuickBooks
 * computes tax on top of line totals, and a caller-supplied `TxnTaxDetail`
 * would be invisible to this function entirely. The gate inspects a payload
 * before zod strips unknown fields, before the handler transforms it, and
 * before QuickBooks computes the final total - it can never reliably know
 * what will actually post. Given that, every money document now always
 * prompts (see `ALWAYS_TOOLS` above) and this function is kept only for
 * display. Do not reintroduce amount-based gating; add a test that would
 * fail if someone tried instead.
 *
 * Collects a candidate from the top-level flat object AND from every
 * envelope key, then takes the highest rather than returning on first hit.
 * A decoy at the top level (e.g. `{TotalAmt: 1, bill: {TotalAmt: 50000}}`)
 * must not be able to shadow the real amount sitting inside an envelope, or
 * vice versa - only the maximum across every route the payload could carry
 * an amount in is safe to display. Overstating is safe (it can only make the
 * displayed figure look scarier than reality, never friendlier); the finite
 * check at the end ensures it also never understates via `NaN`/`Infinity`.
 */
export function extractAmount(params: unknown): number | null {
  if (params === null || typeof params !== "object") return null;
  const p = params as Record<string, unknown>;

  const candidates: number[] = [];

  const direct = extractFromFlat(p);
  if (direct !== null) candidates.push(Math.abs(direct));

  for (const envelopeKey of AMOUNT_ENVELOPE_KEYS) {
    const envelope = p[envelopeKey];
    if (envelope !== null && typeof envelope === "object" && !Array.isArray(envelope)) {
      const n = extractFromFlat(envelope as Record<string, unknown>);
      if (n !== null) candidates.push(Math.abs(n));
    }
  }

  if (candidates.length === 0) return null;
  // A line_items row that multiplies out to Infinity (e.g. qty/unit_price at
  // the edge of the float range) turns Math.max's result into NaN as soon as
  // it is compared against any other candidate, and NaN compares false in
  // both directions - `NaN > threshold` reads as "under threshold" instead
  // of failing closed. Requiring the max itself to be finite closes that
  // path: display-only or not, this function must never hand back a number
  // that lies about the payload.
  const max = Math.max(...candidates);
  return Number.isFinite(max) ? max : null;
}
