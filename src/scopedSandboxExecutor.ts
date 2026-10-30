import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareSandboxInvocation } from "./sandboxInvocation.js";

/**
 * Opt-in native Codex sandbox runner, intentionally NOT connected to MCP/Bash.
 * Restricted to macOS until native negative tests pass on other platforms.
 * No host-shell fallback: any setup/launch failure aborts the operation.
 */
export interface ScopedExecutionRequest {
  /** A locally trusted, absolute Codex CLI path (not a model-supplied argument). */
  codexExecutable: string;
  /** A locally approved workspace directory (not a model-supplied argument). */
  workspaceRoot: string;
  /** Program and arguments; no shell interpolation or command-line parsing. */
  command: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Trusted owner revocation signal; abort terminates the sandbox process group. */
  abortSignal?: AbortSignal;
}

export interface ScopedExecutionResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

const PROFILE_NAME = "cb-scoped";
const PROFILE_TOML = [
  "[permissions.cb-scoped]",
  'extends = ":workspace"',
  "[permissions.cb-scoped.filesystem]",
  '":root" = "deny"',
  '":minimal" = "read"',
  '":tmpdir" = "deny"',
  '":slash_tmp" = "deny"',
  "[permissions.cb-scoped.network]",
  "enabled = false",
  ""
].join("\n");

function safeEnv(codexHome: string): NodeJS.ProcessEnv {
  // Never inherit server HTTP tokens, Node options, SSH agents, API keys, etc.
  return {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: os.homedir(),
    CODEX_HOME: codexHome,
    LANG: "C",
    LC_ALL: "C",
    TERM: "dumb",
    NO_COLOR: "1"
  };
}

function canonicalDirectory(input: string): string {
  if (!path.isAbsolute(input)) throw new Error("Workspace root must be absolute.");
  const real = fs.realpathSync(input);
  if (!fs.statSync(real).isDirectory()) throw new Error("Workspace root is not a directory.");
  if (real === path.parse(real).root) throw new Error("Filesystem root cannot be a scoped workspace.");
  return real;
}

function trustedExecutable(input: string): string {
  if (!path.isAbsolute(input)) throw new Error("Codex CLI path must be absolute.");
  const real = fs.realpathSync(input);
  if (!fs.statSync(real).isFile()) throw new Error("Codex CLI must be a file.");
  return real;
}

function collectOutput(limit: number) {
  const chunks: Buffer[] = [];
  let count = 0;
  let truncated = false;
  return {
    append(chunk: Buffer | string) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const room = Math.max(0, limit - count);
      if (data.length > room) truncated = true;
      if (room > 0) {
        chunks.push(data.subarray(0, room));
        count += Math.min(room, data.length);
      }
    },
    get value() { return Buffer.concat(chunks).toString("utf8"); },
    get truncated() { return truncated; }
  };
}

/**
 * Security boundaries covered by existing macOS negative tests only.
 * Caller MUST still enforce user approval, path grants and operation policy.
 * Process-group signals cover descendants that remain in the same group, but
 * detached descendants and other OS escape routes are not fully verified.
 */
export async function executeScopedSandbox(request: ScopedExecutionRequest): Promise<ScopedExecutionResult> {
  if (request.abortSignal?.aborted) {
    throw new Error("Scoped execution revoked before launch.");
  }
  if (process.platform !== "darwin") {
    throw new Error("Scoped native sandbox is unverified on this OS; execution refused.");
  }
  const codexExecutable = trustedExecutable(request.codexExecutable);
  const workspaceRoot = canonicalDirectory(request.workspaceRoot);
  if (!Array.isArray(request.command) || !request.command.length ||
      request.command.some(x => typeof x !== "string" || !x.length || x.includes("\0"))) {
    throw new Error("Structured command argv is required.");
  }
  const timeoutMs = request.timeoutMs ?? 30_000;
  const maxOutputBytes = request.maxOutputBytes ?? 32_768;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new Error("Timeout must be 1,000–120,000 ms.");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 131_072) {
    throw new Error("Output cap must be 1,024–131,072 bytes.");
  }
  const base = await mkdtemp(path.join(os.homedir(), "gcf-scoped-exec-"));
  const codexHome = path.join(base, "codex-home");
  const start = Date.now();
  try {
    await mkdir(codexHome, { mode: 0o700 });
    await writeFile(path.join(codexHome, "config.toml"), PROFILE_TOML, { mode: 0o600, flag: "wx" });

    const plan = prepareSandboxInvocation({
      platform: process.platform,
      codexExecutable,
      workspaceRoot,
      permission: "workspace-write",
      command: request.command
    });
    const argv = [...plan.argv];
    const profileIndex = argv.indexOf("--permission-profile");
    if (profileIndex < 0 || argv[profileIndex + 1] !== ":workspace") {
      throw new Error("Unexpected Codex sandbox invocation layout; execution refused.");
    }
    argv[profileIndex + 1] = PROFILE_NAME;
    if (request.abortSignal?.aborted) {
      throw new Error("Scoped execution revoked before spawn.");
    }

    return await new Promise<ScopedExecutionResult>((resolve, reject) => {
      const stdout = collectOutput(maxOutputBytes);
      const stderr = collectOutput(maxOutputBytes);
      const child = spawn(plan.executable, argv, {
        cwd: workspaceRoot,
        env: safeEnv(codexHome),
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      const killGroup = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      };
      const onAbort = () => {
        cancelled = true;
        killGroup();
      };
      request.abortSignal?.addEventListener("abort", onAbort, { once: true });
      // Covers a revocation between the last pre-spawn check and the listener.
      if (request.abortSignal?.aborted) onAbort();
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        request.abortSignal?.removeEventListener("abort", onAbort);
      };
      child.stdout.on("data", x => stdout.append(x));
      child.stderr.on("data", x => stderr.append(x));
      child.once("error", err => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          exitCode,
          signal,
          timedOut,
          cancelled,
          durationMs: Date.now() - start,
          stdout: stdout.value,
          stderr: stderr.value,
          truncated: stdout.truncated || stderr.truncated
        });
      });
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
