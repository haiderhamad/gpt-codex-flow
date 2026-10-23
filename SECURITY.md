# Security Policy

**GPT Codex Flow standalone source-first candidate.** The source is not yet published; npm remains private. Local GCF launcher defaults to explicit approved roots, `--write off` and `--bash off`. Cloudflare Quick Tunnel is the only supported user-facing remote connection; local HTTP/stdio remain internal transports. Low-level CodexBridge entrypoints may have broader defaults. For interactive owner-attended native Codex tasks, use scoped preview/consent and verify diffs; **signed Owner Broker/XPC is not part of v1**; its old replay-prone experiment files were removed from the working tree. Codex native `workspace-write` sandbox applies to Codex-launched work only, not direct MCP Bash/write; privileged unattended execution is unsupported. A local owner-approved Codex CLI acceptance and manual ChatGPT ↔ Codex handoff passed in their recorded scope, not OS attestation, model identity, automatic provider quota monitoring, or autonomous session switching.

The material below documents the inherited transport and security controls. Follow [README.md](README.md) for installation, Cloudflare setup and verification; do not infer that legacy broad modes are GCF's safe defaults.

CodexBridge exposes a local workspace to an MCP client. Treat it like a developer tool with access to your source tree, not like a hosted SaaS app.

## Supported Version

This is a source-first release candidate. Security fixes target the current maintained source; no published npm release is certified.

## Reporting

Please report security issues privately before opening a public issue. If the repository has GitHub private vulnerability reporting enabled, use that. Otherwise contact the maintainer listed by the project owner.

Do not include secrets, private repository contents, tunnel tokens, or `.env` values in reports.

## Terms Boundary

CodexBridge is not designed to bypass, avoid, pool, resell, or modify ChatGPT, Codex, OpenAI, or third-party model limits. Do not market, deploy, or configure it that way.

Each user should connect their own ChatGPT account, use only product surfaces available to that account, and follow the limits, safety rules, and terms for ChatGPT, Codex, OpenAI, and any third-party model provider they connect.

## Threat Model

CodexBridge can expose:

- file metadata and selected file contents from allowed workspaces
- git status and diffs
- `.ai-bridge` planning files
- optional shell command execution through the `bash` tool
- optional write/edit capability depending on `CODEXBRIDGE_WRITE_MODE`
- optional local handoff execution through `codexbridge execute-handoff`, run from the user's terminal only

The main risks are:

- connecting an untrusted MCP client
- exposing the server through a public tunnel without auth
- running with `CODEXBRIDGE_BASH_MODE=full`
- running remote commands with `CODEXBRIDGE_SSH_MODE=full`
- running with `CODEXBRIDGE_WRITE_MODE=workspace` on an important repo
- executing an untrusted `.ai-bridge/current-plan.md` or custom `execute-handoff --command`
- adding overly broad allowed roots
- leaking the private connection URL or its `codexbridge_token`
- trusting a downloaded `cloudflared` binary without understanding where it came from

## Safer Defaults

Use the owner-local Control Center (`npm run gcf:ui`) to approve exact folders and
choose Cloudflare Quick Tunnel access. Read Only protects source files while
allowing advisory handoff notes inside `.ai-bridge/`; these notes grant no execution
permission. Edit Files, Edit & Test and Full Access are separate explicit choices.

For manual Quick Tunnel setup, prefer source write off and Bash off, or enable
only handoff notes:

```bash
npm run connect:cloudflare -- --no-profile --root /path/to/repo --write handoff --bash off
```

Keep the Terminal open while connected. Quick Tunnel URLs change after restart;
stop the process to disconnect. The private connection URL carries a bearer token.
Selecting “No authentication” in the client does not remove GCF's token validation.

## Hard Rules

- Do not run public tunnels with `--no-auth`.
- Public tunnel mode and non-loopback binds fail closed if `CODEXBRIDGE_HTTP_TOKEN` is missing.
- Do not commit printed connector URLs that include `codexbridge_token`.
- Never paste the private connection URL into screenshots, chat, tickets or logs.
- Use only Quick Tunnels; saved profiles for retired providers must be recreated.
- Use `--mode handoff` for planning workflows where ChatGPT should not edit source files.
- Preview local handoff execution with `codexbridge execute-handoff --dry-run` before running an unfamiliar adapter or custom command.
- Keep `execute-handoff` local. Do not wrap it in a remote MCP tool unless you add a stronger approval and sandbox story.
- Use SSH profiles only for hosts you control. Run `ssh_exec` with `dry_run: true` first, keep `CODEXBRIDGE_SSH_MODE=safe` by default, and do not rely on CodexBridge to handle passwords, sudo prompts, or interactive remote shells.
- Use `task_brief`, `task_plan`, and `approval_review` for Codex-quota fallback work so ChatGPT sees explicit repo context, command policy, and local-write approval scope before applying changes.
- Treat `preview_rollback_change_set` as a review aid for exact edit changes, not as a substitute for git history or backups.
- Use default agent mode only with trusted ChatGPT sessions and repo-specific roots.
- Use `--no-bash` when ChatGPT should never trigger shell commands in the workspace.
- Use `--bash-session <id> --require-bash-session` when bash should be enabled only for calls that explicitly target this local CodexBridge terminal label.
- Keep Codex session history access off unless needed. `--codex-sessions metadata` only lists local Codex JSONL metadata; `--codex-sessions read` allows bounded transcript reads.
- Use `--bash full` only for trusted local repos.
- Do not treat MCP session ids or bash session labels as Codex conversation ids. CodexBridge does not execute inside a Codex app session.
- Prefer a repo-specific `--root` instead of `--allow-home`.
- Use `--no-install-cloudflared --cloudflared <path>` if your organization requires a managed Cloudflare Tunnel binary.

## Cloudflare Binary Install

For the one-command public tunnel flow, CodexBridge can download the official Cloudflare `cloudflared` release into `~/.codexbridge/bin` on supported macOS, Windows, and Linux systems. It does not install a system service, does not use sudo/admin rights, and does not modify shell startup files.

Resolution order:

```text
1. explicit --cloudflared path or CLOUDFLARED_BIN
2. cloudflared already available in PATH
3. ~/.codexbridge/bin/cloudflared or cloudflared.exe
4. download official Cloudflare latest release unless --no-install-cloudflared is set
```

Use `--install-cloudflared` to refresh the local binary. Use `--no-install-cloudflared` to disable downloads.

## Built-In Guards

CodexBridge blocks common sensitive paths by default:

- `.env` and `.env.*`
- `.git` internals
- `node_modules`
- common private key names
- build/cache folders such as `dist`, `build`, `.next`, `coverage`, `.cache`
- symlinks that resolve outside the workspace or into blocked paths
- safe bash commands through a shared command policy; unlisted, destructive, network, shell-expansion, and file-reader commands are denied by default
- transactional change sets with preview, base-hash validation, and rollback for files already written if a later write fails
- a bounded `.ai-bridge/operation-journal.jsonl` audit trail for successful write/edit/bash/change-set operations
- Task records (`.ai-bridge/current-task.json` and `.ai-bridge/tasks/`) store the goal and plan you give `task_plan`. They are written through the same path guard as the operation journal and never leave the workspace; do not put secrets in task goals or plan steps.

These guards reduce risk. They are not an OS sandbox.

## Security boundaries for source releases

- **Host and request authentication:** legacy tokenless loopback HTTP must validate the exact raw local Host and port even when the Origin header is missing; binding to `127.0.0.1` alone does not defeat DNS rebinding. Do not trust `X-Forwarded-Host`. Public Quick Tunnel MCP uses an independent bearer token, while the owner Control Center remains on a separate, authenticated local listener. Verify Host/Origin/auth/CSRF negative tests against the intended code revision.
- **No privileged identity guarantee:** local files, claimed `user_confirmed` fields, role signatures, or signed reports backed by agent-editable enrollment cannot establish an authenticated owner or a distinct ChatGPT/Codex principal. The retired Broker/XPC prototype reproduced a rollback flaw; it was removed, not certified fixed. The native Codex sandbox does not confine direct MCP editing or Bash tools.
- **Release hygiene:** inspect the exact intended Git tree, including untracked files, history, links, symlinks, local paths and screenshots. Source-pattern scans and an npm pack dry-run cover only their specified candidate; they do **not** prove that prior Git objects, screenshot pixels, binary data, or arbitrary encoded secrets are safe. Keep `.ai-bridge/`, `.env*`, `~/.codexbridge/`, credentials, output and ignored owner state out of public source; verify any sanitized demo pixels manually.
- **Publication boundary:** the public Git source requires editable `src/`, its tests and scripts, a lockfile, license/attribution, and docs/static assets actually referenced by the README. An npm package has a separately audited minimal runtime allowlist; its `private: true` flag is intentional until authorized publication. GitHub Pages must contain **only static `docs/gcf-preview/` assets**, never the Control Center, MCP runtime, tokens, or Task Inbox.
- **Independent acceptance:** following an explicitly approved push, verify the exact remote revision with a fresh clone, `npm ci`, build, security and UI tests before claiming reproducibility. A successful local dirty-tree test or an offline `ENOTCACHED` packaging result is not proof of a clean remote install. Git does not transfer ignored/private state or uncommitted changes; back up and restore these separately before retiring a development machine.

The historical 18 October security review covered a specific earlier dirty checkout. Its initial failures and fixes are **dated evidence**, not proof of new vulnerabilities or successful certification of later revisions. Live source and current negative tests take precedence.
