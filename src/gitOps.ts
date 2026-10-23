import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CodexBridgeConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexBridgeError, PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

function gitEnvironment(workspace: Workspace): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", GIT_CEILING_DIRECTORIES: path.dirname(workspace.root) };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  return env;
}

/** Git commands must never discover a repository above the approved root. */
export function hasGitWorkingTree(workspace: Workspace): boolean {
  try {
    const marker = fs.lstatSync(path.join(workspace.root, ".git"));
    if (!marker.isDirectory() && !marker.isFile()) return false;
    const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspace.root,
      encoding: "utf8",
      maxBuffer: 8_192,
      env: gitEnvironment(workspace)
    });
    return probe.status === 0 && fs.realpathSync(probe.stdout.trim()) === workspace.root;
  } catch {
    return false;
  }
}

function runGit(workspace: Workspace, args: string[], maxOutputBytes: number): string {
  if (!hasGitWorkingTree(workspace)) {
    return "Git features require a Git repository in this folder. Files and workspace tools remain available.";
  }
  const result = spawnSync("git", args, {
    cwd: workspace.root,
    encoding: "utf8",
    maxBuffer: maxOutputBytes,
    env: gitEnvironment(workspace)
  });
  if (result.error) {
    return `git unavailable or failed: ${result.error.message}`;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "";
    const stdout = result.stdout?.trim() || "";
    return stderr || stdout || `git exited with status ${result.status}`;
  }
  return redactSensitiveText(result.stdout.trim() || "(no output)");
}

export function gitStatus(config: CodexBridgeConfig, workspace: Workspace, guard?: PathGuard, filePath?: string): string {
  const args = ["status", "--short", "--branch"];
  if (filePath?.trim()) {
    if (!guard) return "path-scoped git status requires a path guard";
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
  }
  return runGit(workspace, args, config.maxOutputBytes);
}

export function gitDiff(config: CodexBridgeConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  if (staged) args.push("--staged");
  if (filePath?.trim()) {
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
  }
  return runGit(workspace, args, config.maxOutputBytes);
}

export function gitLog(config: CodexBridgeConfig, workspace: Workspace, maxCount = 8): string {
  const count = Math.max(1, Math.min(Math.floor(maxCount), 30));
  return runGit(workspace, ["log", `--max-count=${count}`, "--oneline", "--decorate"], config.maxOutputBytes);
}

export function assertGitCleanEnoughForWrite(_workspace: Workspace): void {
  // Reserved for future policy hooks. The first version allows writes and returns diffs.
  return;
}
