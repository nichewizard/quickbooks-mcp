import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";
import { sanitizeQboText, formatFindingsBanner } from "./sanitize-qbo-text.js";

/**
 * Defines CRUD categories for tools
 */
export const CRUD_CATEGORY = {
  WRITE:  "WRITE",
  UPDATE: "UPDATE",
  DELETE: "DELETE",
  READ:   "READ",
} as const;

export type CrudCategory = typeof CRUD_CATEGORY[keyof typeof CRUD_CATEGORY];

/** 
 * Maps each CRUD category to its corresponding environment variable for disabling tools.
 */
export const DISABLE_ENV = {
  [CRUD_CATEGORY.WRITE]:  "QUICKBOOKS_DISABLE_WRITE",
  [CRUD_CATEGORY.UPDATE]: "QUICKBOOKS_DISABLE_UPDATE",
  [CRUD_CATEGORY.DELETE]: "QUICKBOOKS_DISABLE_DELETE",
} as const;

/** 
 * Maps every non-READ verb prefix to its category. Handles both underscore
 * and legacy hyphen separator variants (e.g. create-bill, update-vendor).
 * Insertion order is preserved in V8; all prefixes are distinct so order
 * does not affect correctness.
 */
export const PREFIX_CATEGORY_MAP: Record<string, CrudCategory> = {
  "create_": CRUD_CATEGORY.WRITE,
  "create-": CRUD_CATEGORY.WRITE,
  "update_": CRUD_CATEGORY.UPDATE,
  "update-": CRUD_CATEGORY.UPDATE,
  "delete_": CRUD_CATEGORY.DELETE,
  "delete-": CRUD_CATEGORY.DELETE,
};

/** 
 * Determines the CRUD category of a tool based on its name prefix.
 * Defaults to READ if no prefix matches.
 */
export function getCrudCategory(toolName: string): CrudCategory {
  for (const [prefix, category] of Object.entries(PREFIX_CATEGORY_MAP)) {
    if (toolName.startsWith(prefix)) return category;
  }
  return CRUD_CATEGORY.READ;
}

/** 
 * Checks if a tool is disabled based on its CRUD category and corresponding environment variable.
 * READ tools are never disabled.
 */
export function isToolDisabled(toolName: string): boolean {
  const category = getCrudCategory(toolName);
  if (category === CRUD_CATEGORY.READ) return false;
  return process.env[DISABLE_ENV[category]] === "true";
}

// A read-only tool (get_invoice_pdf without output_path) can return a raw
// base64-encoded file as a text part. That is not JSON, so it falls into the
// prose branch below - and a multi-KB base64 blob reliably trips both the
// `obfuscation` base64-run rule and the `anomalous-length` rule in
// sanitizeQboText, producing a false-positive INJECTION SUSPECTED banner on
// every routine PDF read. A banner that fires on every routine read teaches
// the operator to ignore it, defeating the point of having one. Detection
// itself is not weakened (sanitize-qbo-text.ts is untouched); the prose
// branch simply recognizes a pure base64 payload and skips detection for it.
// No \r\n in the class: Node's Buffer#toString("base64") never emits line
// breaks, so every real base64 payload this guard needs to match is a single
// unbroken run. Allowing \r\n here would let a newline-separated plaintext
// payload with no spaces slip through as a false "base64" match, skipping
// detection on hostile prose that needs no decoding to act on.
//
// The character class alone is still not enough: a space-free CamelCase
// instruction (a known technique for slipping past whitespace-anchored
// filters) is also a run of [A-Za-z0-9+/] characters, so it matches too -
// and unlike an actual base64-encoded file, it needs no decoding for a model
// to act on it. "Require the decoded bytes to look like binary" does not
// close this: a CamelCase instruction decodes to pseudorandom-looking bytes
// that pass a printable-ratio check just as well as a real file does.
const BASE64_BLOB_MIN_LENGTH = 200;
const BASE64_BLOB_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// The magic bytes every PDF begins with (PDF spec 7.5.2, §"File Header").
const PDF_MAGIC = "%PDF-";

function looksLikeBase64Blob(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length <= BASE64_BLOB_MIN_LENGTH || !BASE64_BLOB_RE.test(trimmed)) {
    return false;
  }
  // The only caller that emits a raw base64 text part is get_invoice_pdf, and
  // every PDF starts with the %PDF- header. Checking the decoded magic keeps
  // the false-positive fix while refusing to skip detection for anything that
  // merely LOOKS base64-shaped, per the CamelCase case above.
  const decoded = Buffer.from(trimmed, "base64");
  return (
    decoded.length >= PDF_MAGIC.length &&
    decoded.subarray(0, PDF_MAGIC.length).toString("latin1") === PDF_MAGIC
  );
}

/**
 * Wraps a READ handler so untrusted QuickBooks text is delimited and flagged.
 *
 * Fails OPEN deliberately: if sanitizing throws, the original content is
 * returned with a warning. Reads do not mutate anything, and silently
 * blocking a report would be worse than the risk being mitigated.
 */
export function withSanitizer<H>(handler: H): H {
  const wrapped = async (...args: unknown[]) => {
    const result = (await (handler as unknown as (...a: unknown[]) => Promise<unknown>)(
      ...args
    )) as { content?: unknown } | null | undefined;

    // Captured before the try so the catch branch can reuse it without a
    // second property access that could throw again. Optional chaining here
    // (rather than `result.content`) keeps a handler that resolves null or
    // undefined on the fail-open path instead of throwing a TypeError, which
    // would fail CLOSED and contradict the point of this branch.
    const original = Array.isArray(result?.content)
      ? (result?.content as Array<Record<string, unknown>>)
      : null;
    if (original === null) return result;

    try {
      const banners: string[] = [];
      const content = original.map((part) => {
        if (part.type !== "text" || typeof part.text !== "string") return part;
        let parsed: unknown;
        let parsedOk = true;
        try {
          parsed = JSON.parse(part.text);
        } catch {
          parsedOk = false;
        }
        if (!parsedOk) {
          if (looksLikeBase64Blob(part.text)) return part;
          // Prose, not JSON: flag it but do not wrap, so the text stays
          // readable. sanitizeQboText is called with a KEYED object
          // (`{ text: ... }`), not the bare string, matching the success
          // path's convention - see the "withSanitizer non-JSON prose
          // contract" test for what that keying is observable as here.
          const { findings } = sanitizeQboText({ text: part.text });
          banners.push(formatFindingsBanner(findings));
          return part;
        }
        const { value, findings } = sanitizeQboText(parsed);
        banners.push(formatFindingsBanner(findings));
        return { ...part, text: JSON.stringify(value, null, 2) };
      });
      const banner = banners.filter((b) => b !== "").join("\n");
      if (banner === "") return { ...result, content };
      return { ...result, content: [{ type: "text" as const, text: banner }, ...content] };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return {
        ...result,
        content: [
          { type: "text" as const, text: `WARNING: sanitizer error, content not vetted: ${reason}` },
          ...original,
        ],
      };
    }
  };
  return wrapped as unknown as H;
}

/**
 * Registers a tool with the MCP server if it is not disabled.
 * Tools are categorized by their name prefix (e.g. create_, update_, delete_).
 * The corresponding environment variable (e.g. QUICKBOOKS_DISABLE_WRITE) determines if the tool is registered.
 */
export function RegisterTool<T extends z.ZodType<any, any>>(
  server: McpServer,
  toolDefinition: ToolDefinition<T>
) {
  if (isToolDisabled(toolDefinition.name)) return;

  const handler =
    getCrudCategory(toolDefinition.name) === CRUD_CATEGORY.READ
      ? withSanitizer(toolDefinition.handler)
      : toolDefinition.handler;

  // server.tool's generic overloads exceed TypeScript's instantiation depth
  // under tsconfig.test.json (TS2589), so call through a structural type.
  // Runtime behaviour is identical; only overload resolution is skipped.
  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool(
    toolDefinition.name,
    toolDefinition.description,
    { params: toolDefinition.schema },
    handler
  );
}