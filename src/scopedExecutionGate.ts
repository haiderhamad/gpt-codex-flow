import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  executeScopedSandbox,
  type ScopedExecutionRequest,
  type ScopedExecutionResult
} from "./scopedSandboxExecutor.js";

/**
 * Experimental in-process policy boundary. NOT wired to any MCP, HTTP, or UI
 * endpoint. Only a future trusted LOCAL owner control may call activate/approve.
 *
 * The string principal below is an identifier, NOT authentication evidence.
 * Live integration must bind it to an authenticated credential and enforce
 * approval separately from MCP/model-controlled parameters.
 */
export interface ScopedLocalGrant {
  principalId: string;
  workspaceRoot: string;
  expiresAtMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
}

export interface ScopedCommandRequest {
  principalId: string;
  workspaceRoot: string;
  codexExecutable: string;
  command: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  approvalId: string;
}

export type ScopedExecutor = (request: ScopedExecutionRequest) => Promise<ScopedExecutionResult>;

interface StoredApproval {
  id: string;
  grantRevision: number;
  canonicalRoot: string;
  command: readonly string[];
  expiresAtMs: number;
}

interface StoredGrant extends ScopedLocalGrant {
  canonicalRoot: string;
  revision: number;
}

/**
 * Scope and operation-bound, single-use grants. Construct this class only
 * in trusted owner-controlled code, NEVER from arbitrary MCP/LLM tool input.
 *
 * Revocation currently blocks subsequent launches, NOT in-flight commands.
 * Do not expose this gate as secure Full Access until active cancellation,
 * verified identity, and trusted approval UI are wired and tested.
 */
export class ScopedExecutionGate {
  private grant: StoredGrant | null = null;
  private approvals = new Map<string, StoredApproval>();
  private revision = 0;
  private activeController: AbortController | null = null;
  constructor(
    private readonly executor: ScopedExecutor = executeScopedSandbox,
    private readonly now: () => number = Date.now
  ) {}

  private root(realPath: string): string {
    if (typeof realPath !== "string" || !path.isAbsolute(realPath)) {
      throw new Error("Scoped workspace must be an absolute path.");
    }
    const real = fs.realpathSync(realPath);
    if (!fs.statSync(real).isDirectory() || real === path.parse(real).root) {
      throw new Error("Scoped workspace must be an existing non-root directory.");
    }
    return real;
  }

  /** Invoked by a future trusted local admin control only. */
  activateFromTrustedLocalControl(input: ScopedLocalGrant): void {
    const current = this.now();
    if (!input.principalId?.trim()) throw new Error("Verified principal identifier is required.");
    if (!Number.isSafeInteger(input.expiresAtMs) ||
        input.expiresAtMs <= current ||
        input.expiresAtMs - current > 120 * 60_000) {
      throw new Error("Grant must expire in 1–120 minutes.");
    }
    if (!Number.isSafeInteger(input.maxTimeoutMs) || input.maxTimeoutMs < 1_000 ||
        input.maxTimeoutMs > 120_000) {
      throw new Error("Invalid per-command timeout limit.");
    }
    if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1024 ||
        input.maxOutputBytes > 131_072) {
      throw new Error("Invalid output-size limit.");
    }
    if (this.activeController) throw new Error("Cannot replace grant during active execution; revoke first.");
    const canonicalRoot = this.root(input.workspaceRoot);
    this.revision += 1;
    this.approvals.clear();
    this.grant = Object.freeze({ ...input, canonicalRoot, revision: this.revision });
  }

  /**
   * Requires a separate trusted human operation approval. Returns an opaque
   * single-use ID for an exact argv and workspace, not a self-declared bool.
   */
  approveFromTrustedLocalControl(input: {
    principalId: string;
    workspaceRoot: string;
    command: readonly string[];
    approvalTtlMs?: number;
  }): string {
    const grant = this.activeGrant(input.principalId, input.workspaceRoot);
    this.assertCommand(input.command);
    const ttl = input.approvalTtlMs ?? 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 60_000) {
      throw new Error("Approval TTL must be 1–60 seconds.");
    }
    const expiresAtMs = Math.min(this.now() + ttl, grant.expiresAtMs);
    const id = randomUUID();
    this.approvals.set(id, Object.freeze({
      id,
      grantRevision: grant.revision,
      canonicalRoot: grant.canonicalRoot,
      command: Object.freeze([...input.command]),
      expiresAtMs
    }));
    return id;
  }

  /** Block new commands and request cancellation of the active process group. */
  revoke(): void {
    this.activeController?.abort();
    this.revision += 1;
    this.grant = null;
    this.approvals.clear();
  }

  /**
   * The only method that can reach the executor. Approval is consumed before
   * awaiting execution (single-threaded atomic check/consume in this process).
   */
  async executeApproved(input: ScopedCommandRequest): Promise<ScopedExecutionResult> {
    const grant = this.activeGrant(input.principalId, input.workspaceRoot);
    this.assertCommand(input.command);
    const approval = this.approvals.get(input.approvalId);
    if (!approval || approval.grantRevision !== grant.revision ||
        approval.canonicalRoot !== grant.canonicalRoot ||
        approval.expiresAtMs <= this.now() ||
        approval.command.length !== input.command.length ||
        approval.command.some((arg, i) => arg !== input.command[i])) {
      throw new Error("Missing, expired, reused or mismatched operation approval.");
    }
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1_000 ||
        input.timeoutMs > grant.maxTimeoutMs) {
      throw new Error("Command timeout exceeds active grant.");
    }
    if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1024 ||
        input.maxOutputBytes > grant.maxOutputBytes) {
      throw new Error("Output limit exceeds active grant.");
    }
    const remainingMs = Math.floor(grant.expiresAtMs - this.now());
    if (remainingMs < 1_000 || input.timeoutMs > remainingMs) {
      throw new Error("Insufficient grant lifetime for the requested command.");
    }
    if (this.activeController) throw new Error("Another scoped command is already running.");
    // The first successful authorization consumes the capability even if spawn fails.
    this.approvals.delete(approval.id);
    const controller = new AbortController();
    this.activeController = controller;
    try {
      return await this.executor({
        codexExecutable: input.codexExecutable,
        workspaceRoot: grant.canonicalRoot,
        command: [...input.command],
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        abortSignal: controller.signal
      });
    } finally {
      if (this.activeController === controller) this.activeController = null;
    }
  }

  private activeGrant(principalId: string, workspaceRoot: string): StoredGrant {
    const g = this.grant;
    if (!g || !principalId?.trim() || g.principalId !== principalId ||
        g.expiresAtMs <= this.now()) {
      throw new Error("No active local scoped execution grant for this principal.");
    }
    if (this.root(workspaceRoot) !== g.canonicalRoot) {
      throw new Error("Requested workspace does not match active local grant.");
    }
    return g;
  }

  private assertCommand(command: readonly string[]): void {
    if (!Array.isArray(command) || command.length === 0 ||
        command.some(arg => typeof arg !== "string" || !arg.length || arg.includes("\0"))) {
      throw new Error("Exact nonempty argv is required for operation approval.");
    }
  }
}
