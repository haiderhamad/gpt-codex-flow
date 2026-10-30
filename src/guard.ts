import fs from "node:fs";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import type { GcfConfig } from "./config.js";
import { expandHome } from "./config.js";

export interface Workspace {
  id: string;
  root: string;
  openedAt: string;
}

export class GcfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GcfError";
  }
}

export function isSubpath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeRelPath(relPath: string): string {
  const normalized = relPath.split(path.sep).join("/");
  if (normalized === "") return ".";
  return normalized;
}

export function displayPath(absPath: string, root: string): string {
  const rel = path.relative(root, absPath) || ".";
  return normalizeRelPath(rel);
}

function workspaceIdForRoot(realRoot: string): string {
  return `ws_${createHash("sha256").update(realRoot).digest("hex").slice(0, 24)}`;
}

function maybeRealpath(existingPath: string): string | undefined {
  try {
    return fs.realpathSync(existingPath);
  } catch {
    return undefined;
  }
}

function closestExistingParent(absPath: string): string {
  let current = path.resolve(absPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly rootIdentities = new Map<string, { dev: number; ino: number }>();

  constructor(private readonly config: GcfConfig) {}

  private assertRootStillSame(workspace: Workspace): void {
    try {
      const canonical = fs.realpathSync(workspace.root);
      const stat = fs.statSync(workspace.root);
      const original = this.rootIdentities.get(workspace.id);
      if (!original || canonical !== workspace.root ||
        !stat.isDirectory() || stat.dev !== original.dev || stat.ino !== original.ino) {
        throw new Error("workspace root identity changed");
      }
    } catch {
      throw new GcfError(
        "Workspace root moved, missing, or replaced since selection. Reconfigure allowed roots and select the correct project again.");
    }
  }

  configuredProjects(): Array<{ project_id: string; name: string; root: string }> {
    return this.config.allowedRoots.map((root) => ({
      project_id: workspaceIdForRoot(root),
      name: path.basename(root) || root,
      root
    }));
  }

  openConfiguredProject(projectId: string): Workspace {
    const project = this.configuredProjects().find((item) => item.project_id === projectId);
    if (!project) throw new GcfError("Unknown project_id. Call list_projects and choose an allowed project.");
    return this.openWorkspace(project.root);
  }

  defaultWorkspace(): Workspace {
    const existing = [...this.workspaces.values()].find((workspace) => workspace.root === this.config.defaultRoot);
    if (existing) {
      this.assertRootStillSame(existing);
      return existing;
    }
    return this.openWorkspace(this.config.defaultRoot);
  }

  openWorkspace(rootInput?: string): Workspace {
    const requested = rootInput?.trim() ? expandHome(rootInput.trim()) : this.config.defaultRoot;
    const resolved = path.resolve(requested);
    if (!fs.existsSync(resolved)) {
      throw new GcfError(`Workspace root does not exist: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new GcfError(`Workspace root is not a directory: ${resolved}`);
    }
    const realRoot = fs.realpathSync(resolved);
    const allowed = this.config.allowedRoots.some((allowedRoot) => isSubpath(realRoot, allowedRoot));
    if (!allowed) {
      throw new GcfError(
        `Workspace root is outside allowed roots: ${realRoot}\nAllowed roots:\n${this.config.allowedRoots.map((r) => `- ${r}`).join("\n")}`
      );
    }

    const existing = [...this.workspaces.values()].find((workspace) => workspace.root === realRoot);
    if (existing) {
      this.assertRootStillSame(existing);
      return existing;
    }

    const id = workspaceIdForRoot(realRoot);
    const workspace = { id, root: realRoot, openedAt: new Date().toISOString() };
    const identity = fs.statSync(realRoot);
    this.rootIdentities.set(id, { dev: identity.dev, ino: identity.ino });
    this.workspaces.set(id, workspace);
    return workspace;
  }

  getWorkspace(id?: string): Workspace {
    if (!id) {
      if (this.config.allowedRoots.length > 1) {
        throw new GcfError("Project selection required: multiple roots configured. Call list_projects and select_project, then pass its workspace_id with each project operation.");
      }
      return this.defaultWorkspace();
    }
    const workspace = this.workspaces.get(id);
    if (!workspace) {
      throw new GcfError(`Unknown workspace_id: ${id}. Call open_workspace first.`);
    }
    this.assertRootStillSame(workspace);
    return workspace;
  }

  listWorkspaces(): Workspace[] {
    return [...this.workspaces.values()];
  }
}

export class PathGuard {
  constructor(private readonly config: GcfConfig) {}

  isBlockedRelativePath(relPath: string): boolean {
    const rel = normalizeRelPath(relPath).replace(/^\.\//, "");
    if (!rel || rel === ".") return false;
    return this.config.blockedGlobs.some((glob) =>
      minimatch(rel, glob, { dot: true, nocase: false, matchBase: false }) ||
      minimatch(path.basename(rel), glob, { dot: true, nocase: false, matchBase: true })
    );
  }

  assertNotBlocked(relPath: string): void {
    if (this.isBlockedRelativePath(relPath)) {
      throw new GcfError(`Path is blocked by safety rules: ${relPath}`);
    }
  }

  resolve(workspace: Workspace, inputPath = ".", options: { forWrite?: boolean } = {}): { absPath: string; relPath: string } {
    const expanded = expandHome(inputPath || ".");
    const candidate = path.isAbsolute(expanded) ? expanded : path.join(workspace.root, expanded);
    const absPath = path.resolve(candidate);
    const relPath = displayPath(absPath, workspace.root);

    if (!isSubpath(absPath, workspace.root)) {
      throw new GcfError(`Path escapes workspace root: ${inputPath}`);
    }

    this.assertNotBlocked(relPath);

    const realTarget = maybeRealpath(absPath);
    if (realTarget) {
      if (!isSubpath(realTarget, workspace.root)) {
        throw new GcfError(`Path resolves outside workspace root through a symlink: ${inputPath}`);
      }
      const realRel = displayPath(realTarget, workspace.root);
      this.assertNotBlocked(realRel);
    }

    if (options.forWrite) {
      const parent = closestExistingParent(path.dirname(absPath));
      const realParent = maybeRealpath(parent);
      if (realParent && !isSubpath(realParent, workspace.root)) {
        throw new GcfError(`Write path resolves through a parent outside the workspace: ${inputPath}`);
      }
      if (realParent) {
        const realParentRel = displayPath(realParent, workspace.root);
        this.assertNotBlocked(realParentRel);
      }
    }

    return { absPath, relPath };
  }

  async assertTextFile(absPath: string, maxBytes: number): Promise<void> {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) {
      throw new GcfError(`Not a file: ${absPath}`);
    }
    if (stat.size > maxBytes) {
      throw new GcfError(`File is too large (${stat.size} bytes). Limit: ${maxBytes} bytes.`);
    }
    const handle = await fsp.open(absPath, "r");
    try {
      const sample = Buffer.alloc(Math.min(4096, stat.size));
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      if (sample.subarray(0, bytesRead).includes(0)) {
        throw new GcfError("Refusing to read binary file.");
      }
    } finally {
      await handle.close();
    }
  }
}

export function userHome(): string {
  return os.homedir();
}
