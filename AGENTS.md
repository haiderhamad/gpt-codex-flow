# GPT Codex Flow — Repository Agent Instructions

These rules apply to ChatGPT, Codex, and other coding agents working in this repository. This is the **GPT Codex Flow** project, not any unrelated software project.

## Skills and agents
- Read repository instructions first. If an optional global `~/.codex/AGENTS.md` exists, read it as supplemental personal guidance; **do not require a user-specific absolute path**. The repository works without global Skills or Agents.
- Discover relevant installed `SKILL.md` resources from `.codex/skills/`, `.agents/skills/`, `~/.codex/skills/`, `~/.agents/skills/`, or agent tooling actually available. Read chosen Skills before use. A Skill is instructional content, not an executable agent.
- Delegate bounded independent tasks to native subagents when available and useful, retaining integration, code review, safety, and test ownership. If an optional `aas` MCP server is connected, discover individual relevant Skills using its actual exposed search/read actions; do not assume it exists or install whole catalogs.
- Avoid copying private global Skills, account credentials, or machine-local profile state into this repository.

## Required reading order
1. This `AGENTS.md` and any applicable nested instructions.
2. `docs/GCF_FEATURES_SOURCE_OF_TRUTH.md` (capability/evidence; may contain historical snapshots).
3. `docs/GCF_PROJECT_STATUS.md` (status and accepted scope).
4. `docs/GCF_PROJECT_HISTORY.md` (architectural decisions and superseded approaches).
5. `SECURITY.md` and `docs/GCF_NATIVE_SANDBOX_V1_DECISION.md` for current security evidence and limits.
6. `README.md` and `CONTRIBUTING.md` for portable source setup, publishing workflow and release boundaries. Historical one-off publication prompts are not required for a fresh clone.
7. Relevant real source, tests, package scripts, Git status and import/reference graph. **Live code + tests take precedence over stale narrative.**

## Product intent and architecture
- GPT Codex Flow connects ChatGPT, local Codex CLI, project-scoped Git workspaces, MCP tools, Task Inbox and bidirectional Transfer Control.
- **Both ChatGPT and Codex can code**: implement, edit, debug, refactor, review, plan, and run permitted tests. Never reduce ChatGPT to a planning/review-only role. ChatGPT coding requires authenticated/allowed workspace write/test tools and its available account session.
- Lead recommendations (`chatgpt_lead`, `codex_lead`, `auto`) are **advisory**, separate from execution policy (Supervised, owner-launched Local Auto, owner-interactive Full Access). Codex reported quota/context exhaustion is not an automatically verified provider quota or a way to bypass limits.
- `src/`: actual TypeScript MCP, HTTP transport and owner-local Control Center runtime. `scripts/`: operational CLIs, tests, and clearly distinguished experimental security fixtures. `docs/gcf-preview/`: public static Landing only. `src/gcfControlCenterPage.ts`: owner-local Control Center; the retired HTTP Admin UI is not shipped. `.ai-bridge/` and global user configuration contain private runtime data and are **not** public source.
- Preserve simple local-first Node/TypeScript architecture and existing functional code; avoid new frameworks, unneeded services, microservices, deep abstractions, and rewrites without measurable benefit.
- Scope project roots explicitly. Do not turn an untrusted HTTP/MCP instruction or role label into privileged native execution. Default remote privileges remain restricted. Signed Owner Broker/XPC experiments were removed from the v1 working tree on 2026-10-22. Use bounded Codex native sandbox for Codex-launched work; do not claim it confines independent MCP file/Bash tools or authenticates the operator. Unattended privileged execution is out of scope.

## Engineering workflow
Use **Understand → Inspect → Design → Implement → Test → Review → Document** proportionally to the task.
- Inspect the dirty Git worktree before changing code. Preserve all prior uncommitted/untracked work. Never `git clean`, `git reset --hard`, mass-delete, force-push, silently commit or overwrite unrelated changes.
- Keep functions small, names explicit, decisions justified, dependencies minimal, and security errors fail-closed.
- For each meaningful change, run and report suitable checks (examples): `npm run build`, `npm run test:gcf-core`, `npm run test:orchestration`, `npm run test:transfer`, `npm run test:gcf-auto-worker`, `npm run test:ui`, `npm run test:gcf-landing`, `npm run test:gcf-visual`, `npm run test:gcf-package-audit`, `git diff --check`. Use other targeted tests as warranted; report commands not actually run as NOT VERIFIED.
- Update meaningful product state in `docs/GCF_PROJECT_STATUS.md`; record durable architecture decisions in `docs/GCF_PROJECT_HISTORY.md` or a clearly linked decision record; update user-facing README/installation when behavior changes. Preserve VERIFIED vs IMPLEMENTED vs PROPOSED vs BLOCKED. Do not append whole chat transcripts to the public repository.
- No agent may automatically publish, push, release, deploy, delete historical data, or approve a Mac wipe. Request explicit owner approval for destructive changes or public actions.

## Public GitHub source vs npm tarball vs GitHub Pages
These are **three distinct artifacts**:
1. **Public Git source** must contain all editable source, active scripts, tests, package/lockfile, project configuration, curated docs, `AGENTS.md`, LICENSE, README and the static site. Someone should be able to `git clone`, `npm ci`, `npm run build`, and continue development on a new Mac.
2. **npm distribution** should contain only proven runtime dependency closure, compiled output when needed, license, and appropriate usage docs. Do not publish historical debug fixtures, private data or broad source-tree experiments by default.
3. **GitHub Pages** should serve only approved static public Landing assets under `docs/gcf-preview/`, never the local Admin/MCP server, machine logs, tokens or Task Inbox.

Before Git publication, audit untracked/ignored AND tracked files, references, symlinks and credential-like content. Keep source/tests that are genuinely required; archive unique historical notes privately if they have no public value. Do not equate `.gitignore` with removing already tracked files. Do not commit `.env*`, `.ai-bridge/`, `~/.codexbridge`, login state, tokens, personal absolute paths, unredacted logs, local screenshots or `output/`; explicitly review sanitized public screenshots.

## New-Mac reproducibility (release gate)
The owner intends to continue developing on a different Mac. After the exact source candidate is committed with owner approval and uploaded to its confirmed destination, independently clone the *remote* commit in a disposable directory and run `npm ci`, `npm run build`, relevant tests and local MCP setup/verification. Document portable setup in `README.md` and public source/npm/Pages boundaries in `CONTRIBUTING.md` and `SECURITY.md`. Git does not backup ignored private data, credentials, uncommitted work, or global Skills/Agents; recommend a separate encrypted backup if needed. **Never certify it is safe to erase the old Mac without verifying the remote and required independent backups.**

## UI and documentation quality
Maintain GCF's off-white/pale-blue and restrained cyan visual system. Both engineering participants must appear as capable of coding in architecture diagrams. Use real browser desktop/tablet/mobile review and reduced-motion/accessibility checks when changing Landing/Admin. Use the current root README, verified install commands, honest claims and upstream MIT license attribution; never publish fabricated links, badges or model/agent abilities.

## Task handoff
Summarize changed paths, tests actually run and their exit codes, open limitations, approval requests and next reproducible action. Do not claim a commit/push/release happened unless independently verified.
