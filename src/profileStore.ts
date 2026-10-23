import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BashMode, BashTranscriptMode, CodexSessionsMode, ToolMode, WriteMode } from "./config.js";
import { expandHome } from "./config.js";

export type TunnelMode = "none" | "cloudflare";
export type ConnectorMode = "agent" | "handoff" | "pro";

export interface WorkspaceProfile {
  version?: number;
  root?: string;
  updatedAt?: string;
  profilePath?: string;
  port?: string;
  mode?: ConnectorMode | string;
  tunnel?: TunnelMode | string;
  cloudflareToken?: string; // Redact credentials in pre-release profiles; never used for connection setup.
  token?: string;
  bash?: BashMode | string;
  bashTranscript?: BashTranscriptMode | string;
  codexSessions?: CodexSessionsMode | string;
  codexDir?: string;
  bashSession?: string;
  requireBashSession?: boolean;
  write?: WriteMode | string;
  toolMode?: ToolMode | string;
  widgetDomain?: string;
  noInstallCloudflared?: boolean;
}

export interface RuntimeConnection {
  version?: number;
  root?: string;
  updatedAt?: string;
  endpoint?: string;
  localBase?: string;
  localStatusUrl?: string;
  tunnel?: TunnelMode | string;
  mode?: ConnectorMode | string;
  bash?: BashMode | string;
  bashTranscript?: BashTranscriptMode | string;
  codexSessions?: CodexSessionsMode | string;
  bashSession?: string;
  requireBashSession?: boolean;
  write?: WriteMode | string;
  toolMode?: ToolMode | string;
}

export function codexBridgeHome(): string {
  const customHome = process.env.CODEXBRIDGE_HOME;
  return customHome ? path.resolve(expandHome(customHome)) : path.join(os.homedir(), ".codexbridge");
}

export function profileDir(): string {
  return path.join(codexBridgeHome(), "profiles");
}

export function profileIdForRoot(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 24);
}

export function profilePathForRoot(root: string): string {
  return path.join(profileDir(), `${profileIdForRoot(root)}.json`);
}

export function runtimeDir(): string {
  return path.join(codexBridgeHome(), "runtime");
}

export function runtimeStatusPathForRoot(root: string): string {
  return path.join(runtimeDir(), `${profileIdForRoot(root)}.json`);
}

function readJsonFile(filePath: string): unknown {
  try {
    for (const directory of [codexBridgeHome(), path.dirname(filePath)]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Profile state directory must not be a link.");
    }
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65_536) {
      throw new Error("Profile state must be a bounded regular file without links.");
    }
    const handle = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(handle);
      if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > 65_536) {
        throw new Error("Profile state changed while opening.");
      }
      const buffer = Buffer.alloc(65_537);
      const count = fs.readSync(handle, buffer, 0, buffer.length, 0);
      if (count > 65_536) throw new Error("Profile state exceeds size limit.");
      return JSON.parse(buffer.subarray(0, count).toString("utf8"));
    } finally { fs.closeSync(handle); }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

export function readWorkspaceProfile(root: string): WorkspaceProfile {
  const profilePath = profilePathForRoot(root);
  if (!profilePath) return {};
  if (!fs.existsSync(profilePath)) return {};
  const profile = readJsonFile(profilePath);
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return {};
  const typed = profile as WorkspaceProfile;
  if (typed.root && typed.root !== root) return {};
  return { ...typed, profilePath };
}

export function saveWorkspaceProfile(root: string, profile: WorkspaceProfile): string {
  const dir = profileDir();
  const filePath = profilePathForRoot(root);
  const { profilePath: _profilePath, ...rest } = profile;
  // Reject links at the configured home and profile directory. Atomic rename
  // avoids following a substituted destination file. This is file hygiene,
  // not an authentication boundary against hostile code running as this UID.
  const home = codexBridgeHome();
  for (const candidate of [home, dir]) {
    if (!fs.existsSync(candidate)) {
      try { fs.lstatSync(candidate); throw new Error("Profile directory is a dangling link."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
    }
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("Profile directory must be owned locally and must not be a symlink.");
    }
  }
  const canonicalDir = fs.realpathSync(dir);
  const directoryIdentity = fs.statSync(canonicalDir);
  try {
    const existing = fs.lstatSync(filePath);
    if (!existing.isFile() || existing.nlink !== 1) throw new Error("Profile target must not be a link.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const payload: WorkspaceProfile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...rest,
    root
  };
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > 65_536) throw new Error("Profile state exceeds size limit.");
  const temporary = path.join(canonicalDir, `.profile-${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT |
    fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    const current = fs.statSync(dir);
    if (fs.realpathSync(dir) !== canonicalDir || current.ino !== directoryIdentity.ino ||
        current.dev !== directoryIdentity.dev) throw new Error("Profile directory changed during save.");
    fs.renameSync(temporary, path.join(canonicalDir, path.basename(filePath)));
  } finally { fs.rmSync(temporary, { force: true }); }
  return filePath;
}

export function sanitizeWorkspaceProfile(profile: WorkspaceProfile): WorkspaceProfile {
  if (!profile || !Object.keys(profile).length) return {};
  const { token, cloudflareToken, ...rest } = profile;
  return {
    ...rest,
    ...(token ? { token: "<saved>" } : {}),
    ...(cloudflareToken ? { cloudflareToken: "<saved>" } : {})
  };
}

export function readRuntimeConnection(root: string): RuntimeConnection {
  const runtimePath = runtimeStatusPathForRoot(root);
  if (!runtimePath) return {};
  if (!fs.existsSync(runtimePath)) return {};
  const runtime = readJsonFile(runtimePath);
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return {};
  const typed = runtime as RuntimeConnection;
  if (typed.root && typed.root !== root) return {};
  return typed;
}
