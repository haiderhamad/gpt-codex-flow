import type { WriteMode } from "./config.js";
import { permissionEntryForTool, type PermissionGrant } from "./permissionCatalog.js";

/**
 * Pure authorization policy prototype, NOT attached to the MCP/HTTP runtime.
 *
 * SECURITY BOUNDARY:
 * - A trusted authentication verifier must produce the principal below.
 * - Path scopes must come from PathGuard after filesystem resolution.
 * - A backend-verified, atomic lease must supply the lease snapshot.
 * - Never construct these values from model-supplied MCP arguments.
 *
 * This function cannot establish any of those facts by itself. It returns a
 * hypothetical result for test fixtures and architecture planning only.
 */
export interface PrincipalEvidence {
  principalId: string;
  grants: readonly PermissionGrant[];
}

export type MutationPathScope = "source" | "handoff";

export interface LeaseEvidence {
  ownerPrincipalId: string;
  workspaceId: string;
  taskId: string;
  revision: number;
  expiresAtMs: number;
  transferPending: boolean;
}

export interface AuthorizationSimulationInput {
  toolName: string;
  principal: PrincipalEvidence | null;
  writeMode: WriteMode;
  /** Derived from a trusted PathGuard, one entry for each mutated file. */
  mutationScopes?: readonly MutationPathScope[];
  /** All fields from trusted server-side task state, not MCP arguments. */
  workspaceId?: string;
  taskId?: string;
  expectedLeaseRevision?: number;
  lease?: LeaseEvidence | null;
  nowMs?: number;
}

export interface AuthorizationSimulationResult {
  wouldAllow: boolean;
  code:
    | "allow"
    | "unknown-tool"
    | "unverified-principal"
    | "missing-grant"
    | "missing-resolved-paths"
    | "write-mode-denied"
    | "missing-lease"
    | "lease-mismatch"
    | "lease-expired"
    | "transfer-pending"
    | "approval-not-implemented"
    | "execution-unconfined"
    | "mixed-diagnostic-unconfined";
  requiredGrants: readonly PermissionGrant[];
  rationale: string;
}

function result(
  wouldAllow: boolean,
  code: AuthorizationSimulationResult["code"],
  requiredGrants: readonly PermissionGrant[],
  rationale: string
): AuthorizationSimulationResult {
  return { wouldAllow, code, requiredGrants: [...new Set(requiredGrants)], rationale };
}

export function simulateAuthorization(input: AuthorizationSimulationInput): AuthorizationSimulationResult {
  let entry;
  try {
    entry = permissionEntryForTool(input.toolName);
  } catch {
    return result(false, "unknown-tool", [], "Unknown MCP operations must fail closed.");
  }

  if (!input.principal || !input.principal.principalId.trim()) {
    return result(false, "unverified-principal", [], "Strict authorization needs a server-verified principal.");
  }
  const principal = input.principal;

  if (entry.effect === "diagnostic-mixed") {
    return result(false, "mixed-diagnostic-unconfined", entry.proposedGrants,
      "Self-tests mix writes and execution. Split operations and verify each effect before granting access.");
  }

  if (entry.effect === "execution") {
    return result(false, "execution-unconfined", ["execution:run"],
      "Strict single-writer mode must not permit unrestricted Bash/SSH execution without separate confinement.");
  }

  if (["request_transfer", "accept_transfer", "cancel_transfer"].includes(input.toolName)) {
    return result(false, "approval-not-implemented", ["handoff:write"],
      "Advisory transfer parameters do not prove identity or operation-bound human approval.");
  }

  let requiredGrants: PermissionGrant[];
  if (entry.effect === "path-dependent-write") {
    const scopes = input.mutationScopes;
    if (!scopes?.length || scopes.some(scope => scope !== "source" && scope !== "handoff")) {
      return result(false, "missing-resolved-paths", entry.proposedGrants,
        "Every target path must be resolved and classified by the server.");
    }
    if (input.writeMode === "off" ||
        (input.writeMode === "handoff" && scopes.includes("source"))) {
      return result(false, "write-mode-denied", entry.proposedGrants,
        "Existing writeMode restriction applies independently of principal grants.");
    }
    requiredGrants = [];
    if (scopes.includes("handoff")) requiredGrants.push("handoff:write");
    if (scopes.includes("source")) requiredGrants.push("workspace:write");
  } else if (entry.effect === "handoff-state-write") {
    requiredGrants = ["handoff:write"];
  } else if (entry.effect === "read" || entry.effect === "session-state") {
    requiredGrants = ["workspace:read"];
  } else {
    return result(false, "unknown-tool", [], "Unhandled tool effect must fail closed.");
  }

  const granted = new Set(principal.grants);
  if (requiredGrants.some(grant => !granted.has(grant))) {
    return result(false, "missing-grant", requiredGrants,
      "Authenticated principal is missing at least one required scoped grant.");
  }

  if (entry.effect === "path-dependent-write" && input.mutationScopes?.includes("source")) {
    const lease = input.lease;
    if (!lease || !input.workspaceId || !input.taskId ||
        input.expectedLeaseRevision === undefined) {
      return result(false, "missing-lease", requiredGrants,
        "A source write requires a server-verified active task and lease revision.");
    }
    if (lease.ownerPrincipalId !== principal.principalId ||
        lease.workspaceId !== input.workspaceId ||
        lease.taskId !== input.taskId ||
        lease.revision !== input.expectedLeaseRevision) {
      return result(false, "lease-mismatch", requiredGrants,
        "The verified lease owner, workspace, task, and revision must all match.");
    }
    if (!Number.isFinite(lease.expiresAtMs) || lease.expiresAtMs <= (input.nowMs ?? Date.now())) {
      return result(false, "lease-expired", requiredGrants, "The writer lease has expired.");
    }
    if (lease.transferPending !== false) {
      return result(false, "transfer-pending", requiredGrants,
        "Source writes are frozen during a pending handoff.");
    }
  }

  return result(true, "allow", requiredGrants,
    "The simulated preconditions passed. The production backend must still validate identity, paths, grants, and lease atomically.");
}
