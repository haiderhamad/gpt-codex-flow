import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { CodexBridgeError } from "./guard.js";

// Small local UX metadata store; NOT authorization and NOT an anti-rollback ledger.
// Only explicitly allowed workspace IDs can be renamed through MCP.
const MAX_BYTES = 65_536;
type AliasDocument = { version: 1; aliases: Record<string, string> };

function validAlias(value: string): string {
  const alias = value.normalize("NFC").trim();
  if (!alias || alias.length > 64 || Buffer.byteLength(alias, "utf8") > 160 ||
    /[\u0000-\u001f\u007f]/u.test(alias)) {
    throw new CodexBridgeError("Project alias must be 1-64 characters, without control characters.");
  }
  return alias;
}

function checkPlainFile(filename: string): void {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES) {
    throw new CodexBridgeError("Project alias registry is not a bounded ordinary file.");
  }
}

export class ProjectAliasRegistry {
  constructor(private readonly filename: string = path.join(os.homedir(), ".codexbridge", "gpt-codex-flow", "project-aliases.json")) {}

  read(): Record<string, string> {
    if (!fs.existsSync(this.filename)) return {};
    try {
      checkPlainFile(this.filename);
      const descriptor = fs.openSync(this.filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      let content: string;
      try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_BYTES) throw new Error("unsafe alias registry handle");
        content = fs.readFileSync(descriptor, "utf8");
      } finally {
        fs.closeSync(descriptor);
      }
      const doc: unknown = JSON.parse(content);
      if (!doc || typeof doc !== "object" || Array.isArray(doc) ||
        Object.keys(doc).sort().join(",") !== "aliases,version" ||
        (doc as AliasDocument).version !== 1) throw new Error("invalid schema");
      const raw = (doc as AliasDocument).aliases;
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 256) {
        throw new Error("invalid alias index");
      }
      const aliases: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [projectId, alias] of Object.entries(raw)) {
        if (!/^ws_[0-9a-f]{24}$/.test(projectId) || typeof alias !== "string" ||
            validAlias(alias) !== alias) throw new Error("invalid registry item");
        aliases[projectId] = alias;
      }
      return aliases;
    } catch (error) {
      throw new CodexBridgeError("Project alias registry unreadable or invalid; refusing to guess aliases. " +
        (error instanceof Error ? error.message : String(error)));
    }
  }

  rename(projectId: string, alias: string, allowedIds: string[]): string {
    if (!allowedIds.includes(projectId)) {
      throw new CodexBridgeError("Unknown project_id: cannot rename a project outside configured roots.");
    }
    const cleaned = validAlias(alias);
    const aliases = this.read();
    const matching = Object.entries(aliases).find(([key, value]) =>
      key !== projectId && allowedIds.includes(key) &&
      value.toLocaleLowerCase("en-US") === cleaned.toLocaleLowerCase("en-US"));
    if (matching) throw new CodexBridgeError("Project alias already belongs to another configured project.");
    aliases[projectId] = cleaned;
    this.save(aliases);
    return cleaned;
  }

  // Explicitly transfer ONLY the user-facing name from a stale path-derived ID
  // to an already configured project root. Never move/merge Git or .ai-bridge.
  recoverAlias(previousProjectId: string, newProjectId: string, expectedAlias: string,
    configuredIds: string[]): string {
    if (configuredIds.includes(previousProjectId)) {
      throw new CodexBridgeError("Old project is still configured; alias recovery requires a stale project ID.");
    }
    if (!configuredIds.includes(newProjectId) || previousProjectId === newProjectId) {
      throw new CodexBridgeError("Destination project is not an explicitly configured root.");
    }
    const aliases = this.read();
    if (!Object.hasOwn(aliases, previousProjectId)) {
      throw new CodexBridgeError("No saved alias for old project ID.");
    }
    const oldName = aliases[previousProjectId];
    if (oldName !== expectedAlias) {
      throw new CodexBridgeError("Expected old project alias does not match; review source and destination.");
    }
    if (Object.hasOwn(aliases, newProjectId)) {
      throw new CodexBridgeError("Destination already has a saved alias; refusing to overwrite.");
    }
    if (Object.entries(aliases).some(([key, value]) =>
      key !== previousProjectId && configuredIds.includes(key) &&
      value.toLocaleLowerCase("en-US") === oldName.toLocaleLowerCase("en-US"))) {
      throw new CodexBridgeError("Alias collides with a different configured project.");
    }
    delete aliases[previousProjectId];
    aliases[newProjectId] = oldName;
    this.save(aliases);
    return oldName;
  }

  private save(aliases: Record<string, string>): void {
    const doc: AliasDocument = { version: 1, aliases };
    const encoded = JSON.stringify(doc, null, 2) + "\n";
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw new CodexBridgeError("Alias registry too large.");
    const dir = path.dirname(this.filename);
    // Create only on explicit rename/recovery; listing projects never writes.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const parent = fs.lstatSync(dir);
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new CodexBridgeError("Project alias registry parent is not an ordinary directory.");
    }
    if (fs.existsSync(this.filename)) checkPlainFile(this.filename);
    const temp = path.join(dir, `.project-aliases-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, encoded, { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, this.filename);
    } finally {
      try { fs.unlinkSync(temp); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}
