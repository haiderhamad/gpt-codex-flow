import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Workspace } from "./guard.js";

// Metadata is untrusted text. A profile is not a running agent or a command.
export interface AgentProfile {
  kind: "agent_profile";
  name: string;
  description?: string;
  source: "workspace" | "user";
  path: string;
  executable: false;
}

type RecordEntry = AgentProfile & { file: string; root: string; parent: string };
type SearchOptions = {
  query?: string;
  source?: AgentProfile["source"];
  includeGlobal?: boolean;
  offset?: number;
  limit?: number;
  maxProfiles?: number;
};
export interface AgentSearchResult {
  profiles: AgentProfile[];
  total_matches: number;
  inspected: number;
  scan_limit_reached: boolean;
  offset: number;
  limit: number;
  next_offset: number | null;
}
export interface LoadedAgentProfile {
  profile: AgentProfile;
  text: string;
  bytes: number;
  total_bytes: number;
  truncated: boolean;
}

const MAX_PROFILES = 1_000;
const EXCLUDED = new Set(["readme.md", "agents.md", "index.md", "changelog.md"]);

function roots(workspace: Workspace, includeGlobal: boolean) {
  const local = [".codex/agents", ".agents/agents", ".claude/agents", "agents"]
    .map((folder) => ({ root: path.join(workspace.root, folder), parent: workspace.root, source: "workspace" as const }));
  const global = [".codex/agents", ".agents/agents", ".claude/agents"]
    .map((folder) => ({ root: path.join(os.homedir(), folder), parent: os.homedir(), source: "user" as const }));
  return includeGlobal ? [...local, ...global] : local;
}

async function findMarkdown(root: string, depth: number, files: string[], cap: number): Promise<void> {
  if (depth < 0 || files.length >= cap) return;
  let entries: fs.Dirent[];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (files.length >= cap) break;
    if (entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules") continue;
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await findMarkdown(candidate, depth - 1, files, cap);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") &&
      !EXCLUDED.has(entry.name.toLowerCase())) {
      files.push(candidate);
    }
  }
}

function isWithin(child: string, parent: string): boolean {
  return child.startsWith(parent + path.sep);
}

async function readApproved(file: string, root: string, parent: string, limit: number) {
  const [realFile, realRoot, realParent, initial] = await Promise.all([
    fsp.realpath(file), fsp.realpath(root), fsp.realpath(parent), fsp.lstat(file)
  ]);
  // macOS may expose an approved root through an alias (e.g. /var -> /private/var).
  // Compare canonical paths for containment instead of requiring literal equality.
  if (!isWithin(realRoot, realParent) || !isWithin(realFile, realRoot) ||
    !initial.isFile() || initial.isSymbolicLink()) {
    throw new Error("Agent profile must be a regular file inside an approved directory.");
  }
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== initial.ino || opened.dev !== initial.dev) {
      throw new Error("Agent profile changed while opening.");
    }
    const buffer = Buffer.alloc(Math.min(opened.size, limit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      bytes: bytesRead,
      total_bytes: opened.size,
      truncated: bytesRead < opened.size
    };
  } finally { await handle.close(); }
}

function metadata(text: string, key: "name" | "description", cap: number): string | undefined {
  const front = text.match(/^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  const line = front?.[1].split(/\r?\n/u).find((entry) => entry.startsWith(key + ":"));
  const raw = line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
  return raw?.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, cap) || undefined;
}

function publicProfile(record: RecordEntry): AgentProfile {
  return {
    kind: "agent_profile", name: record.name, description: record.description,
    source: record.source, path: record.path, executable: false
  };
}

async function discover(workspace: Workspace, includeGlobal: boolean, cap: number): Promise<RecordEntry[]> {
  const results: RecordEntry[] = [];
  for (const location of roots(workspace, includeGlobal)) {
    if (results.length >= cap) break;
    const candidates: string[] = [];
    await findMarkdown(location.root, 2, candidates, cap - results.length);
    for (const file of candidates) {
      try {
        const sample = await readApproved(file, location.root, location.parent, 12_000);
        const stem = path.basename(file, path.extname(file)).slice(0, 120);
        const name = metadata(sample.text, "name", 120) ?? stem;
        const description = metadata(sample.text, "description", 300);
        const prefix = location.source === "workspace" ? "$WORKSPACE/" : "~/";
        const relative = path.relative(location.parent, file).split(path.sep).join("/");
        results.push({ kind: "agent_profile", name, description, source: location.source,
          path: prefix + relative, executable: false, file,
          root: location.root, parent: location.parent });
      } catch { /* Inaccessible, redirected or changed files are not catalogued. */ }
    }
  }
  return results.sort((a, b) =>
    (a.source === b.source ? 0 : a.source === "workspace" ? -1 : 1) ||
    a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

export async function searchAgentProfiles(workspace: Workspace, options: SearchOptions = {}): Promise<AgentSearchResult> {
  const query = (options.query ?? "").trim();
  if (query.length > 200) throw new Error("Agent profile query must be 200 characters or fewer.");
  const maxProfiles = Math.max(1, Math.min(options.maxProfiles ?? MAX_PROFILES, MAX_PROFILES));
  const records = await discover(workspace, options.includeGlobal !== false, maxProfiles);
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const matches = records.filter((item) => {
    if (options.source && options.source !== item.source) return false;
    const searchable = `${item.name} ${item.description ?? ""}`.toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  const offset = Math.max(0, Math.min(Math.floor(options.offset ?? 0), 100_000));
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 10), 50));
  const profiles = matches.slice(offset, offset + limit).map(publicProfile);
  const after = offset + profiles.length;
  return {
    profiles, total_matches: matches.length, inspected: records.length,
    scan_limit_reached: records.length >= maxProfiles,
    offset, limit, next_offset: after < matches.length ? after : null
  };
}

export async function loadAgentProfile(workspace: Workspace, options: {
  name: string; source?: AgentProfile["source"]; path?: string;
  includeGlobal?: boolean; maxBytes?: number;
}): Promise<LoadedAgentProfile> {
  const name = options.name.trim();
  if (!name) throw new Error("Agent profile name is required.");
  const records = await discover(workspace, options.includeGlobal !== false, MAX_PROFILES);
  const matches = records.filter((item) => item.name === name &&
    (!options.source || item.source === options.source) &&
    (!options.path || item.path === options.path));
  if (matches.length === 0) throw new Error("Agent profile not found: " + name);
  if (matches.length > 1) throw new Error("Multiple agent profiles found. Specify source and path.");
  const record = matches[0];
  const maxBytes = Math.max(1_000, Math.min(options.maxBytes ?? 40_000, 100_000));
  const data = await readApproved(record.file, record.root, record.parent, maxBytes);
  return { profile: publicProfile(record), ...data };
}
