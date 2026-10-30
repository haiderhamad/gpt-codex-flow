#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.log(`GPT Codex Flow connection and compatibility helpers

Use gcf ui for owner-local setup and Cloudflare Quick Tunnel access.
Cloudflare Quick Tunnel is the only supported public connection.

Usage:
  gcf init --root /path/to/repo
  gcf start --root /path/to/repo --tunnel cloudflare
  gcf settings show|list|set|use|delete
  gcf doctor
  gcf install-cloudflared
  gcf execute-handoff --agent codex --dry-run
  gcf watch-handoff --agent codex
  gcf pro-bundle --root /path/to/repo --copy
  gcf pro-apply --root /path/to/repo --file plan.md

Connection options:
  --root <dir>              Explicit workspace root.
  --allow-root <dir>        Additional approved root; repeatable.
  --host <host>             Internal HTTP bind host; default 127.0.0.1.
  --port <port>             Internal HTTP port; default 8787.
  --tunnel cloudflare       Cloudflare Quick Tunnel; URL changes after restart.
  --token <token>           Secret MCP bearer credential; generated if absent.
  --cloudflared <path>      Explicit cloudflared executable.
  --no-install-cloudflared  Require an already installed cloudflared executable.
  --no-profile              Ignore saved workspace settings.
  --no-copy-url             Do not copy the private URL to the clipboard.
  --open-chatgpt            Open ChatGPT connection settings.
  --write <off|handoff|workspace>
  --bash <off|safe|full>     MCP command policy, separate from the Codex sandbox.
  --bash-transcript <compact|full>
  --bash-session <id>       Optional MCP Bash session label.
  --require-bash-session    Require the matching session label.
  --codex-sessions <off|metadata|read>
  --codex-dir <dir>          Optional Codex session directory.
  --mode <agent|handoff|pro>
  --tool-mode <minimal|standard|full>
  --widget-domain <origin>
  --log-requests            Redacted local request/tool logs.
  --help                    Show this message.

Handoff options:
  --agent <opencode|pi|codex|custom>
  --model <provider/model>  Optional local adapter model.
  --command <template>      Custom local command template.
  --dry-run                 Preview only; do not invoke an agent.
  --context-dir <dir>       Default .ai-bridge.
  --timeout-ms <ms>         Default 600000.
  --max-output-bytes <n>    Default 120000 per stream.
  --once                    Watch one plan then exit.
  --poll-interval-ms <ms>   Default 2000.
  --debounce-ms <ms>        Default 500.
  --state-file <path>       Optional local watch state.
  --yes                     Explicit local execution or settings-delete choice.
`);
}

const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m'
};

function paint(style, text) {
  if (!colorEnabled) return text;
  return `${ansi[style] ?? ''}${text}${ansi.reset}`;
}

function termWidth(max = 78) {
  return Math.max(56, Math.min(max, process.stdout.columns || max));
}

function divider(label = '') {
  const width = termWidth();
  if (!label) return paint('dim', '-'.repeat(width));
  const text = ` ${label} `;
  return paint('dim', `${text}${'-'.repeat(Math.max(0, width - text.length))}`);
}

function printBox(title, lines) {
  const width = termWidth();
  const inner = width - 4;
  console.log(divider(title));
  for (const line of lines) {
    const chunks = wrapLine(line, inner);
    for (const chunk of chunks) console.log(`| ${chunk.padEnd(inner)} |`);
  }
  console.log(divider());
}

function wrapLine(text, width) {
  if (text.length <= width) return [text];
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function labelValue(label, value) {
  return `${label.padEnd(12)} ${value}`;
}

function statusLine(status, detail = '') {
  const marker = status === 'ok' ? paint('green', 'OK') : status === 'warn' ? paint('yellow', 'WARN') : paint('cyan', '..');
  console.log(`${marker} ${detail}`);
}

function profileSummary(profile) {
  if (!profile?.tunnel) return '';
  if (profile.tunnel === 'cloudflare') return 'Saved Cloudflare quick-tunnel setup';
  if (profile.tunnel === 'none') return 'Saved local-only setup';
  return '';
}

function profileOneLine(profile, index = 0) {
  const prefix = index ? `${index}. ` : '';
  const tunnel = profile.tunnel ?? 'cloudflare';
  const port = profile.port ? ` :${profile.port}` : '';
  return `${prefix}${profile.root}  ${tunnel}${port}`;
}

function parseArgs(argv) {
  const out = { allowRoots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    if (key === 'help') out.help = true;
    else if (key === 'allow-home') out.allowHome = true;
    else if (key === 'no-auth') out.noAuth = true;
    else if (key === 'no-bash') out.bash = 'off';
    else if (key === 'compact-bash-transcript') out.bashTranscript = 'compact';
    else if (key === 'full-bash-transcript') out.bashTranscript = 'full';
    else if (key === 'codex-sessions-read') out.codexSessions = 'read';
    else if (key === 'require-bash-session') out.requireBashSession = true;
    else if (key === 'copy-url') out.copyUrl = true;
    else if (key === 'no-copy-url') out.noCopyUrl = true;
    else if (key === 'dry-run') out.dryRun = true;
    else if (key === 'once') out.once = true;
    else if (key === 'confirm') out.confirm = true;
    else if (key === 'no-confirm') out.noConfirm = true;
    else if (key === 'open-chatgpt') out.openChatgpt = true;
    else if (key === 'no-profile') out.noProfile = true;
    else if (key === 'yes' || key === 'force') out.yes = true;
    else if (key === 'install-cloudflared') out.installCloudflared = true;
    else if (key === 'no-install-cloudflared') out.noInstallCloudflared = true;
    else if (key === 'agent') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out.agent = next;
        i += 1;
      } else {
        out.mode = 'agent';
      }
    }
    else if (key === 'handoff') out.mode = 'handoff';
    else if (key === 'pro-planning' || key === 'pro') out.mode = 'pro';
    else if (key === 'log-requests') out.logRequests = true;
    else if (key === 'print-env') out.printEnv = true;
    else {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
      i += 1;
      if (key === 'allow-root') out.allowRoots.push(next);
      else {
        const supported = ['root', 'from-root', 'mode', 'host', 'port', 'bash',
          'bash-transcript', 'bash-session', 'codex-sessions', 'codex-dir', 'write',
          'tool-mode', 'widget-domain', 'tunnel', 'token', 'cloudflared', 'agent',
          'model', 'command', 'timeout-ms', 'max-output-bytes', 'context-dir',
          'poll-interval-ms', 'poll-interval', 'debounce-ms', 'state-file', 'timeout'];
        if (!supported.includes(key)) throw new Error(`Unsupported option --${key}`);
        out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = next;
      }
    }
  }
  return out;
}

function expandHome(input) {
  if (!input || input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function realDir(input) {
  const resolved = path.resolve(expandHome(input));
  if (!fs.existsSync(resolved)) throw new Error(`Directory does not exist: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  return fs.realpathSync(resolved);
}

function resolveCodexDir(root, input) {
  if (!input) return '';
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}

function commandExists(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
    shell: process.platform !== 'win32',
    stdio: 'ignore'
  });
  return result.status === 0;
}

function isPathLike(command) {
  return command.includes('/') || command.includes('\\') || command.startsWith('.');
}

function resolveExecutablePath(command) {
  const expanded = expandHome(command);
  return path.resolve(expanded);
}

function executableFileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function commandAvailable(command) {
  if (isPathLike(command)) return executableFileExists(resolveExecutablePath(command));
  return commandExists(command);
}

function commandAvailableFromRoot(command, root) {
  if (!isPathLike(command)) return commandExists(command);
  const expanded = expandHome(command);
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
  return executableFileExists(resolved);
}

function gcfHome() {
  const customHome = process.env.GCF_HOME;
  return customHome ? path.resolve(expandHome(customHome)) : path.join(os.homedir(), '.gcf');
}

function profileDir() {
  return path.join(gcfHome(), 'profiles');
}

function profileIdForRoot(root) {
  return createHash('sha256').update(root).digest('hex').slice(0, 24);
}

function profilePathForRoot(root) {
  return path.join(profileDir(), `${profileIdForRoot(root)}.json`);
}

function runtimeDir() {
  return path.join(gcfHome(), 'runtime');
}

function runtimeStatusPathForRoot(root) {
  return path.join(runtimeDir(), `${profileIdForRoot(root)}.json`);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
}

function loadWorkspaceProfile(root) {
  const profilePath = profilePathForRoot(root);
  if (!profilePath) return {};
  if (!fs.existsSync(profilePath)) return {};
  const profile = readJsonFile(profilePath);
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return {};
  if (profile.root && profile.root !== root) return {};
  return { ...profile, profilePath };
}

function listWorkspaceProfiles() {
  const dir = profileDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const profilePath = path.join(dir, name);
      const profile = readJsonFile(profilePath);
      if (!profile || typeof profile !== 'object' || Array.isArray(profile) || !profile.root) return null;
      return { ...profile, profilePath };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function deleteWorkspaceProfile(root) {
  const filePath = profilePathForRoot(root);
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath, { force: true });
  return true;
}

function saveWorkspaceProfile(root, profile) {
  const dir = profileDir();
  const filePath = profilePathForRoot(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = {
    version: 1,
    root,
    updatedAt: new Date().toISOString(),
    ...profile
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
  return filePath;
}

function saveRuntimeConnection(root, details, options = {}) {
  const filePath = runtimeStatusPathForRoot(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const payload = {
    version: 1,
    root,
    updatedAt: new Date().toISOString(),
    endpoint: details.endpoint,
    localBase: options.localBase ?? '',
    localStatusUrl: details.localStatusUrl ? details.localStatusUrl.replace(/(gcf_token|gcf_token)=[^&]+/, '$1=<redacted>') : '',
    tunnel: options.tunnel ?? '',
    mode: options.mode ?? '',
    bash: options.bash ?? '',
    bashTranscript: options.bashTranscript ?? '',
    codexSessions: options.codexSessions ?? '',
    bashSession: options.bashSession ?? '',
    requireBashSession: Boolean(options.requireBashSession),
    write: options.write ?? '',
    toolMode: options.toolMode ?? ''
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
  return filePath;
}

function sanitizedProfile(profile) {
  if (!profile || !Object.keys(profile).length) return {};
  const { token, cloudflareToken, ...rest } = profile;
  return {
    ...rest,
    ...(token ? { token: '<saved>' } : {}),
    ...(cloudflareToken ? { cloudflareToken: '<saved>' } : {})
  };
}

function reusableProfilePayload(profile, overrides = {}) {
  const {
    version,
    root,
    updatedAt,
    profilePath,
    ...rest
  } = profile || {};
  return {
    ...rest,
    ...overrides
  };
}

function optionValue(args, profile, field, envNames = [], fallback = undefined) {
  if (args[field] !== undefined) return args[field];
  for (const envName of envNames) {
    if (process.env[envName] !== undefined && process.env[envName] !== '') return process.env[envName];
  }
  if (profile?.[field] !== undefined && profile[field] !== '') return profile[field];
  return fallback;
}

function boolFromValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function optionBool(args, profile, field, envNames = [], fallback = false) {
  if (args[field] !== undefined) return boolFromValue(args[field], fallback);
  for (const envName of envNames) {
    if (process.env[envName] !== undefined && process.env[envName] !== '') return boolFromValue(process.env[envName], fallback);
  }
  if (profile?.[field] !== undefined && profile[field] !== '') return boolFromValue(profile[field], fallback);
  return fallback;
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function validateBashSession(value) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new Error('--bash-session must be 1-64 characters using letters, numbers, dot, underscore, or dash, and must start with a letter or number.');
  }
  return trimmed;
}

function bashSessionOptions(args, profile = {}) {
  const bashSession = validateBashSession(optionValue(args, profile, 'bashSession', ['GCF_BASH_SESSION_ID'], ''));
  const requireBashSession = optionBool(args, profile, 'requireBashSession', ['GCF_REQUIRE_BASH_SESSION'], false);
  if (requireBashSession && !bashSession) {
    throw new Error('--require-bash-session requires --bash-session <id>.');
  }
  return { bashSession, requireBashSession };
}

function bashTranscriptOption(args, profile = {}) {
  const value = optionValue(args, profile, 'bashTranscript', ['GCF_BASH_TRANSCRIPT'], 'compact');
  if (value === 'compact' || value === 'full') return value;
  throw new Error('--bash-transcript must be compact or full.');
}

function codexSessionsOption(args, profile = {}) {
  const value = optionValue(args, profile, 'codexSessions', ['GCF_CODEX_SESSIONS'], 'off');
  if (value === 'off' || value === 'metadata' || value === 'read') return value;
  throw new Error('--codex-sessions must be off, metadata, or read.');
}

function stableToken(existing = '') {
  return existing || randomBytes(24).toString('hex');
}

function cloudflaredBinName() {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

function localCloudflaredPath() {
  return path.join(gcfHome(), 'bin', cloudflaredBinName());
}

function cloudflaredReleaseAsset() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') {
    if (arch === 'arm64') return { file: 'cloudflared-darwin-arm64.tgz', archive: true };
    if (arch === 'x64') return { file: 'cloudflared-darwin-amd64.tgz', archive: true };
  }

  if (platform === 'linux') {
    if (arch === 'arm64') return { file: 'cloudflared-linux-arm64', archive: false };
    if (arch === 'arm') return { file: 'cloudflared-linux-arm', archive: false };
    if (arch === 'x64') return { file: 'cloudflared-linux-amd64', archive: false };
    if (arch === 'ia32') return { file: 'cloudflared-linux-386', archive: false };
  }

  if (platform === 'win32') {
    if (arch === 'x64') return { file: 'cloudflared-windows-amd64.exe', archive: false };
    if (arch === 'ia32') return { file: 'cloudflared-windows-386.exe', archive: false };
  }

  throw new Error(`Automatic cloudflared install is not supported on ${platform}/${arch}. Install cloudflared manually or pass --cloudflared <path>.`);
}

function findFileByName(root, fileName) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return fullPath;
    if (entry.isDirectory()) {
      const found = findFileByName(fullPath, fileName);
      if (found) return found;
    }
  }
  return '';
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'gcf-launcher' }
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer, { mode: 0o755 });
}

function verifyCloudflared(binaryPath) {
  const result = spawnSync(binaryPath, ['--version'], {
    stdio: 'ignore',
    shell: false,
    timeout: 15000
  });
  if (result.status !== 0) {
    throw new Error(`Downloaded cloudflared, but ${binaryPath} --version failed.`);
  }
}

async function installCloudflaredLocal() {
  const asset = cloudflaredReleaseAsset();
  const installPath = localCloudflaredPath();
  const binDir = path.dirname(installPath);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gcf-cloudflared-'));
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.file}`;

  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  console.error(`[gcf] Installing cloudflared locally: ${installPath}`);
  console.error(`[gcf] Downloading official Cloudflare release: ${asset.file}`);

  try {
    if (asset.archive) {
      const archivePath = path.join(tmpRoot, asset.file);
      const extractDir = path.join(tmpRoot, 'extract');
      fs.mkdirSync(extractDir, { recursive: true });
      await downloadFile(url, archivePath);
      const tar = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      });
      if (tar.status !== 0) {
        throw new Error(`Failed to extract ${asset.file}: ${tar.stderr || tar.stdout || `exit ${tar.status}`}`);
      }
      const extracted = findFileByName(extractDir, 'cloudflared');
      if (!extracted) throw new Error(`Could not find cloudflared inside ${asset.file}`);
      fs.copyFileSync(extracted, installPath);
    } else {
      const tmpBinary = path.join(tmpRoot, cloudflaredBinName());
      await downloadFile(url, tmpBinary);
      fs.copyFileSync(tmpBinary, installPath);
    }

    if (process.platform !== 'win32') fs.chmodSync(installPath, 0o755);
    verifyCloudflared(installPath);
    console.error('[gcf] cloudflared installed successfully.');
    return installPath;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function resolveCloudflared(args) {
  const explicit = args.cloudflared ?? process.env.CLOUDFLARED_BIN ?? '';
  if (explicit) {
    const resolved = isPathLike(explicit) ? resolveExecutablePath(explicit) : explicit;
    if (commandAvailable(resolved)) {
      verifyCloudflared(resolved);
      return resolved;
    }
    throw new Error(`cloudflared was not found at ${explicit}. Remove --cloudflared, install it, or pass a valid path.`);
  }

  if (!args.installCloudflared && commandExists('cloudflared')) {
    try {
      verifyCloudflared('cloudflared');
      return 'cloudflared';
    } catch (error) {
      console.error(`[gcf] cloudflared in PATH failed --version; trying local install. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const localPath = localCloudflaredPath();
  if (!args.installCloudflared && executableFileExists(localPath)) {
    try {
      verifyCloudflared(localPath);
      return localPath;
    } catch (error) {
      if (args.noInstallCloudflared) return localPath;
      console.error(`[gcf] Existing ${localPath} failed --version; reinstalling. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (args.noInstallCloudflared) return '';
  return installCloudflaredLocal();
}

function runHelperScript(scriptName, args) {
  const scriptPath = path.join(projectRoot, 'scripts', scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url, token, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (res.ok) return await res.json();
      lastError = `${res.status} ${await res.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}. Last error: ${lastError}`);
}

function portInUseHelp(host, port) {
  return [
    `Local port ${port} is already in use on ${host}.`,
    '',
    'If you want two repositories running at the same time, each one needs its own local port.',
    '',
    'For Quick Tunnel start the second repository with:',
    '  gcf start --port 8788',
    '',
  ].join('\n');
}

async function assertPortAvailable(host, port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
        reject(new Error(portInUseHelp(host, port)));
        return;
      }
      reject(error);
    });
    server.once('listening', () => {
      server.close(() => resolve());
    });
    server.listen(numericPort, host);
  });
}

const spawnedChildren = new Set();

function spawnLogged(name, command, args, options = {}) {
  const { verbose = false, ...spawnOptions } = options;
  const child = spawn(command, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
  const logLines = [];
  const record = (stream, chunk) => {
    const text = String(chunk);
    logLines.push(...text.split(/\r?\n/).filter(Boolean).map((line) => `[${name}] ${line}`));
    while (logLines.length > 120) logLines.shift();
    if (verbose) stream.write(`[${name}] ${text}`);
  };
  child.gcfLogTail = () => logLines.join('\n');
  spawnedChildren.add(child);
  child.stdout.on('data', (chunk) => record(process.stdout, chunk));
  child.stderr.on('data', (chunk) => record(process.stderr, chunk));
  child.on('exit', (code, signal) => {
    spawnedChildren.delete(child);
    if (verbose) console.error(`[${name}] exited code=${code} signal=${signal}`);
  });
  return child;
}

function waitForCloudflareUrl(child, timeoutMs = 45000) {
  const re = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g;
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for cloudflared public URL.')), timeoutMs);
    timer.unref();
    const onData = (chunk) => {
      const text = String(chunk);
      buffer += text;
      const match = buffer.match(re);
      if (match?.[0]) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited before a URL was found, code=${code}`));
    });
  });
}

function killProcess(child) {
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    if (!child.killed) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }, 1500).unref();
}

function cleanupChildren() {
  for (const child of spawnedChildren) killProcess(child);
}

function endpointWithToken(endpoint, token) {
  if (!token) return endpoint;
  const url = new URL(endpoint);
  url.searchParams.set('gcf_token', token);
  return url.toString();
}

function normalizeMode(args) {
  const mode = args.mode ?? envValue('GCF_MODE') ?? 'agent';
  if (!['agent', 'handoff', 'pro'].includes(mode)) {
    throw new Error('--mode must be agent, handoff, or pro');
  }
  return mode;
}

function copyToClipboard(text) {
  const attempts = [];
  if (process.platform === 'darwin') attempts.push(['pbcopy', []]);
  else if (process.platform === 'win32') attempts.push(['cmd', ['/c', 'clip']]);
  else {
    attempts.push(['wl-copy', []]);
    attempts.push(['xclip', ['-selection', 'clipboard']]);
    attempts.push(['xsel', ['--clipboard', '--input']]);
  }

  for (const [command, args] of attempts) {
    const exists = command === 'cmd' || commandExists(command);
    if (!exists) continue;
    const result = spawnSync(command, args, {
      input: text,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore'],
      shell: false
    });
    if (result.status === 0) return { ok: true, command };
  }
  return { ok: false, command: '' };
}

function openUrl(url) {
  const command =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const [bin, args] = command;
  if (bin !== 'cmd' && !commandExists(bin)) return false;
  const result = spawnSync(bin, args, { stdio: 'ignore', shell: false });
  return result.status === 0;
}

function waitForProcessExit(child) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function isSubpath(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const PROJECT_INIT_FILES = ['PROJECT.md', 'HISTORY.md', 'HANDOFF.md'];

function existingLstat(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertProjectInitBridgeDir(root, bridgeDir) {
  const stat = existingLstat(bridgeDir);
  if (!stat) return false;
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to initialize through a symlinked .ai-bridge directory: ${bridgeDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Project context path is not a directory: ${bridgeDir}`);
  }
  const realBridgeDir = fs.realpathSync(bridgeDir);
  if (!isSubpath(realBridgeDir, root)) {
    throw new Error(`Project context directory escapes the Git repository root: ${bridgeDir}`);
  }
  return true;
}

function assertSafeProjectInitTargets(bridgeDir) {
  for (const name of PROJECT_INIT_FILES) {
    const targetPath = path.join(bridgeDir, name);
    const stat = existingLstat(targetPath);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to use a symlinked project context file: ${targetPath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Project context path is not a regular file: ${targetPath}`);
    }
  }
}

function validatedGitRoot(rootInput) {
  const root = realDir(rootInput);
  const gitEnv = { ...process.env };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'GIT_PREFIX'
  ]) {
    delete gitEnv[name];
  }
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
    cwd: root,
    env: gitEnv,
    encoding: 'utf8',
    maxBuffer: 64_000,
    shell: false
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || 'not a Git working tree').trim();
    throw new Error(`Project init requires an existing Git repository root: ${root}\n${detail}`);
  }
  const reportedRoot = realDir(String(result.stdout).trim());
  if (reportedRoot !== root) {
    throw new Error(`--root must select the Git repository top-level.\nSelected: ${root}\nGit root: ${reportedRoot}`);
  }
  return root;
}

function projectInitTemplates(root) {
  const repositoryName = path.basename(root).replace(/[\r\n`]/g, ' ').trim() || 'Unnamed repository';
  return {
    'PROJECT.md': `# Project Context

## Identity

- Repository: \`${repositoryName}\`
- Source of truth: the selected Git working tree and its tracked documentation.

## Goals

- Document verified product and engineering goals here.

## Architecture

- Document confirmed components, boundaries, data flows, and constraints here.

## References

- Review repository-level \`AGENTS.md\` or overrides when present.
- Review existing README and architecture documentation before adding claims.
- Link only to sources that exist in this repository.
`,
    'HISTORY.md': `# Verified Project History

Record only milestones and decisions supported by repository evidence or explicit user confirmation.

No verified history has been recorded in this file yet.

## Entry template

### YYYY-MM-DD — Milestone or decision

- Evidence:
- Decision or outcome:
- Files or references:
`,
    'HANDOFF.md': `# Agent Handoff

## Current task

- Not recorded yet.

## Progress

- No progress has been recorded in this file yet.

## Verification

- No verification results have been recorded in this file yet.

## Blockers

- No blockers have been recorded in this file yet.

## Next agent instructions

- Inspect repository instructions, current Git state, and existing \`.ai-bridge\` state before acting.
- Record only verified work, results, and blockers.
`
  };
}

function runProjectInit(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }
  const root = validatedGitRoot(args.root ?? process.cwd());
  const bridgeDir = path.join(root, '.ai-bridge');

  const bridgeExists = assertProjectInitBridgeDir(root, bridgeDir);
  if (bridgeExists) assertSafeProjectInitTargets(bridgeDir);
  else {
    try {
      fs.mkdirSync(bridgeDir, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    assertProjectInitBridgeDir(root, bridgeDir);
    assertSafeProjectInitTargets(bridgeDir);
  }

  const templates = projectInitTemplates(root);
  const created = [];
  const skipped = [];
  for (const name of PROJECT_INIT_FILES) {
    assertProjectInitBridgeDir(root, bridgeDir);
    const targetPath = path.join(bridgeDir, name);
    try {
      fs.writeFileSync(targetPath, templates[name], { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      created.push(path.posix.join('.ai-bridge', name));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const stat = existingLstat(targetPath);
      if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Project context target became unsafe during initialization: ${targetPath}`);
      }
      skipped.push(path.posix.join('.ai-bridge', name));
    }
  }

  printBox('GPT Codex Flow project init', [
    labelValue('Repository', root),
    labelValue('Created', created.length ? created.join(', ') : 'none'),
    labelValue('Preserved', skipped.length ? skipped.join(', ') : 'none'),
    'Existing repository files and .ai-bridge state were left unchanged.'
  ]);
}

function contextDirFromArgs(args) {
  return args.contextDir ?? envValue('GCF_CONTEXT_DIR') ?? '.ai-bridge';
}

function resolveWorkspaceFile(root, relativePath) {
  const absPath = path.resolve(root, relativePath);
  if (!isSubpath(absPath, root)) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }
  return absPath;
}

function readTextFileBounded(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`File is too large (${stat.size} bytes). Limit: ${maxBytes} bytes.`);
  const sample = fs.readFileSync(filePath, { encoding: null });
  if (sample.includes(0)) throw new Error(`Refusing to read binary file: ${filePath}`);
  return sample.toString('utf8');
}

function numberOption(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function shellCommandPreview(parts) {
  return parts.map((part) => {
    const text = String(part);
    if (/^[A-Za-z0-9_./:@=+-]+$/.test(text)) return text;
    return `'${text.replace(/'/g, "'\\''")}'`;
  }).join(' ');
}

function redactForLog(value) {
  return String(value)
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b[A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]*\s*=\s*(?:"[^"\r\n]{12,}"|'[^'\r\n]{12,}'|`[^`\r\n]{12,}`|[A-Za-z0-9_./+=-]{20,})/gi, (match) => {
      const index = match.indexOf('=');
      return index < 0 ? '[REDACTED_SECRET]' : `${match.slice(0, index).trimEnd()}= [REDACTED_SECRET]`;
    });
}

function trimBytes(value, maxBytes) {
  const redacted = redactForLog(value);
  const buffer = Buffer.from(redacted, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text: redacted, truncated: false };
  return {
    text: `${buffer.subarray(0, maxBytes).toString('utf8')}\n...[output truncated to ${maxBytes} bytes]`,
    truncated: true
  };
}

function splitCommandTemplate(input) {
  const tokens = [];
  let current = '';
  let quote = '';
  const text = String(input);
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\') {
      const next = text[i + 1];
      if (next && (next === quote || next === '\\' || (!quote && /\s|["']/.test(next)))) {
        current += next;
        i += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error('Custom command has an unterminated quote.');
  if (current) tokens.push(current);
  return tokens;
}

function applyCommandTemplate(value, replacements) {
  return String(value).replace(/\{\{\s*(model|plan_file|plan_text|root)\s*\}\}/g, (_, key) => replacements[key] ?? '');
}

function buildExecutorCommand(args, root, planPath, planText) {
  const agent = String(args.agent ?? 'opencode').trim().toLowerCase();
  const model = String(args.model ?? envValue('GCF_AGENT_MODEL') ?? '').trim();
  const replacements = {
    model,
    plan_file: planPath,
    plan_text: planText,
    root
  };

  if (args.command) {
    const template = String(args.command);
    if (!/\{\{\s*(plan_file|plan_text)\s*\}\}/.test(template)) {
      throw new Error('Custom --command must include {{plan_file}} or {{plan_text}} so the agent receives the handoff.');
    }
    const parts = splitCommandTemplate(template).map((part) => applyCommandTemplate(part, replacements));
    const displayParts = splitCommandTemplate(template).map((part) => applyCommandTemplate(part, { ...replacements, plan_text: '<plan_text>' }));
    if (!parts.length) throw new Error('Custom --command is empty.');
    return { agent, model, command: parts[0], args: parts.slice(1), displayArgs: displayParts.slice(1), custom: true };
  }

  if (agent === 'opencode') {
    return {
      agent,
      model,
      command: 'opencode',
      args: ['run', ...(model ? ['--model', model] : []), planText],
      displayArgs: ['run', ...(model ? ['--model', model] : []), '<plan_text>'],
      custom: false
    };
  }
  if (agent === 'pi') {
    return {
      agent,
      model,
      command: 'pi',
      args: [...(model ? ['--model', model] : []), '-p', planText],
      displayArgs: [...(model ? ['--model', model] : []), '-p', '<plan_text>'],
      custom: false
    };
  }
  if (agent === 'codex') {
    return {
      agent,
      model,
      command: 'codex',
      args: ['exec', ...(model ? ['--model', model] : []), planText],
      displayArgs: ['exec', ...(model ? ['--model', model] : []), '<plan_text>'],
      custom: false
    };
  }
  if (agent === 'custom') {
    throw new Error('Custom agent execution requires --command.');
  }
  throw new Error(`Unsupported --agent ${agent}. Use opencode, pi, codex, or custom with --command.`);
}

function executorCommandPreview(commandInfo) {
  return shellCommandPreview([commandInfo.command, ...(commandInfo.displayArgs ?? commandInfo.args)]);
}

function runProcessCaptured(command, args, options) {
  const timeoutMs = options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 1500).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout, 'utf8') > maxOutputBytes * 2) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (Buffer.byteLength(stderr, 'utf8') > maxOutputBytes * 2) child.kill('SIGTERM');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        signal: null,
        durationMs: Date.now() - started,
        timedOut,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        spawnError: true
      });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const out = trimBytes(stdout, maxOutputBytes);
      const err = trimBytes(`${stderr}${timedOut ? `\n[gcf] Command timed out after ${timeoutMs} ms.` : ''}`, maxOutputBytes);
      resolve({
        exitCode,
        signal,
        durationMs: Date.now() - started,
        timedOut,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        spawnError: false
      });
    });
  });
}

function readGitDiff(root, maxBytes) {
  const result = spawnSync('git', ['diff', '--no-ext-diff', '--'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: Math.max(maxBytes * 2, 1_000_000),
    shell: false
  });
  if (result.status !== 0) {
    const reason = result.stderr || result.stdout || `git diff exited ${result.status}`;
    return `# git diff unavailable\n\n${redactForLog(reason).trim()}\n`;
  }
  const diff = result.stdout || '';
  if (!diff.trim()) return '';
  return trimBytes(diff, maxBytes).text;
}

function codeBlock(label, value) {
  return `## ${label}\n\n\`\`\`text\n${String(value || '').replace(/```/g, '`\\`\\`') || '(empty)'}\n\`\`\`\n`;
}

function writeExecutionOutputs(root, contextDir, commandInfo, result, diffText) {
  const bridgeDir = resolveWorkspaceFile(root, contextDir);
  fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
  const statusPath = path.join(bridgeDir, 'agent-status.md');
  const diffPath = path.join(bridgeDir, 'implementation-diff.patch');
  const logPath = path.join(bridgeDir, 'execution-log.jsonl');
  const commandText = executorCommandPreview(commandInfo);
  const status = [
    '# Agent Execution Status',
    '',
    `Updated: ${new Date().toISOString()}`,
    `Agent: ${commandInfo.agent}`,
    commandInfo.model ? `Model: ${commandInfo.model}` : '',
    `Command: ${commandText}`,
    `Exit code: ${result.exitCode ?? 'null'}`,
    result.signal ? `Signal: ${result.signal}` : '',
    `Timed out: ${result.timedOut ? 'yes' : 'no'}`,
    `Duration: ${result.durationMs} ms`,
    `Diff path: ${path.posix.join(contextDir, 'implementation-diff.patch')}`,
    `Execution log: ${path.posix.join(contextDir, 'execution-log.jsonl')}`,
    '',
    codeBlock('Stdout excerpt', result.stdout),
    codeBlock('Stderr excerpt', result.stderr)
  ].filter(Boolean).join('\n');
  fs.writeFileSync(statusPath, status, { mode: 0o600 });
  fs.writeFileSync(diffPath, diffText || '', { mode: 0o600 });
  const logEvent = {
    ts: new Date().toISOString(),
    event: 'execute_handoff',
    agent: commandInfo.agent,
    model: commandInfo.model || undefined,
    command: commandText,
    exit_code: result.exitCode,
    signal: result.signal,
    timed_out: result.timedOut,
    duration_ms: result.durationMs,
    stdout_excerpt: result.stdout,
    stderr_excerpt: result.stderr,
    diff_path: path.posix.join(contextDir, 'implementation-diff.patch'),
    status_path: path.posix.join(contextDir, 'agent-status.md')
  };
  fs.appendFileSync(logPath, `${JSON.stringify(logEvent)}\n`, { mode: 0o600 });
  return { statusPath, diffPath, logPath };
}

async function confirmLocalExecution(args, root, commandInfo) {
  if (args.yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Use --yes to execute a local handoff in non-interactive shells, or use --dry-run to preview.');
  }
  printBox('Confirm local execution', [
    labelValue('Workspace', root),
    labelValue('Agent', commandInfo.agent),
    ...(commandInfo.model ? [labelValue('Model', commandInfo.model)] : []),
    labelValue('Command', executorCommandPreview(commandInfo)),
    'This runs a local process in the workspace. GPT Codex Flow will collect status, logs, and git diff into .ai-bridge.'
  ]);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await ask(rl, 'Run this local agent now?', 'no');
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

function loadHandoffExecution(args) {
  const root = realDir(args.root ?? envValue('GCF_ROOT') ?? process.cwd());
  const contextDir = contextDirFromArgs(args);
  const bridgeDir = resolveWorkspaceFile(root, contextDir);
  const planPath = path.join(bridgeDir, 'current-plan.md');
  const maxReadBytes = numberOption(envValue('GCF_MAX_READ_BYTES'), 180_000, 4_000, 2_000_000);
  const maxOutputBytes = numberOption(args.maxOutputBytes ?? envValue('GCF_MAX_OUTPUT_BYTES'), 120_000, 4_000, 2_000_000);
  const timeoutMs = numberOption(args.timeoutMs ?? args.timeout, 600_000, 1_000, 24 * 60 * 60_000);
  if (!fs.existsSync(planPath)) {
    throw new Error(`No handoff plan found at ${path.relative(root, planPath)}. Ask ChatGPT to call handoff_to_agent first.`);
  }
  const planText = readTextFileBounded(planPath, maxReadBytes);
  const commandInfo = buildExecutorCommand(args, root, planPath, planText);
  const commandText = executorCommandPreview(commandInfo);
  return {
    root,
    contextDir,
    bridgeDir,
    planPath,
    planText,
    commandInfo,
    commandText,
    maxOutputBytes,
    timeoutMs
  };
}

function printHandoffDryRun(request, title = 'GPT Codex Flow execute-handoff dry run') {
  printBox(title, [
    labelValue('Workspace', request.root),
    labelValue('Plan', path.relative(request.root, request.planPath)),
    labelValue('Agent', request.commandInfo.agent),
    ...(request.commandInfo.model ? [labelValue('Model', request.commandInfo.model)] : []),
    labelValue('Command', request.commandText),
    'No command was executed and no .ai-bridge result files were changed.'
  ]);
}

async function executeHandoffRequest(request, args, options = {}) {
  const confirmed = options.skipConfirmation ? true : await confirmLocalExecution(args, request.root, request.commandInfo);
  if (!confirmed) {
    statusLine('warn', 'Execution cancelled.');
    return { cancelled: true, result: null, outputs: null };
  }

  if (!commandAvailableFromRoot(request.commandInfo.command, request.root)) {
    throw new Error(`${request.commandInfo.command} was not found. Install it, add it to PATH, pass an absolute path, or use --command.`);
  }

  statusLine('wait', `Running ${request.commandInfo.agent}: ${request.commandText}`);
  const result = await runProcessCaptured(request.commandInfo.command, request.commandInfo.args, {
    cwd: request.root,
    timeoutMs: request.timeoutMs,
    maxOutputBytes: request.maxOutputBytes
  });
  const diffText = readGitDiff(request.root, request.maxOutputBytes);
  const outputs = writeExecutionOutputs(request.root, request.contextDir, request.commandInfo, result, diffText);
  statusLine(result.exitCode === 0 ? 'ok' : 'warn', `Agent exited with code ${result.exitCode ?? 'null'}${result.signal ? ` signal=${result.signal}` : ''}`);
  console.log(`Status: ${path.relative(request.root, outputs.statusPath)}`);
  console.log(`Diff:   ${path.relative(request.root, outputs.diffPath)}`);
  console.log(`Log:    ${path.relative(request.root, outputs.logPath)}`);
  return { cancelled: false, result, outputs };
}

async function runExecuteHandoff(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }
  const request = loadHandoffExecution(args);

  if (args.dryRun) {
    printHandoffDryRun(request);
    return;
  }

  const execution = await executeHandoffRequest(request, args);
  if (execution.result?.exitCode && execution.result.exitCode !== 0) process.exitCode = execution.result.exitCode;
}

function planHash(planText) {
  return createHash('sha256').update(planText).digest('hex');
}

function isScaffoldedHandoffPlan(planText) {
  return String(planText).trim() === '# Current Plan\n\nNo plan written yet.';
}

function readWatchState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeWatchState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function appendBridgeLog(root, contextDir, event) {
  const bridgeDir = resolveWorkspaceFile(root, contextDir);
  fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(bridgeDir, 'execution-log.jsonl');
  fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

async function waitForStablePlan(planPath, debounceMs) {
  try {
    const before = fs.statSync(planPath);
    await sleep(debounceMs);
    const after = fs.statSync(planPath);
    return before.isFile() && after.isFile() && before.size === after.size && before.mtimeMs === after.mtimeMs;
  } catch {
    return false;
  }
}

async function confirmWatchHandoff(args, root) {
  if (args.yes || args.noConfirm) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Use --yes to start watch-handoff in non-interactive shells.');
  }
  printBox('Confirm handoff watcher', [
    labelValue('Workspace', root),
    labelValue('Agent', args.agent ?? 'opencode'),
    ...(args.model ? [labelValue('Model', args.model)] : []),
    'This starts a local-only watcher. Each new .ai-bridge/current-plan.md hash runs through the configured local agent.',
    'ChatGPT only writes the handoff plan; this terminal-owned process performs execution.'
  ]);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await ask(rl, 'Start automatic local handoff execution?', 'no');
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

async function runWatchHandoff(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }
  const root = realDir(args.root ?? envValue('GCF_ROOT') ?? process.cwd());
  const contextDir = contextDirFromArgs(args);
  const bridgeDir = resolveWorkspaceFile(root, contextDir);
  const planPath = path.join(bridgeDir, 'current-plan.md');
  const statePath = resolveWorkspaceFile(root, args.stateFile ?? path.posix.join(contextDir, 'watch-handoff-state.json'));
  const pollIntervalMs = numberOption(args.pollIntervalMs ?? args.pollInterval, 2000, 250, 60_000);
  const debounceMs = numberOption(args.debounceMs, 500, 0, 30_000);
  let state = readWatchState(statePath);
  let lastDryRunHash = state.lastPlanHash ?? '';
  let lastSkippedHash = '';
  let stopped = false;

  if (!args.dryRun) {
    const approved = await confirmWatchHandoff(args, root);
    if (!approved) {
      statusLine('warn', 'Watcher cancelled.');
      return;
    }
  }

  printBox('GPT Codex Flow watch-handoff', [
    labelValue('Workspace', root),
    labelValue('Plan', path.relative(root, planPath)),
    labelValue('State', path.relative(root, statePath)),
    labelValue('Agent', args.agent ?? 'opencode'),
    ...(args.model ? [labelValue('Model', args.model)] : []),
    labelValue('Poll', `${pollIntervalMs} ms`),
    labelValue('Debounce', `${debounceMs} ms`),
    args.once ? 'Mode: check once and exit.' : 'Mode: watching until Ctrl+C.'
  ]);

  const stop = () => {
    stopped = true;
    statusLine('warn', 'Stopping handoff watcher...');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopped) {
    if (!fs.existsSync(planPath)) {
      if (args.once) throw new Error(`No handoff plan found at ${path.relative(root, planPath)}.`);
      await sleep(pollIntervalMs);
      continue;
    }

    const stable = await waitForStablePlan(planPath, debounceMs);
    if (!stable) {
      if (args.once) throw new Error(`Handoff plan did not become stable at ${path.relative(root, planPath)}.`);
      await sleep(pollIntervalMs);
      continue;
    }

    const request = loadHandoffExecution({ ...args, root, contextDir });
    const currentHash = planHash(request.planText);
    if (isScaffoldedHandoffPlan(request.planText)) {
      if (lastSkippedHash !== currentHash) statusLine('wait', 'Ignoring scaffolded empty handoff plan.');
      lastSkippedHash = currentHash;
      if (args.once) return;
      await sleep(pollIntervalMs);
      continue;
    }
    if (state.lastPlanHash === currentHash || lastDryRunHash === currentHash) {
      statusLine(args.once ? 'ok' : 'wait', `No new handoff plan: ${currentHash.slice(0, 12)}`);
      if (args.once) return;
      await sleep(pollIntervalMs);
      continue;
    }

    if (args.dryRun) {
      printHandoffDryRun(request, 'GPT Codex Flow watch-handoff dry run');
      lastDryRunHash = currentHash;
      if (args.once) return;
      await sleep(pollIntervalMs);
      continue;
    }

    appendBridgeLog(root, contextDir, {
      event: 'watch_handoff_started',
      plan_hash: currentHash,
      agent: request.commandInfo.agent,
      model: request.commandInfo.model || undefined,
      plan_path: path.posix.join(contextDir, 'current-plan.md')
    });

    const execution = await executeHandoffRequest(request, { ...args, yes: true }, { skipConfirmation: true });
    const exitCode = execution.result?.exitCode ?? null;
    state = {
      lastPlanHash: currentHash,
      lastRanAt: new Date().toISOString(),
      agent: request.commandInfo.agent,
      model: request.commandInfo.model || undefined,
      exitCode,
      planPath: path.posix.join(contextDir, 'current-plan.md')
    };
    writeWatchState(statePath, state);
    appendBridgeLog(root, contextDir, {
      event: 'watch_handoff_finished',
      plan_hash: currentHash,
      agent: request.commandInfo.agent,
      model: request.commandInfo.model || undefined,
      exit_code: exitCode,
      status_path: path.posix.join(contextDir, 'agent-status.md'),
      diff_path: path.posix.join(contextDir, 'implementation-diff.patch')
    });

    if (args.once) {
      if (exitCode && exitCode !== 0) process.exitCode = exitCode;
      return;
    }

    await sleep(pollIntervalMs);
  }
}

function createConnectorDetails(endpoint, token, localBase = '') {
  const serverUrl = endpointWithToken(endpoint, token);
  return {
    endpoint,
    token,
    serverUrl,
    localStatusUrl: localBase ? endpointWithToken(`${localBase}/`, token) : '',
    chatgptSettingsUrl: 'https://chatgpt.com/#settings/Connectors'
  };
}

function printCreateAppFields(details) {
  console.log('Create App fields:');
  console.log('');
  console.log('  Name: GPT Codex Flow');
  console.log('  Description: Local coding workspace bridge for ChatGPT.');
  console.log('  Connection: Server URL');
  console.log(`  Server URL: ${details.serverUrl}`);
  console.log('  Authentication: No Authentication / None');
  console.log('');
  if (details.token) {
    console.log('If your ChatGPT UI supports custom headers instead, you can use:');
    console.log('');
    console.log(`  Authorization: Bearer ${details.token}`);
  } else {
    console.log('Authorization: disabled');
  }
}

function printConnectorBlock(endpoint, token, options = {}) {
  const details = createConnectorDetails(endpoint, token, options.localBase ?? '');
  const { serverUrl } = details;
  const publicHttps = serverUrl.startsWith('https://');
  const shouldCopy = options.copyUrl === true || (options.copyUrl !== false && publicHttps);
  const copied = shouldCopy ? copyToClipboard(serverUrl) : { ok: false, command: '' };
  const opened = options.openChatgpt ? openUrl(details.chatgptSettingsUrl) : false;

  const mode = options.mode ?? 'agent';
  const modeTitle = mode === 'agent' ? 'Agent' : mode === 'handoff' ? 'Handoff' : 'Pro planning';
  console.log('');
  console.log(paint('bold', 'GPT Codex Flow ready'));
  if (options.root) console.log(`  Workspace  ${options.root}`);
  console.log(`  Mode       ${modeTitle}  tools=${options.toolMode ?? 'standard'}  write=${options.write ?? 'workspace'}  bash=${options.bash ?? 'safe'}`);
  console.log(`  Transcript bash=${options.bashTranscript ?? 'compact'}`);
  if (options.codexSessions && options.codexSessions !== 'off') console.log(`  Codex      sessions=${options.codexSessions}`);
  if (options.bashSession) console.log(`  Bash       session=${options.bashSession}${options.requireBashSession ? ' required' : ''}`);
  console.log(`  Connector  ${publicHttps ? 'public HTTPS' : 'local HTTP'}`);
  if (copied.ok) {
    console.log(`  URL        copied with ${copied.command}`);
  } else if (shouldCopy) {
    console.log('  URL        copy failed; copy manually:');
    console.log(serverUrl);
  } else if (options.copyUrl === false && publicHttps) {
    console.log('  URL        not copied; press c to copy or u to show');
  } else if (!publicHttps) {
    console.log('  URL        local HTTP only');
    console.log(serverUrl);
  }
  if (options.openChatgpt) {
    statusLine(opened ? 'ok' : 'warn', opened ? 'Opened ChatGPT connector settings' : 'Could not open ChatGPT automatically');
  }
  console.log('');
  console.log('Next: press Enter to open ChatGPT, paste the copied Server URL, choose Authentication: None.');
  console.log('Keys: Enter open | c copy | o status | h help | q quit');
  return { ...details, copied, opened, mode, toolMode: options.toolMode ?? 'standard' };
}

function printControlHelp() {
  console.log('');
  console.log('Controls');
  console.log('  Enter  open ChatGPT connector settings in your browser');
  console.log('  c      copy Server URL again');
  console.log('  u      print Server URL only');
  console.log('  o      open local setup/status page');
  console.log('  p      print Create App fields');
  console.log('  m      print mode help');
  console.log('  h      show controls');
  console.log('  q      stop GPT Codex Flow');
  console.log('');
}

function printModeHelp() {
  console.log('');
  console.log('Modes');
  console.log('  gcf start                 agent mode: read/write/edit/search/bash');
  console.log('  gcf start --no-bash       agent mode without ChatGPT-triggered shell commands');
  console.log('  gcf start --bash-session main --require-bash-session');
  console.log('  gcf start --mode handoff  planning-only .ai-bridge handoff');
  console.log('  gcf start --mode pro      export context for models without MCP tools');
  console.log('  gcf start --tool-mode minimal   expose only the tight coding loop');
  console.log('  gcf start --tool-mode full      expose every advanced compatibility tool');
  console.log('');
}

function compareMajorVersion(version, minimumMajor) {
  const major = Number(String(version).split('.')[0]);
  return Number.isFinite(major) && major >= minimumMajor;
}

function browserOpenCommand() {
  if (process.platform === 'darwin') return commandExists('open') ? 'open' : '';
  if (process.platform === 'win32') return 'cmd start';
  return commandExists('xdg-open') ? 'xdg-open' : '';
}

function clipboardCommand() {
  if (process.platform === 'darwin') return commandExists('pbcopy') ? 'pbcopy' : '';
  if (process.platform === 'win32') return 'clip';
  for (const command of ['wl-copy', 'xclip', 'xsel']) {
    if (commandExists(command)) return command;
  }
  return '';
}

function localOrPathCommand(command, localPath) {
  if (command && commandAvailable(command)) return command;
  if (localPath && executableFileExists(localPath)) return localPath;
  return '';
}

function doctorLine(status, label, detail = '') {
  const marker = status === 'ok' ? paint('green', 'OK') : status === 'warn' ? paint('yellow', 'WARN') : paint('red', 'FAIL');
  console.log(`${marker} ${label.padEnd(18)} ${detail}`);
}

async function runDoctor(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }

  const root = realDir(args.root ?? envValue('GCF_ROOT') ?? process.cwd());
  const profile = args.noProfile ? {} : loadWorkspaceProfile(root);
  const effectiveArgs = { ...profile, ...args };
  const tunnel = optionValue(args, profile, 'tunnel', ['GCF_TUNNEL'], 'cloudflare');
  const host = optionValue(args, profile, 'host', ['GCF_HOST'], '127.0.0.1');
  const port = String(optionValue(args, profile, 'port', ['GCF_PORT'], '8787'));
  const mode = optionValue(args, profile, 'mode', ['GCF_MODE'], 'agent');
  const bash = optionValue(args, profile, 'bash', ['GCF_BASH_MODE'], 'safe');
  const write = optionValue(args, profile, 'write', ['GCF_WRITE_MODE'], mode === 'agent' ? 'workspace' : 'handoff');
  const toolMode = optionValue(args, profile, 'toolMode', ['GCF_TOOL_MODE'], 'standard');
  const httpPath = path.join(projectRoot, 'dist', 'http.js');
  const serverPath = path.join(projectRoot, 'dist', 'server.js');
  const cloudflaredPath = localOrPathCommand(
    effectiveArgs.cloudflared ?? process.env.CLOUDFLARED_BIN ?? 'cloudflared',
    localCloudflaredPath()
  );
  const clipboard = clipboardCommand();
  const browser = browserOpenCommand();
  const checks = [];

  function record(status, label, detail) {
    checks.push(status);
    doctorLine(status, label, detail);
  }

  console.log('');
  printBox('GPT Codex Flow doctor', [
    labelValue('Workspace', root),
    labelValue('Mode', `${mode}  tools=${toolMode}  write=${write}  bash=${bash}`),
    labelValue('Tunnel', tunnel),
    ...(profile.profilePath ? [labelValue('Profile', profile.profilePath)] : [])
  ]);

  record(compareMajorVersion(process.versions.node, 20) ? 'ok' : 'fail', 'Node', `v${process.versions.node} (requires >=20)`);
  record(fs.existsSync(httpPath) && fs.existsSync(serverPath) ? 'ok' : 'fail', 'Build artifacts', fs.existsSync(httpPath) ? 'dist ready' : 'missing dist/http.js; run npm install && npm run build');
  record(fs.existsSync(path.join(projectRoot, 'package.json')) ? 'ok' : 'fail', 'Package root', projectRoot);
  record(profile.profilePath ? 'ok' : 'warn', 'Saved profile', profile.profilePath ? profileSummary(profile) || profile.profilePath : 'none for this workspace');
  record(clipboard ? 'ok' : 'warn', 'Clipboard', clipboard || 'not found; URL will be printed for manual copy');
  record(browser ? 'ok' : 'warn', 'Browser open', browser || 'not found; open ChatGPT manually');

  try {
    await assertPortAvailable(host, port);
    record('ok', 'Local port', `${host}:${port} available`);
  } catch (error) {
    record('fail', 'Local port', error instanceof Error ? error.message.split('\n')[0] : String(error));
  }

  if (tunnel === 'none') {
    record('ok', 'Tunnel', 'local-only mode');
  } else if (tunnel === 'cloudflare') {
    record(cloudflaredPath ? 'ok' : 'warn', 'cloudflared', cloudflaredPath || 'missing now; gcf start can auto-install unless --no-install-cloudflared is used');
  } else {
    record('fail', 'Tunnel', `unknown tunnel mode: ${tunnel}`);
  }

  const failures = checks.filter((status) => status === 'fail').length;
  const warnings = checks.filter((status) => status === 'warn').length;
  console.log('');
  if (failures) {
    statusLine('warn', `${failures} blocker${failures === 1 ? '' : 's'} and ${warnings} warning${warnings === 1 ? '' : 's'} found.`);
    process.exitCode = 1;
    return;
  }
  statusLine('ok', warnings ? `Ready with ${warnings} warning${warnings === 1 ? '' : 's'}.` : 'Ready.');
}

function normalizeSetupChoice(value, allowed, fallback) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  const match = allowed.find((item) => item === normalized || item.startsWith(normalized));
  return match ?? fallback;
}

async function ask(rl, question, fallback = '') {
  const suffix = fallback ? ` ${paint('dim', `[${fallback}]`)}` : '';
  const hint = fallback ? `${paint('dim', '> Enter to proceed with default')}\n` : '';
  const answer = await rl.question(`${paint('cyan', '?')} ${question}${suffix}\n${hint}> `);
  return answer.trim() || fallback;
}

function printProfile(root, profile) {
  if (!profile.profilePath) {
    printBox('GPT Codex Flow settings', [
      labelValue('Workspace', root),
      'No saved settings for this workspace.',
      'Run gcf settings set to save Cloudflare Quick Tunnel settings.'
    ]);
    return;
  }
  const safe = sanitizedProfile(profile);
  printBox('GPT Codex Flow settings', [
    labelValue('Workspace', root),
    labelValue('Profile', profile.profilePath),
    labelValue('Tunnel', safe.tunnel ?? 'cloudflare'),
    ...(safe.port ? [labelValue('Port', safe.port)] : []),
    ...(safe.mode ? [labelValue('Mode', safe.mode)] : []),
    labelValue('Bash transcript', safe.bashTranscript ?? 'compact'),
    labelValue('Codex sessions', safe.codexSessions ?? 'off'),
    ...(safe.codexDir ? [labelValue('Codex dir', safe.codexDir)] : []),
    ...(safe.bashSession ? [labelValue('Bash session', `${safe.bashSession}${safe.requireBashSession ? ' required' : ''}`)] : []),
    ...(safe.token ? [labelValue('Token', safe.token)] : [])
  ]);
}

function printProfileList(profiles = listWorkspaceProfiles()) {
  if (!profiles.length) {
    printBox('GPT Codex Flow saved setups', [
      'No saved workspace settings found.',
      'Run gcf settings set to create one.'
    ]);
    return;
  }
  printBox('GPT Codex Flow saved setups', profiles.slice(0, 50).map((profile, index) => profileOneLine(profile, index + 1)));
}

function saveSettingsFromArgs(root, args, profile) {
  const tunnel = optionValue(args, profile, 'tunnel', ['GCF_TUNNEL'], profile.tunnel ?? 'cloudflare');
  if (tunnel !== 'cloudflare') throw new Error('Only Cloudflare Quick Tunnel settings are supported.');
  const mode = optionValue(args, profile, 'mode', ['GCF_MODE'], profile.mode ?? 'agent');
  const toolMode = optionValue(args, profile, 'toolMode', ['GCF_TOOL_MODE'], profile.toolMode ?? '');
  const widgetDomain = optionValue(args, profile, 'widgetDomain', ['GCF_WIDGET_DOMAIN'], profile.widgetDomain ?? '');
  const port = String(optionValue(args, profile, 'port', ['GCF_PORT'], profile.port ?? '8787'));
  const bashTranscript = bashTranscriptOption(args, profile);
  const codexSessions = codexSessionsOption(args, profile);
  const codexDir = optionValue(args, profile, 'codexDir', ['GCF_CODEX_DIR'], profile.codexDir ?? '');
  const { bashSession, requireBashSession } = bashSessionOptions(args, profile);
  const token = tunnel === 'none'
    ? optionValue(args, profile, 'token', ['GCF_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], profile.token ?? '')
    : stableToken(optionValue(args, profile, 'token', ['GCF_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], profile.token ?? ''));
  const savedPath = saveWorkspaceProfile(root, {
    port,
    mode,
    tunnel,
    ...(token ? { token } : {}),
    ...(args.bash ?? profile.bash ? { bash: args.bash ?? profile.bash } : {}),
    ...(bashTranscript !== 'compact' ? { bashTranscript } : {}),
    ...(codexSessions !== 'off' ? { codexSessions } : {}),
    ...(codexDir ? { codexDir } : {}),
    ...(bashSession ? { bashSession } : {}),
    ...(requireBashSession ? { requireBashSession: true } : {}),
    ...(args.write ?? profile.write ? { write: args.write ?? profile.write } : {}),
    ...(toolMode ? { toolMode } : {}),
    ...(widgetDomain ? { widgetDomain } : {}),
    ...(args.noInstallCloudflared ?? profile.noInstallCloudflared ? { noInstallCloudflared: true } : {})
  });
  statusLine('ok', `Saved workspace settings: ${savedPath}`);
  printProfile(root, loadWorkspaceProfile(root));
}

async function chooseReusableProfile(rl, currentRoot, profiles = listWorkspaceProfiles()) {
  const reusable = profiles.filter((item) => item.root !== currentRoot);
  if (!reusable.length) return null;
  printProfileList(reusable);
  const answer = await ask(rl, 'Use saved setup number?', reusable.length === 1 ? '1' : '');
  const selectedIndex = Number(answer.trim());
  if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > reusable.length) {
    throw new Error('Invalid saved setup number.');
  }
  return reusable[selectedIndex - 1];
}

async function runSettings(argv) {
  const action = argv[0] && !argv[0].startsWith('--') ? argv[0] : '';
  const args = parseArgs(action ? argv.slice(1) : argv);
  if (args.help) {
    usage();
    return;
  }
  const root = realDir(args.root ?? envValue('GCF_ROOT') ?? process.cwd());
  const profile = args.noProfile ? {} : loadWorkspaceProfile(root);

  if (action === 'list' || action === 'ls') {
    printProfileList();
    return;
  }

  if (action === 'show' || (!action && !process.stdin.isTTY)) {
    printProfile(root, profile);
    return;
  }

  if (action === 'delete' || action === 'reset' || action === 'remove') {
    if (!profile.profilePath) {
      statusLine('warn', 'No saved settings exist for this workspace.');
      return;
    }
    if (!args.yes && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await ask(rl, `Delete saved settings for ${root}?`, 'no');
        if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
          statusLine('warn', 'Settings delete cancelled.');
          return;
        }
      } finally {
        rl.close();
      }
    } else if (!args.yes) {
      throw new Error('Use gcf settings delete --yes in non-interactive shells.');
    }
    deleteWorkspaceProfile(root);
    statusLine('ok', 'Deleted saved settings for this workspace.');
    return;
  }

  if (action === 'set') {
    saveSettingsFromArgs(root, args, profile);
    return;
  }

  if (action === 'use' || action === 'copy') {
    const fromRoot = args.fromRoot ? realDir(args.fromRoot) : '';
    let source = fromRoot ? loadWorkspaceProfile(fromRoot) : null;
    if (fromRoot && !source.profilePath) {
      throw new Error(`No saved settings found for --from-root ${fromRoot}`);
    }
    if (!source) {
      if (!process.stdin.isTTY) throw new Error('Use --from-root in non-interactive shells.');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        source = await chooseReusableProfile(rl, root);
      } finally {
        rl.close();
      }
    }
    if (!source) {
      statusLine('warn', 'No reusable saved settings found.');
      return;
    }
    const savedPath = saveWorkspaceProfile(root, reusableProfilePayload(source));
    statusLine('ok', `Saved workspace settings from ${source.root}: ${savedPath}`);
    printProfile(root, loadWorkspaceProfile(root));
    return;
  }

  if (action && !['change', 'edit'].includes(action)) {
    throw new Error(`Unknown settings action: ${action}`);
  }

  if (!process.stdin.isTTY) {
    printProfile(root, profile);
    return;
  }

  printProfile(root, profile);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const selected = await ask(rl, 'Action: set, use, delete, show, list, or exit?', profile.profilePath ? 'show' : 'set');
    const normalized = normalizeSetupChoice(selected, ['set', 'use', 'delete', 'show', 'list', 'exit'], profile.profilePath ? 'show' : 'set');
    if (normalized === 'exit') return;
    if (normalized === 'list') {
      printProfileList();
      return;
    }
    if (normalized === 'show') {
      printProfile(root, profile);
      return;
    }
    if (normalized === 'use') {
      const source = await chooseReusableProfile(rl, root);
      if (!source) {
        statusLine('warn', 'No reusable saved settings found.');
        return;
      }
      const savedPath = saveWorkspaceProfile(root, reusableProfilePayload(source));
      statusLine('ok', `Saved workspace settings from ${source.root}: ${savedPath}`);
      printProfile(root, loadWorkspaceProfile(root));
      return;
    }
    if (normalized === 'delete') {
      if (!profile.profilePath) {
        statusLine('warn', 'No saved settings exist for this workspace.');
        return;
      }
      const answer = await ask(rl, `Delete saved settings for ${root}?`, 'no');
      if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
        statusLine('warn', 'Settings delete cancelled.');
        return;
      }
      deleteWorkspaceProfile(root);
      statusLine('ok', 'Deleted saved settings for this workspace.');
      return;
    }

    saveSettingsFromArgs(root, args, profile);
  } finally {
    rl.close();
  }
}

function writeControlPrompt() {
  process.stdout.write('gcf> ');
}

function runControlPanel(details) {
  if (!process.stdin.isTTY) return new Promise(() => {});

  writeControlPrompt();

  process.stdin.setEncoding('utf8');
  if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise(() => {
    process.stdin.on('data', (key) => {
      if (key === '\u0003') {
        console.log('\nStopping GPT Codex Flow...');
        cleanupChildren();
        process.exit(130);
      }
      const normalized = key.toLowerCase();
      if (key === '\r' || key === '\n') {
        const opened = openUrl(details.chatgptSettingsUrl);
        console.log(opened ? '\nOpened ChatGPT connector settings. The Server URL is already copied; paste it into Server URL.' : '\nCould not open ChatGPT automatically.');
        writeControlPrompt();
      } else if (normalized === 'c') {
        const copied = copyToClipboard(details.serverUrl);
        console.log(copied.ok ? `\nServer URL copied with ${copied.command}.` : '\nCould not copy automatically.');
        writeControlPrompt();
      } else if (normalized === 'u') {
        console.log(`\n${details.serverUrl}`);
        writeControlPrompt();
      } else if (normalized === 'o') {
        if (!details.localStatusUrl) {
          console.log('\nNo local status page URL is available for this run.');
        } else {
          const opened = openUrl(details.localStatusUrl);
          console.log(opened ? '\nOpened local GPT Codex Flow setup/status page.' : `\nCould not open automatically. Open this URL:\n${details.localStatusUrl}`);
        }
        writeControlPrompt();
      } else if (normalized === 'p') {
        console.log('');
        printCreateAppFields(details);
        console.log('');
        writeControlPrompt();
      } else if (normalized === 'm') {
        printModeHelp();
        console.log('');
        writeControlPrompt();
      } else if (normalized === 'h' || normalized === '?') {
        printControlHelp();
        writeControlPrompt();
      } else if (normalized === 'q') {
        console.log('\nStopping GPT Codex Flow...');
        cleanupChildren();
        process.exit(0);
      }
    });
  });
}

async function main() {
  let argv = process.argv.slice(2);
  let subcommand = argv[0];
  if (subcommand === 'settings' || subcommand === 'config') {
    await runSettings(argv.slice(1));
    return;
  }
  if (subcommand === 'init') {
    runProjectInit(argv.slice(1));
    return;
  }
  if (subcommand === 'execute-handoff' || subcommand === 'execute' || subcommand === 'run-handoff') {
    await runExecuteHandoff(argv.slice(1));
    return;
  }
  if (subcommand === 'watch-handoff' || subcommand === 'watch') {
    await runWatchHandoff(argv.slice(1));
    return;
  }
  if (subcommand === 'pro-bundle' || subcommand === 'bundle') {
    runHelperScript('pro-bundle.mjs', argv.slice(1));
  }
  if (subcommand === 'pro-apply' || subcommand === 'apply') {
    runHelperScript('pro-apply.mjs', argv.slice(1));
  }
  if (subcommand === 'install-cloudflared') {
    const installArgs = parseArgs(argv.slice(1));
    if (installArgs.help) {
      usage();
      return;
    }
    const installedCloudflared = await installCloudflaredLocal();
    console.log(`cloudflared ready: ${installedCloudflared}`);
    return;
  }
  if (subcommand === 'doctor') {
    await runDoctor(argv.slice(1));
    return;
  }
  if (argv[0] === 'start' || argv[0] === 'connect') argv.shift();
  if (argv[0] === 'help') argv[0] = '--help';
  if (argv[0] && !argv[0].startsWith('--')) throw new Error('Unsupported command. Use gcf ui for connection setup.');
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }

  const root = realDir(args.root ?? envValue('GCF_ROOT') ?? process.cwd());
  const profile = args.noProfile ? {} : loadWorkspaceProfile(root);
  const effectiveArgs = { ...profile, ...args };
  if (profile.profilePath && !args.noProfile) {
    statusLine('ok', `Using saved profile: ${profile.profilePath}`);
    const summary = profileSummary(profile);
    if (summary) statusLine('ok', `${summary}. Future launches from this folder only need: gcf start`);
  }

  const tunnel = optionValue(args, profile, 'tunnel', ['GCF_TUNNEL'], 'cloudflare');
  if (!['none', 'cloudflare'].includes(tunnel)) {
    throw new Error('Only Cloudflare Quick Tunnel is supported; none is reserved for internal local HTTP tests.');
  }
  if (args.noAuth && tunnel !== 'none') {
    throw new Error('--no-auth is only allowed with --tunnel none. Public tunnels require GCF_HTTP_TOKEN.');
  }
  const mode = optionValue(args, profile, 'mode', ['GCF_MODE'], 'agent');
  if (!['agent', 'handoff', 'pro'].includes(mode)) {
    throw new Error('--mode must be agent, handoff, or pro');
  }

  const allowRoots = [root, ...(args.allowRoots ?? [])].map(realDir);
  const host = optionValue(args, profile, 'host', ['GCF_HOST'], '127.0.0.1');
  const port = String(optionValue(args, profile, 'port', ['GCF_PORT'], '8787'));
  const bash = optionValue(args, profile, 'bash', ['GCF_BASH_MODE'], 'safe');
  const bashTranscript = bashTranscriptOption(args, profile);
  const codexSessions = codexSessionsOption(args, profile);
  const codexDir = resolveCodexDir(root, optionValue(args, profile, 'codexDir', ['GCF_CODEX_DIR'], ''));
  const { bashSession, requireBashSession } = bashSessionOptions(args, profile);
  const write = optionValue(args, profile, 'write', ['GCF_WRITE_MODE'], mode === 'agent' ? 'workspace' : 'handoff');
  const toolMode = optionValue(args, profile, 'toolMode', ['GCF_TOOL_MODE'], 'standard');
  const widgetDomain = optionValue(args, profile, 'widgetDomain', ['GCF_WIDGET_DOMAIN'], 'https://naplesblue.github.io');
  if (!['off', 'safe', 'full'].includes(bash)) throw new Error('--bash must be off, safe, or full');
  if (!['off', 'handoff', 'workspace'].includes(write)) throw new Error('--write must be off, handoff, or workspace');
  if (!['minimal', 'standard', 'full'].includes(toolMode)) throw new Error('--tool-mode must be minimal, standard, or full');

  let token = args.noAuth ? '' : optionValue(args, profile, 'token', ['GCF_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], '');
  if (!token && tunnel !== 'none') token = stableToken();

  const serverEnv = {
    ...process.env,
    GCF_ROOT: root,
    GCF_ALLOWED_ROOTS: allowRoots.join(path.delimiter),
    GCF_HOST: host,
    GCF_PORT: port,
    GCF_BASH_MODE: bash,
    GCF_BASH_TRANSCRIPT: bashTranscript,
    GCF_BASH_SESSION_ID: bashSession,
    GCF_REQUIRE_BASH_SESSION: requireBashSession ? '1' : '0',
    GCF_CODEX_SESSIONS: codexSessions,
    GCF_WRITE_MODE: write,
    GCF_TOOL_MODE: toolMode,
    GCF_WIDGET_DOMAIN: widgetDomain,
    GCF_MODE: mode,
    GCF_TUNNEL_MODE: tunnel === 'none' ? '0' : '1'
  };
  if (codexDir) serverEnv.GCF_CODEX_DIR = codexDir;
  if (args.logRequests || envValue('GCF_LOG_REQUESTS') === '1') serverEnv.GCF_LOG_REQUESTS = '1';
  if (args.allowHome) serverEnv.GCF_ALLOW_HOME = '1';
  if (token) serverEnv.GCF_HTTP_TOKEN = token;
  else delete serverEnv.GCF_HTTP_TOKEN;

  if (args.printEnv) {
    console.log(JSON.stringify({ ...serverEnv, GCF_HTTP_TOKEN: token ? '<redacted>' : undefined }, null, 2));
  }

  const httpPath = path.join(projectRoot, 'dist', 'http.js');
  if (!fs.existsSync(httpPath)) {
    throw new Error(`Missing ${httpPath}. Run npm install && npm run build first.`);
  }

  await assertPortAvailable(host, port);

  printBox('GPT Codex Flow start', [
    labelValue('Workspace', root),
    labelValue('Mode', `${mode}  tools=${toolMode}  write=${write}  bash=${bash}`),
    labelValue('Bash transcript', bashTranscript),
    labelValue('Codex sessions', codexSessions),
    ...(bashSession ? [labelValue('Bash session', `${bashSession}${requireBashSession ? ' required' : ''}`)] : []),
    labelValue('Local URL', `http://${host}:${port}/mcp`),
    labelValue(
      'Tunnel',
      tunnel === 'cloudflare' ? 'Cloudflare Quick Tunnel' : 'internal local HTTP'
    )
  ]);

  const verboseLogs = Boolean(args.logRequests || envValue('GCF_LOG_REQUESTS') === '1');
  statusLine('wait', 'Starting local MCP server');
  const server = spawnLogged('gcf', process.execPath, [httpPath], { cwd: projectRoot, env: serverEnv, verbose: verboseLogs });
  let cloudflared;
  const cleanup = cleanupChildren;
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  const localBase = `http://${host}:${port}`;
  await waitForHealth(`${localBase}/healthz`, token);
  statusLine('ok', `Local MCP ready at ${localBase}/mcp`);
  const runtimeOptions = {
    localBase,
    tunnel,
    mode,
    toolMode,
    write,
    bash,
    bashTranscript,
    codexSessions,
    bashSession,
    requireBashSession
  };

  if (tunnel === 'none') {
    // Retained for local transport fixtures; public setup uses Quick Tunnel only.
    saveRuntimeConnection(root, createConnectorDetails(`${localBase}/mcp`, token, localBase), runtimeOptions);
    await waitForProcessExit(server);
    return;
  }

  const cloudflaredPath = await resolveCloudflared(effectiveArgs);
  if (!cloudflaredPath) throw new Error('cloudflared is required for Cloudflare Quick Tunnel. Install it and retry.');

  if (tunnel === 'cloudflare') {
    statusLine('wait', 'Opening Cloudflare quick tunnel');
    cloudflared = spawnLogged('cloudflared', cloudflaredPath, ['tunnel', '--url', localBase], { cwd: root, env: process.env, verbose: verboseLogs });
    const publicBase = await waitForCloudflareUrl(cloudflared);
    const details = printConnectorBlock(`${publicBase}/mcp`, token, {
      localBase,
      copyUrl: args.noCopyUrl ? false : true,
      openChatgpt: Boolean(args.openChatgpt),
      mode,
      toolMode,
      root,
      write,
      bash,
      bashTranscript,
      codexSessions,
      bashSession,
      requireBashSession
    });
    saveRuntimeConnection(root, details, runtimeOptions);
    await runControlPanel(details);
    return;
  }
}

main().catch((error) => {
  cleanupChildren();
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  if (envValue('GCF_DEBUG') === '1' && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
