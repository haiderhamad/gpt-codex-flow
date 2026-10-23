import { permissionEntryForTool } from "./permissionCatalog.js";

/**
 * Opt-in, credential-scoped read-only HTTP access.
 *
 * A bearer secret identifies a credential, NOT a cryptographically proven app
 * (ChatGPT/Codex) identity. This is intentionally separate from OAuth.
 */
const READONLY_TOOL_NAMES = Object.freeze([
  "server_config",
  "codexbridge_inventory",
  "workspace_snapshot",
  "tree",
  "search",
  "read",
  "git_status",
  "git_diff",
  "show_changes",
  "read_handoff",
  "transfer_status",
  "operation_journal"
]);

const allowedReadOnlyTools = new Set<string>(READONLY_TOOL_NAMES);
for (const name of READONLY_TOOL_NAMES) {
  if (permissionEntryForTool(name).effect !== "read") {
    throw new Error(`Read-only credential has an unsafe MCP tool: ${name}`);
  }
}

export type HttpCredentialKind = "primary" | "readonly";

export function validateReadOnlyHttpToken(
  primaryToken: string | undefined,
  readOnlyToken: string | undefined
): string | undefined {
  if (readOnlyToken === undefined) return undefined;
  if (!primaryToken) {
    throw new Error("CODEXBRIDGE_HTTP_READONLY_TOKEN requires CODEXBRIDGE_HTTP_TOKEN.");
  }
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(readOnlyToken)) {
    throw new Error("CODEXBRIDGE_HTTP_READONLY_TOKEN must be a random 32-256 character URL-safe secret.");
  }
  if (readOnlyToken === primaryToken) {
    throw new Error("Read-only HTTP token must differ from the primary HTTP token.");
  }
  return readOnlyToken;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Called only after HTTP bearer authentication.
 * Reject unknown methods and JSON-RPC batches rather than guessing effects.
 */
export function isReadOnlyMcpPostAllowed(body: unknown): boolean {
  if (!isObject(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return false;
  }

  if (body.method === "initialize" || body.method === "notifications/initialized" ||
      body.method === "ping" || body.method === "tools/list") {
    return true;
  }

  if (body.method !== "tools/call" || !isObject(body.params)) return false;
  const name = body.params.name;
  return typeof name === "string" && allowedReadOnlyTools.has(name);
}
