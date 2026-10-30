import fsp from "node:fs/promises";
import type { GcfConfig } from "./config.js";
import { GcfError, PathGuard, type Workspace } from "./guard.js";

export interface ParallelRoleStatus {
  state: "assigned" | "reported";
  task: string;
  target_paths: string[];
  evidence_submitted: boolean;
}
export interface ParallelStatus {
  active: boolean;
  session_id?: string;
  status?: string;
  base_head?: string;
  goal?: string;
  roles?: { chatgpt: ParallelRoleStatus; codex: ParallelRoleStatus };
  preview?: { status: "PASS" | "BLOCKED"; paths: string[]; sha256: string | null };
  advisory_only: true;
  client_identity_verified: false;
  execution_started_by_tool: false;
  merged_into_original: false;
}

const states = new Set(["planned", "in_progress", "ready_to_preview", "blocked", "preview_verified", "interrupted"]);
function isRelativeFile(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length < 250 &&
    !value.startsWith("/") && !value.includes("\\") &&
    value.split("/").every((s) => s.length > 0 && s !== "." && s !== ".." && s !== ".git");
}
function safeRole(value: any): ParallelRoleStatus {
  if (!value || typeof value !== "object" ||
      !["assigned", "reported"].includes(value.state) ||
      typeof value.task !== "string" || value.task.length > 1500 ||
      !Array.isArray(value.target_paths) || value.target_paths.length > 30 ||
      !value.target_paths.every(isRelativeFile)) {
    throw new GcfError("Invalid parallel role state.");
  }
  return {
    state: value.state,
    task: value.task,
    target_paths: value.target_paths,
    evidence_submitted: value.state === "reported" && typeof value.evidence === "string" && value.evidence.length > 0
  };
}
export async function readParallelSessionStatus(
  config: GcfConfig,
  guard: PathGuard,
  workspace: Workspace
): Promise<ParallelStatus> {
  const defaults = {
    advisory_only: true as const,
    client_identity_verified: false as const,
    execution_started_by_tool: false as const,
    merged_into_original: false as const
  };
  const file = guard.resolve(workspace, `${config.contextDir}/parallel-session.json`).absPath;
  let raw: string;
  try {
    const handle = await fsp.open(file, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 32_000) throw new GcfError("Parallel session state is not a bounded regular file.");
      raw = await handle.readFile({ encoding: "utf8" });
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { active: false, ...defaults };
    throw error;
  }
  let state: any;
  try { state = JSON.parse(raw); } catch { throw new GcfError("Invalid parallel session JSON."); }
  if (state?.schema !== 1 || typeof state.session_id !== "string" ||
      !/^parallel_[a-f0-9-]{36}$/.test(state.session_id) ||
      typeof state.base_head !== "string" || !/^[a-f0-9]{40,64}$/.test(state.base_head) ||
      typeof state.goal !== "string" || state.goal.length > 1500 ||
      !states.has(state.status) || typeof state.base !== "string" ||
      state.base !== workspace.root) {
    throw new GcfError("Parallel state does not belong to this workspace or is invalid.");
  }
  const roles = {
    chatgpt: safeRole(state.roles?.chatgpt),
    codex: safeRole(state.roles?.codex)
  };
  let preview: ParallelStatus["preview"];
  if (state.preview !== undefined) {
    if (state.preview === null || !["PASS", "BLOCKED"].includes(state.preview.status) ||
        !Array.isArray(state.preview.paths) || state.preview.paths.length > 60 ||
        !state.preview.paths.every(isRelativeFile) ||
        (state.preview.sha256 !== null && !/^[a-f0-9]{64}$/.test(state.preview.sha256))) {
      throw new GcfError("Invalid parallel preview record.");
    }
    preview = {
      status: state.preview.status,
      paths: state.preview.paths,
      sha256: state.preview.sha256
    };
  }
  return {
    active: true, session_id: state.session_id, status: state.status,
    base_head: state.base_head, goal: state.goal, roles,
    ...(preview ? { preview } : {}),
    ...defaults
  };
}
