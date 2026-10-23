/**
 * Audit inventory of MCP tool effects. This module is NOT an authorization gate.
 *
 * Proposed grants describe eventual server-side policy checks; do not use the
 * presence of an entry as evidence that the current caller is authorized.
 */
export type PermissionGrant =
  | "workspace:read"
  | "workspace:write"
  | "handoff:write"
  | "execution:run"
  | "server:admin";

export type ToolEffect =
  | "read"
  | "session-state"
  | "path-dependent-write"
  | "handoff-state-write"
  | "execution"
  | "diagnostic-mixed";

export interface ToolPermissionEntry {
  effect: ToolEffect;
  proposedGrants: readonly PermissionGrant[];
  reviewNote?: string;
}

const readOnly = [
  "server_config", "codexbridge_inventory", "search_skills",
  "search_agent_profiles", "load_agent_profile", "recommend_orchestrator",
  "parallel_session_status", "shared_project_state",
  "transfer_status", "task_inbox_list", "task_inbox_read", "load_skill", "list_skill_resources", "read_skill_resource", "list_workspaces", "list_projects", "find_project", "project_summary", "workspace_snapshot",
  "tree", "search", "read", "preview_change_set",
  "preview_rollback_change_set", "approval_review", "task_brief",
  "task_resume", "ssh_profiles", "git_status", "git_diff",
  "show_changes", "operation_journal", "read_handoff", "codex_context",
  "codex_sessions", "read_codex_session"
] as const;

const sessionState = ["open_workspace", "open_current_workspace", "select_project"] as const;
const pathWrites = ["write", "edit", "apply_change_set"] as const;
const handoffWrites = [
  "set_project_alias", "recover_project_alias",
  "request_transfer", "accept_transfer", "cancel_transfer", "task_inbox_post",
  "task_plan", "task_report", "export_pro_context",
  "handoff_to_agent", "handoff_to_codex"
] as const;
const executions = ["task_verify", "bash", "ssh_exec"] as const;

function entries(
  names: readonly string[],
  entry: ToolPermissionEntry
): Array<[string, ToolPermissionEntry]> {
  return names.map((name) => [name, Object.freeze({ ...entry, proposedGrants: Object.freeze([...entry.proposedGrants]) })]);
}

const catalogEntries: Array<[string, ToolPermissionEntry]> = [
  ...entries(readOnly, { effect: "read", proposedGrants: ["workspace:read"] }),
  ...entries(sessionState, {
    effect: "session-state",
    proposedGrants: ["workspace:read"],
    reviewNote: "Opens or changes the session workspace, but does not claim filesystem write access."
  }),
  ...entries(pathWrites, {
    effect: "path-dependent-write",
    proposedGrants: ["workspace:write", "handoff:write"],
    reviewNote: "Alternative grants, NOT both required: source paths need workspace:write; approved context paths may use handoff:write. Recheck each resolved path at the backend mutation boundary."
  }),
  ...entries(handoffWrites, {
    effect: "handoff-state-write",
    proposedGrants: ["handoff:write"],
    reviewNote: "Creates or updates task, journal, or transfer state; user-supplied approval flags are not independently verified."
  }),
  ...entries(executions, {
    effect: "execution",
    proposedGrants: ["execution:run"],
    reviewNote: "Executing even an allowlisted command can have side effects; execution policies are not an OS sandbox."
  }),
  ["codexbridge_self_test", Object.freeze({
    effect: "diagnostic-mixed",
    proposedGrants: Object.freeze(["workspace:read", "handoff:write", "execution:run"] as const),
    reviewNote: "Can write/edit a context probe and execute Bash checks, depending on options and runtime policy. Requires operation-level inspection."
  })]
];

if (new Set(catalogEntries.map(([name]) => name)).size !== catalogEntries.length) {
  throw new Error("Duplicate MCP tool in permission audit catalog.");
}

/** Proposed permission metadata only; enforcement is a separate milestone. */
export const TOOL_PERMISSION_CATALOG: Readonly<Record<string, ToolPermissionEntry>> =
  Object.freeze(Object.fromEntries(catalogEntries));

export function permissionEntryForTool(name: string): ToolPermissionEntry {
  if (!Object.hasOwn(TOOL_PERMISSION_CATALOG, name)) {
    throw new Error(`Unclassified MCP tool: ${name}`);
  }
  return TOOL_PERMISSION_CATALOG[name];
}
