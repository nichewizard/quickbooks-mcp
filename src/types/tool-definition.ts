import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * The SDK's ToolCallback generic exceeds TypeScript's instantiation depth
 * when indexed (TS2589), which made three test suites fail to compile. A
 * structural signature keeps the useful typing - args.params is inferred
 * from the tool's Zod schema - without instantiating that generic.
 */
export interface ToolDefinition<T extends z.ZodType<any, any>> {
  name: string;
  description: string;
  schema: T;
  handler: (
    args: { params: z.infer<T> },
    extra?: unknown
  ) => Promise<CallToolResult> | CallToolResult;
}