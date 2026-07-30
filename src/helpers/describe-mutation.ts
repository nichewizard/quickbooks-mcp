/**
 * Renders a mutating tool call as plain English and applies the fail-closed
 * escalation rules. Pure: no I/O, no environment reads.
 *
 * The returned `tier` is the EFFECTIVE tier after escalation, which is what
 * callers should switch on.
 */
import {
  Tier,
  normalizeToolName,
  classifyTool,
  extractAmount,
} from "./mutation-tiers.js";

export const SUMMARY_MAX_CHARS = 1200;

export interface MutationDescription {
  tier: Tier;
  summary: string;
  amount: number | null;
  reasons: string[];
}

const usd = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const VERBS: Record<string, string> = { create: "CREATE", update: "UPDATE", delete: "DELETE" };

/** `delete_invoice` -> `{ verb: "DELETE", entity: "invoice" }` */
function splitName(normalized: string): { verb: string; entity: string } {
  const [head, ...rest] = normalized.split("_");
  return { verb: VERBS[head] ?? head.toUpperCase(), entity: rest.join(" ") || normalized };
}

/** Tool args arrive as `{ params: {...} }` over MCP; accept either shape. */
function unwrap(params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== "object") return {};
  const p = params as Record<string, unknown>;
  const inner = p.params;
  if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return p;
}

function firstString(p: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/**
 * There is no amount-based branch here on purpose. `extractAmount` is
 * display-only (see its docstring in mutation-tiers.ts): a wrong or garbled
 * figure in a human-approval prompt is worse than no figure, and every path
 * that tried to infer a total from the payload before zod validation, the
 * handler's own transform, and QuickBooks' own tax computation eventually
 * regressed. Do not add a `tier-*` branch that reads `amount` — money
 * documents always prompt.
 */
export function describeMutation(toolName: string, params: unknown): MutationDescription {
  const normalized = normalizeToolName(toolName);
  const raw = classifyTool(normalized);
  const p = unwrap(params);
  const amount = extractAmount(p);
  const reasons: string[] = [];

  let tier: Tier;
  if (raw === null) {
    tier = "ALWAYS";
    reasons.push("unrecognized-tool");
  } else {
    tier = raw;
    reasons.push(`tier-${raw.toLowerCase()}`);
  }

  const { verb, entity } = splitName(normalized);

  // Rendered as a SINGLE LINE. Claude Code's approval dialog collapses
  // whitespace in permissionDecisionReason, so newlines and blank-line
  // grouping are lost, and the summary sits above a large JSON dump of the
  // tool arguments. Verified live: a three-line summary rendered as one
  // run-on sentence and read as noise. Use explicit separators, put the
  // irreversibility warning last where it terminates the line, and keep it
  // short enough to survive next to the JSON.
  const parts: string[] = [`${verb} ${entity} on LIVE books`];

  const label = firstString(p, ["DisplayName", "Name", "CompanyName", "doc_number", "DocNumber"]);
  if (label !== null) parts.push(label);
  // extractAmount guarantees a non-null return is finite (see its docstring
  // and the Number.isFinite check at its end) and only ever overstates, so
  // this null check alone is sufficient to keep NaN/undefined/garbled
  // figures out of text a human approves against.
  if (amount !== null) parts.push(usd(amount));
  const date = firstString(p, ["txn_date", "TxnDate"]);
  if (date !== null) parts.push(date);
  const id = firstString(p, ["idOrEntity", "id", "Id"]);
  if (id !== null) parts.push(`Id ${id}`);

  if (reasons.includes("unrecognized-tool")) {
    parts.push("UNRECOGNIZED TOOL, asking by default");
  }
  if (verb === "DELETE") {
    parts.push("IRREVERSIBLE, recoverable only via the QuickBooks Audit Log");
  }

  let summary = parts.join(" \u00B7 ");
  if (summary.length > SUMMARY_MAX_CHARS) {
    summary = `${summary.slice(0, SUMMARY_MAX_CHARS - 16)}... (truncated)`;
  }

  return { tier, summary, amount, reasons };
}
