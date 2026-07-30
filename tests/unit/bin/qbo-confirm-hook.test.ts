import { describe, it, expect, beforeAll, afterEach } from "@jest/globals";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const HOOK = path.join(ROOT, "bin/qbo-confirm-hook");

function run(stdin: string, env: Record<string, string> = {}): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath, [HOOK],
      { env: { ...process.env, ...env }, cwd: ROOT },
      (err, stdout) => resolve({ out: stdout, code: err && typeof err.code === "number" ? err.code : 0 })
    );
    child.stdin?.end(stdin);
  });
}

const decision = (out: string) => JSON.parse(out).hookSpecificOutput.permissionDecision;
const reason = (out: string) => JSON.parse(out).hookSpecificOutput.permissionDecisionReason;

const payload = (tool: string, params: unknown) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { params } });

// --- Isolated-fixture helpers for tests that need a hook copy sitting next
// to a controlled dist/, without ever touching the real one. The hook
// resolves `../dist/...` relative to its own file location, so copying it
// into a throwaway directory next to a stub dist/ exercises the real code
// path in full isolation.

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Copies the real hook into a fresh temp dir with its own `{"type":"module"}`
 *  package.json (required so Node treats the extensionless copy as ESM). */
function makeIsolatedHookDir(): { dir: string; hookPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "qbo-hook-test-"));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, "bin"));
  const hookPath = path.join(dir, "bin", "qbo-confirm-hook");
  copyFileSync(HOOK, hookPath);
  chmodSync(hookPath, 0o700);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  return { dir, hookPath };
}

/** Writes a stub `dist/helpers/describe-mutation.js` so a test can control
 *  exactly what `describeMutation` returns, independent of the real logic. */
function writeStubDist(dir: string, moduleSource: string): void {
  const helpersDir = path.join(dir, "dist", "helpers");
  mkdirSync(helpersDir, { recursive: true });
  writeFileSync(path.join(helpersDir, "describe-mutation.js"), moduleSource);
}

function runIsolated(
  hookPath: string,
  cwd: string,
  stdin: string,
  env: Record<string, string> = {}
): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath, [hookPath],
      { env: { ...process.env, ...env }, cwd },
      (err, stdout) => resolve({ out: stdout, code: err && typeof err.code === "number" ? err.code : 0 })
    );
    child.stdin?.end(stdin);
  });
}

describe("qbo-confirm-hook", () => {
  beforeAll(() => {
    if (!existsSync(path.join(ROOT, "dist/helpers/describe-mutation.js"))) {
      throw new Error("run `npm run build` before this test: the hook imports from dist/");
    }
  });

  it("asks for an ALWAYS tool", async () => {
    const { out } = await run(payload("mcp__qbo-write__delete_invoice", { idOrEntity: "1042" }));
    expect(decision(out)).toBe("ask");
    expect(reason(out)).toContain("DELETE");
  });

  it("allows an AUTO tool", async () => {
    const { out } = await run(payload("mcp__qbo-write__create_customer", { DisplayName: "Acme" }));
    expect(decision(out)).toBe("allow");
  });

  // Transaction documents (create_invoice, create_bill, etc.) used to be a
  // THRESHOLD tier that allowed small amounts through unprompted. That tier
  // is gone: every money document is ALWAYS now, regardless of amount.
  it("asks for a transaction document even with a small amount (THRESHOLD tier removed)", async () => {
    const { out } = await run(payload("mcp__qbo-write__create_invoice", { TotalAmt: 40 }));
    expect(decision(out)).toBe("ask");
  });

  it("asks for a transaction document with a large amount", async () => {
    const { out } = await run(payload("mcp__qbo-write__create_invoice", { TotalAmt: 5000 }));
    expect(decision(out)).toBe("ask");
  });

  it("asks for an unrecognized tool", async () => {
    const { out } = await run(payload("mcp__qbo-write__create_widget", {}));
    expect(decision(out)).toBe("ask");
  });

  it("asks on malformed stdin", async () => {
    const { out } = await run("{not json");
    expect(decision(out)).toBe("ask");
    expect(reason(out)).toContain("failed");
  });

  it("asks on empty stdin", async () => {
    const { out } = await run("");
    expect(decision(out)).toBe("ask");
  });

  it("asks when tool_name is missing", async () => {
    const { out } = await run(JSON.stringify({ hook_event_name: "PreToolUse", tool_input: {} }));
    expect(decision(out)).toBe("ask");
  });

  it("always exits 0", async () => {
    expect((await run("{not json")).code).toBe(0);
    expect((await run(payload("mcp__qbo-write__delete_invoice", {}))).code).toBe(0);
  });

  it("emits the correct hookEventName", async () => {
    const { out } = await run(payload("mcp__qbo-write__delete_invoice", {}));
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });

  it("never renders NaN into the reason string", async () => {
    const { out } = await run(
      payload("mcp__qbo-write__create_invoice", {
        line_items: [
          { qty: 1e200, unit_price: 1e200 },
          { qty: -1e200, unit_price: 1e200 },
        ],
      })
    );
    expect(decision(out)).toBe("ask");
    expect(reason(out)).not.toContain("NaN");
    expect(reason(out)).not.toContain("$NaN");
  });
});

// An unrecognized `tier` from describeMutation must fail closed to "ask",
// never fall through to "allow" via a denylist-shaped else branch. Reachable
// via src/dist drift: a renamed tier, a newly added tier, or a stale build.
// These drive the hook against a stub dist/, independent of the real
// describeMutation, so every shape of a bad or malformed description can be
// produced deterministically.
describe("qbo-confirm-hook: unrecognized-tier fail-closed", () => {
  it("asks, with a non-empty reason, when the tier is absent", async () => {
    const { dir, hookPath } = makeIsolatedHookDir();
    writeStubDist(dir, `export function describeMutation() { return { summary: "no tier here" }; }\n`);
    const { out, code } = await runIsolated(hookPath, dir, payload("mcp__qbo-write__delete_invoice", {}));
    expect(decision(out)).toBe("ask");
    expect(reason(out)).not.toBe("");
    expect(code).toBe(0);
  });

  it("asks, with a non-empty reason, when the tier is an unrecognized string", async () => {
    const { dir, hookPath } = makeIsolatedHookDir();
    writeStubDist(dir, `export function describeMutation() { return { tier: "MAYBE", summary: "unknown tier" }; }\n`);
    const { out, code } = await runIsolated(hookPath, dir, payload("mcp__qbo-write__delete_invoice", {}));
    expect(decision(out)).toBe("ask");
    expect(reason(out)).not.toBe("");
    expect(code).toBe(0);
  });

  // The removed tier name itself must not silently pass the allowlist -
  // "THRESHOLD" is no longer a recognized value at all now that only AUTO
  // may allow.
  it("asks, with a non-empty reason, when a stub returns the removed THRESHOLD tier", async () => {
    const { dir, hookPath } = makeIsolatedHookDir();
    writeStubDist(dir, `export function describeMutation() { return { tier: "THRESHOLD", summary: "stale tier" }; }\n`);
    const { out, code } = await runIsolated(hookPath, dir, payload("mcp__qbo-write__create_invoice", {}));
    expect(decision(out)).toBe("ask");
    expect(reason(out)).not.toBe("");
    expect(code).toBe(0);
  });

  it("asks, with a non-empty reason, when describeMutation returns null", async () => {
    const { dir, hookPath } = makeIsolatedHookDir();
    writeStubDist(dir, `export function describeMutation() { return null; }\n`);
    const { out, code } = await runIsolated(hookPath, dir, payload("mcp__qbo-write__delete_invoice", {}));
    expect(decision(out)).toBe("ask");
    expect(reason(out)).not.toBe("");
    expect(code).toBe(0);
  });

  it("asks, with a non-empty reason, when describeMutation returns an empty object", async () => {
    // The exact shape that originally reproduced the fail-open bug: no
    // `tier`, no `summary`, nothing to fall back on but the hook's own
    // fallback text.
    const { dir, hookPath } = makeIsolatedHookDir();
    writeStubDist(dir, `export function describeMutation() { return {}; }\n`);
    const { out, code } = await runIsolated(hookPath, dir, payload("mcp__qbo-write__delete_invoice", {}));
    expect(decision(out)).toBe("ask");
    expect(reason(out)).not.toBe("");
    expect(code).toBe(0);
  });

  it("still emits a non-empty reason when a recognized AUTO tier's summary is missing", async () => {
    // A missing/empty summary must never produce a hole in the JSON contract,
    // even on the allow path where the tier itself is legitimately safe.
    const { dir, hookPath } = makeIsolatedHookDir();
    writeStubDist(dir, `export function describeMutation() { return { tier: "AUTO" }; }\n`);
    const { out, code } = await runIsolated(hookPath, dir, payload("mcp__qbo-write__create_customer", {}));
    expect(decision(out)).toBe("allow");
    expect(reason(out)).not.toBe("");
    expect(code).toBe(0);
  });

  it("throws inside describeMutation -> asks with a non-empty reason", async () => {
    const { dir, hookPath } = makeIsolatedHookDir();
    writeStubDist(dir, `export function describeMutation() { throw new Error("boom"); }\n`);
    const { out, code } = await runIsolated(hookPath, dir, payload("mcp__qbo-write__delete_invoice", {}));
    expect(decision(out)).toBe("ask");
    expect(reason(out)).toContain("boom");
    expect(code).toBe(0);
  });

  it("asks when the dist import itself fails (missing module)", async () => {
    const { dir, hookPath } = makeIsolatedHookDir();
    // No dist/ written at all: the dynamic import in the hook throws.
    const { out, code } = await runIsolated(hookPath, dir, payload("mcp__qbo-write__delete_invoice", {}));
    expect(decision(out)).toBe("ask");
    expect(reason(out)).toContain("could not load the summarizer");
    expect(code).toBe(0);
  });
});
