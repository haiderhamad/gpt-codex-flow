import path from "node:path";

/**
 * Cross-platform invocation contract for native Codex CLI sandboxing.
 *
 * This module does NOT execute commands, attest OS sandbox isolation, or
 * change the existing Bash backend. Native Codex determines its OS backend.
 * Never fall back to host shell on missing/unsupported Codex.
 */
export type SupportedSandboxPlatform = "darwin" | "win32" | "linux";
export type SandboxedPermission = "read-only" | "workspace-write";

export interface SandboxInvocationInput {
  platform: NodeJS.Platform;
  /** Trusted local configuration, not model-provided tool arguments. */
  codexExecutable: string;
  /** Trusted canonical workspace root, not a relative caller-controlled path. */
  workspaceRoot: string;
  permission: SandboxedPermission;
  /** A program plus argv, not a string intended for a shell. */
  command: readonly string[];
}

export interface SandboxInvocation {
  executable: string;
  argv: readonly string[];
  cwd: string;
  platform: SupportedSandboxPlatform;
  permissionProfile: ":read-only" | ":workspace";
  noHostFallback: true;
  verifiedIsolation: false;
}

export function prepareSandboxInvocation(input: SandboxInvocationInput): SandboxInvocation {
  if (!["darwin", "win32", "linux"].includes(input.platform)) {
    throw new Error("Unsupported OS: sandbox execution is unavailable.");
  }
  const isAbsolute = input.platform === "win32" ? path.win32.isAbsolute : path.posix.isAbsolute;
  if (!isAbsolute(input.codexExecutable)) {
    throw new Error("Codex executable must be an absolute trusted path.");
  }
  if (!isAbsolute(input.workspaceRoot)) {
    throw new Error("Sandbox workspace must be an absolute trusted path.");
  }
  if (!["read-only", "workspace-write"].includes(input.permission)) {
    throw new Error("Only managed read-only and workspace-write sandbox profiles are allowed.");
  }
  if (!Array.isArray(input.command) || input.command.length === 0 ||
      input.command.some(arg => typeof arg !== "string" || !arg.length || arg.includes("\u0000"))) {
    throw new Error("Sandbox command must contain nonempty argv entries without NUL.");
  }

  const permissionProfile = input.permission === "read-only" ? ":read-only" : ":workspace";
  const platform = input.platform as SupportedSandboxPlatform;
  return Object.freeze({
    executable: input.codexExecutable,
    // Current Codex uses one platform-autodetected sandbox subcommand;
    // explicit built-in permission profile avoids ambient danger-full-access settings.
    argv: Object.freeze(["sandbox", "--permission-profile", permissionProfile, "--cd", input.workspaceRoot, "--", ...input.command]),
    cwd: input.workspaceRoot,
    platform,
    permissionProfile,
    noHostFallback: true as const,
    verifiedIsolation: false as const
  });
}
