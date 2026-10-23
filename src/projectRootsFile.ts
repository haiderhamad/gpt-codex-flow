import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_CONFIG_BYTES = 65_536;
const MAX_PROJECTS = 20;

export type ProjectRootsManifest = { version: 1; roots: string[] };

function containedIn(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * A small, explicitly opted-in local owner project allowlist.
 * Loading this file is an authorization boundary: NEVER enable it implicitly,
 * and NEVER accept this file's path or contents via an untrusted MCP tool call.
 */
export function validateProjectRoots(roots: readonly string[]): string[] {
  if (!Array.isArray(roots) || roots.length < 1 || roots.length > MAX_PROJECTS) {
    throw new Error("Project roots manifest requires 1-20 explicitly chosen folders.");
  }
  const canonical: string[] = [];
  const home = fs.realpathSync(os.homedir());
  for (const raw of roots) {
    if (typeof raw !== "string" || !path.isAbsolute(raw) ||
      !raw.trim() || raw.includes("\u0000")) {
      throw new Error("Project roots must be explicit absolute paths.");
    }
    const resolved = path.resolve(raw);
    if (resolved !== raw || !fs.existsSync(resolved)) {
      throw new Error("Project root does not exist or is not a normalized absolute path: " + raw);
    }
    const info = fs.statSync(resolved);
    if (!info.isDirectory()) throw new Error("Project root must be a directory: " + raw);
    const real = fs.realpathSync(resolved);
    if (real !== resolved || real === path.parse(real).root || real === home) {
      throw new Error("Project root must be a canonical directory, never home or filesystem root: " + raw);
    }
    const gitMarker = path.join(real, ".git");
    // Git is optional. If present, keep rejecting unusual markers at the
    // authorization boundary (including dangling symlinks).
    try {
      const gitStat = fs.lstatSync(gitMarker);
      if (!gitStat.isDirectory() && !gitStat.isFile()) {
        throw new Error("Project .git marker must be an ordinary directory or worktree file: " + raw);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (canonical.some((existing) => containedIn(real, existing) || containedIn(existing, real))) {
      throw new Error("Project roots cannot duplicate or contain another selected project: " + raw);
    }
    canonical.push(real);
  }
  return canonical;
}

// Local OWNER RECOVERY ONLY. Parse a bounded, structurally valid allowlist even
// when a previously configured repo is now missing/moved. Never pass this
// snapshot directly into the live MCP server's allowedRoots.
export function readProjectRootsManifestSnapshot(filename: string): string[] {
  if (!path.isAbsolute(filename)) throw new Error("Project roots manifest path must be absolute.");
  const pathToRead = path.resolve(filename);
  const info = fs.lstatSync(pathToRead);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
    info.size > MAX_CONFIG_BYTES) {
    throw new Error("Project roots manifest must be a bounded ordinary file, not a symlink.");
  }
  const fd = fs.openSync(pathToRead, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let raw: string;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_CONFIG_BYTES) {
      throw new Error("Project roots manifest descriptor changed or is oversized.");
    }
    raw = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  const doc: unknown = JSON.parse(raw);
  if (!doc || typeof doc !== "object" || Array.isArray(doc) ||
    Object.keys(doc).sort().join(",") !== "roots,version" ||
    (doc as ProjectRootsManifest).version !== 1) {
    throw new Error("Invalid project roots manifest schema/version.");
  }
  return validateProjectRootPaths((doc as ProjectRootsManifest).roots);
}

export function validateProjectRootPaths(roots: readonly string[]): string[] {
  if (!Array.isArray(roots) || roots.length > MAX_PROJECTS) {
    throw new Error("Project roots manifest permits at most 20 explicitly chosen folders.");
  }
  const normalized: string[] = [];
  const home = fs.realpathSync(os.homedir());
  for (const raw of roots) {
    if (typeof raw !== "string" || !raw.trim() || !path.isAbsolute(raw) ||
        raw.includes("\u0000") || path.resolve(raw) !== raw ||
        raw === path.parse(raw).root || raw === home) {
      throw new Error("Invalid root path in owner recovery snapshot.");
    }
    if (normalized.some((prior) => containedIn(raw, prior) || containedIn(prior, raw))) {
      throw new Error("Project roots cannot duplicate or contain another selected project.");
    }
    normalized.push(raw);
  }
  return normalized;
}

export function readProjectRootsManifest(filename: string): string[] {
  // START/authorization requires the stronger live filesystem checks.
  return validateProjectRoots(readProjectRootsManifestSnapshot(filename));
}

export function makeProjectRootsManifest(roots: readonly string[]): ProjectRootsManifest {
  return { version: 1, roots: validateProjectRoots(roots) };
}
