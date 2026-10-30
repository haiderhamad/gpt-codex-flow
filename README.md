<p align="center"><img src="docs/gcf-preview/brand-mark.svg" width="72" alt="GPT Codex Flow logo"></p>
<h1 align="center">GPT Codex Flow</h1>
<p align="center"><strong>Two coding assistants. One project workflow.</strong></p>
<p align="center">Connect ChatGPT to approved local projects, hand off tasks to Codex, and review changes in Git.</p>
<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 20 or newer">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/MCP-supported-267C91" alt="Model Context Protocol (MCP)">
  <a href="package.json"><img src="https://img.shields.io/badge/Version-v1.0.0-267C91" alt="Unreleased source candidate v1.0.0"></a>
  <a href="https://haiderhamad.github.io/gpt-codex-flow/"><img src="https://img.shields.io/badge/Website-GitHub%20Pages-267C91?logo=githubpages&logoColor=white" alt="Visit GPT Codex Flow website"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-546A7B" alt="MIT license"></a>
</p>
<p align="center"><a href="https://haiderhamad.github.io/gpt-codex-flow/">Official Website</a> · <a href="#quick-start">Quick Start</a> · <a href="#features">Features</a> · <a href="#security">Security</a> · <a href="#troubleshooting">Troubleshooting</a></p>

<p align="center"><img src="docs/gcf-preview/architecture-overview.gif" width="640" height="460" alt="Illustrative loop: ChatGPT hands a task through GPT Codex Flow to Codex App and CLI, then a result returns through GCF"></p>

## Quick start

Install GPT Codex Flow, start the local **Control Center**, then connect ChatGPT to the project folders you approve. Project files remain on your computer; ChatGPT can receive file contents through authorized MCP requests according to the access level you select.

### 1. Prerequisites

- **Node.js 20+** with npm, and **Git**. Check in Terminal with `node --version`, `npm --version` and `git --version`.
- **[cloudflared](https://developers.cloudflare.com/tunnel/downloads/)** installed and available on your PATH (`cloudflared --version`). Cloudflare Quick Tunnel requires an internet connection, but **not** a Cloudflare account or domain.
- A ChatGPT account/workspace that supports adding a **custom MCP server**. This availability depends on the account and workspace.
- **Optional:** an installed, signed-in Codex CLI if you want to run local Codex tasks. It is not needed merely to start the Control Center.

### 2. Installation

Clone the repository, enter its folder, and install dependencies:

```bash
git clone https://github.com/haiderhamad/gpt-codex-flow.git
cd gpt-codex-flow
npm ci
```

Run these commands in Terminal. `npm ci` uses the repository's `package-lock.json`, so it must run **inside the cloned `gpt-codex-flow` folder**, not from your home directory (`~`).

### Optional: install or update Codex CLI

**Codex CLI is not needed** to start the Control Center or connect ChatGPT. Install it only if you want to execute owner-approved local Codex handoffs. For an npm-managed installation (new or existing), use:

```bash
npm install -g @openai/codex@latest
codex --version
codex
```

The final `codex` command opens its interactive sign-in flow; follow the prompts to sign in with an account that can use Codex. On macOS, if your existing Codex installation is managed through Homebrew instead, use `brew install --cask codex` for the first installation or `brew upgrade --cask codex` to update it. **Use the same package manager as your existing installation** rather than creating conflicting copies. See the [official Codex install instructions](https://github.com/openai/codex#installing-and-running-codex-cli). GCF does not install or update Codex automatically, and selecting a Lead or saving a model preference does not launch Codex.

### 3. Start the Control Center

From the same `gpt-codex-flow` folder, run:

```bash
npm run gcf:ui
```

This command builds the project and starts a **local-only** Control Center. It normally opens your browser automatically. Terminal shows a local URL and a **one-use unlock code (valid for 5 minutes)**. Paste that code into the browser unlock screen. **Keep the Terminal open** for the Control Center to remain running. The owner session expires after inactivity. Starting the Control Center does **not** start a public tunnel, register ChatGPT or run Codex.

### 4. Add a project

In the Control Center, open **Projects**, choose **Add Folder**, select the folder you want ChatGPT to access, review the local confirmation, and approve it. The folder is not copied or uploaded. For a first test, choose an ordinary development/test folder and start with **Read Only** source access. Non-Git folders are supported; Git-specific diffs and handoffs need a Git repository. Removing a project from the Control Center does **not** delete the underlying folder.

### 5. Connect ChatGPT

**Cloudflare Quick Tunnel is the only supported user-facing connection.** It is a temporary development/testing tunnel, not production hosting; Cloudflare does not guarantee uptime ([Cloudflare Quick Tunnel docs](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)). Go to **Connections → Connect ChatGPT** in the Control Center:

1. Select your approved project(s) and the connection access level; start with **Read Only**.
2. Choose **Start Cloudflare** and approve the **local** confirmation. Wait until the Control Center shows **Cloudflare tunnel ready**.
3. Click **Copy Connection URL**. It contains a **secret access token**. Never paste the URL into a chat, issue, screenshot or Git repository.
4. In ChatGPT, go to the area for **custom MCP server / app connections** (menu names vary by account), add a server using the copied URL, and select **No authentication** *for the ChatGPT connection setup*. GCF itself still authenticates requests using the secret embedded in the URL.
5. In a new ChatGPT conversation with the connection enabled, ask it to call `list_projects`, select the specific approved project, and call `project_summary`. Verify it sees **only** the folders you selected. A ready tunnel by itself is not proof that ChatGPT connected.

**Disconnect:** Click **Disconnect** in the Control Center, then press `Ctrl+C` in Terminal to stop the local app. The next Cloudflare Quick Tunnel may use a new private URL; update your ChatGPT connection if it changes. No additional HTTP server setup is needed.

### Access levels

| Connection level | Source files | Terminal commands | Handoff notes |
| --- | --- | --- | --- |
| **Read Only** (recommended first) | Read only | Off | Allowed in scoped `.ai-bridge/` metadata |
| **Edit Files** | Read/write in approved folders | Off | Allowed |
| **Edit & Test** | Read/write in approved folders | Safe allowlisted Bash | Allowed |
| **Full Access** (manual Advanced only; high risk) | Read/write | Full Bash | Allowed |

**Full Access is not available through the one-click Cloudflare UI.** Use only the permissions required for your task. **Handoff notes remain writable in every access level**, including Read Only, but notes do not grant code editing or command execution. ChatGPT's approvals do not override the permission level selected here.

<p align="center"><img src="docs/gcf-preview/screenshots/control-center-demo.png" width="800" alt="Example of the GPT Codex Flow local Control Center"></p>

## Optional agent-assisted Notion project memory

**Optional and off by default.** Notion Memory is agent-assisted documentation for durable project decisions and architecture, **not** GCF Task Inbox or Handoff. It works with new projects, existing folders being added, and already registered projects. Existing code, Git history, `AGENTS.md` and `.ai-bridge/` handoffs are not overwritten.

<p align="center"><img src="docs/gcf-preview/notion-memory-flow.svg" width="880" alt="Optional Notion Memory architecture: ChatGPT and Codex exchange tasks through GPT Codex Flow and approved local projects; either separately authorized client can document durable knowledge in Notion. Dashed connections indicate opt-in documentation, not automatic sync or task handoff."></p>

*The dashed connections are optional, client-authorized knowledge updates. GCF Task Inbox and Handoff remain independent.* [View the diagram full-size](docs/gcf-preview/notion-memory-flow.svg).

**Enable:** In **Control Center → Projects**, select an approved folder and **Enable Notion Memory**, then confirm locally; you can also opt in when adding a folder. GCF safely creates `NOTION_MEMORY.md` only if absent and never edits your existing `AGENTS.md`. Alternatively, copy the optional instructions from **Connections → ChatGPT Project Instructions** into `AGENTS.md` yourself. For Codex to discover the local template while GCF is disconnected, copy the short `AGENTS.md` pointer shown there. These files are instructions, **not** proof of a Notion connection or saved page.

**Connect and reuse:** Authorize the **official Notion integration separately** in your ChatGPT/Codex client. In `NOTION_MEMORY.md`, set an existing `notion_page_url` or an owner-approved `notion_parent_url`. The agent searches the approved scope by project name **and repository identity** and reuses the single canonical hub. If no page exists, creation requires explicit project-specific approval; ambiguous matches require your choice. It reads the current README/code first, writes only concise verified knowledge, and checks the Notion result before claiming success.

**Readable for people and AI:** Keep one short project overview and only useful pages for architecture, decisions and verified evidence. Include reasons, dates and relative source paths; use an optional **Mermaid diagram** when it genuinely clarifies a verified flow. Improve older pages in place, never duplicate a hub or delete content. Material restructuring needs owner approval and a verified archival copy. See the [Project Hub Layout](.agents/skills/gcf-notion-memory/references/PROJECT_HUB_LAYOUT.md).

**How updates work:** During an active, authorized agent session, the instructions guide the agent to maintain **lasting, verified milestones**, not every chat or test. There is **no automatic background sync**. If Notion is unavailable after opt-in, GCF work continues and only documentation is marked `NOTION_SYNC_PENDING`; without opt-in, no sync warning appears. After upgrades, re-copy ChatGPT Project Instructions and reconnect MCP clients to load new guidance. See the [Notion Memory Skill](.agents/skills/gcf-notion-memory/SKILL.md).

**Notion never blocks GCF.** Whether Notion is disabled, offline or unauthorized, Task Inbox, Transfer Control, `task_resume` and normal Handoff keep working with the same permissions.

**Different responsibilities:** GCF's `shared_project_state`, `task_resume` and Task Inbox own live task progress and handoffs; Notion contains durable project knowledge only. Agents check for duplicates before updating existing notes. Temporary TODOs, chat transcripts and session logs are not copied into Notion.

To use Notion with **local Codex**, connect its official MCP in your own Codex session (account authorization is user-managed, not stored by GCF):

```bash
codex mcp add notion --url https://mcp.notion.com/mcp
codex mcp login notion
codex mcp list
```

The `codex mcp login notion` step requires your interactive OAuth approval. Independent Notion updates with GCF disconnected also require the agent to have local file access. The read-only, opt-in live Codex file-discovery test is `npm run test:gcf-notion-codex-offline`; it intentionally does **not** test remote Notion writes or run in ordinary smoke suites.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `npm ci` cannot find `package-lock.json` | Run `cd gpt-codex-flow` before `npm ci`. |
| `npm run gcf:ui` says **Missing script** | Same issue: check that you are in the folder containing this project's `package.json`. |
| Browser does not open | Use the **local URL printed in Terminal**; keep Terminal running. |
| Unlock code expired | Restart `npm run gcf:ui` to obtain a new one-use code. |
| `cloudflared` missing | Install from the official Cloudflare instructions, then restart the Control Center. |
| Cloudflare starts but ChatGPT cannot read projects | Check the exact private URL, ChatGPT connection permissions, selected folders and that the tunnel still shows ready. Do **not** disable authentication or Host/Origin restrictions. |
| Offline install reports `ENOTCACHED` | The npm cache lacks dependencies. Retry while online. |

## Features

- 🔒 **Project-scoped access** — approve exactly which folders ChatGPT can access. Git operations require a Git repository.
- 💻 **Both assistants can code** — ChatGPT edits and tests through authorized MCP tools; local Codex handles separately approved tasks. If Codex is unavailable, an active ChatGPT session can continue coding through authorized MCP edit/test tools.
- 🔄 **Durable handoffs** — Task Inbox, Transfer Control and continuity checkpoints preserve recorded task context.
- 🔍 **Git review** — inspect diffs, test evidence and return receipts before continuing.
- 🖥️ **Local Control Center** — manage projects, Cloudflare access and advisory lead preferences in your browser.
- 🧩 **Skills & Agent Profiles** — discover instructions for coding and review; profiles do not automatically start agents.

<p align="center"><img src="docs/gcf-preview/use-case-flow.svg" width="860" alt="A task moves through an approved project, ChatGPT and Codex, then returns with diffs and test evidence for review"></p>

## Security

**Handoff notes remain writable in every access level**, including Read Only, but only as scoped `.ai-bridge/` metadata; notes are not permission to edit source files or execute commands. ChatGPT's own approval settings do not replace server permissions. Command allowlists are not an OS sandbox.

Ordinary native Codex tasks request `workspace-write` with sandbox network disabled. The native **Codex sandbox** does not cover independent MCP file/Bash tools. Codex `--full-access` is a separate owner-attended high-risk option and prohibited in Local Auto. The local Control Center is never exposed via the public tunnel.

**ChatGPT Lead**, **Codex Lead** and **Auto — Recommend** are advisory choices. The per-project preference is stored privately next to the owner manifest. Owner-started MCP connections can read it using `get_project_orchestrator_mode`, but cannot alter it; standalone MCP sessions without trusted owner context report it unavailable. **Transfer Control** records a handoff; accepting one does not grant execution permissions or start a model. GCF does not synchronize hidden conversations, bypass account limits, authenticate model identity, provide a multi-item backlog, or install an OS login service. Windows-native sandbox containment remains unverified.

**Codex Model and Reasoning — per-project owner settings:** Open **Control Center → Workflow**, choose an approved project, select a **Codex model** (`Runner default` or a manually entered ID) and **Reasoning** (`Model default`, Low, Medium, High, Extra High), then press **Save Codex execution settings**. This is **separate from Codex Lead** and cannot be changed by MCP agents. Preferences are kept in the private owner-local `gcf-codex-execution-preferences.json` next to the manifest (not inside the public project). **Inspect Codex execution readiness** shows the exact owner-reviewed Terminal command with `--model` and `--effort` flags when set; the runner forwards them to Codex CLI using `--model` and `model_reasoning_effort`. Saved preferences do not run a model, grant write permissions, or select a model in other Codex sessions. For safety, this runner uses `--ignore-user-config`: the **Runner default is not necessarily your `~/.codex/config.toml` selection**. Model ID existence, subscription entitlement and the model actually served are not auto-verified. The owner-launched Local Auto worker has independent startup `--model`/`--effort` options and does **not** silently inherit these Dashboard settings.

See [security policy and release boundaries](SECURITY.md), [Codex sandbox decision](docs/GCF_NATIVE_SANDBOX_V1_DECISION.md) and [feature evidence](docs/GCF_FEATURES_SOURCE_OF_TRUTH.md).

## Development

To verify a source checkout (the browser visual test additionally needs Node.js 22+ and Chrome/Chromium):

```bash
npm run build
npm run test:gcf-core
npm run test:gcf-landing
npm run test:gcf-visual
npm run test:gcf-cloudflare-oneclick
npm run test:gcf-release-integrity
```

If you move to a different computer, install the dependencies again, reapprove your project folders, and reconnect ChatGPT using a new private tunnel URL. Your credentials, ignored `.ai-bridge/` records, local configuration and uncommitted work are **not** included in a Git clone; back up anything you need separately.

For source contributions see [CONTRIBUTING.md](CONTRIBUTING.md). For more detail see the [architecture decisions](docs/GCF_PROJECT_HISTORY.md). GitHub Pages contains only the static Landing, not the local Control Center.

## Upgrade compatibility

The GCF naming cleanup changes CLI entry points, MCP tool identifiers, environment variables, and local configuration paths. This is a **breaking change for previous installations**, not a silent in-place upgrade.

- **Keep a backup first:** preserve any existing `~/.codexbridge/` owner configuration and per-project `.ai-bridge/` task/inbox data. Back up private configuration securely; do **not** upload credentials or token-bearing URLs to GitHub or copy them into this repository.
- **Use the new installer:** install from the GCF repository with `npm ci`, then run `npm run gcf:ui` (or `gcf ui` when the CLI is correctly installed). Reapprove the intended project roots in the Control Center. The `gcf` executable is `scripts/gcf-cli.mjs`; the other GCF launcher is retained for internal compatibility helpers and is **not** a second `gcf` bin.
- **Reconnect clients:** replace old `codexbridge` executable references, `codexbridge_*` MCP tool IDs, `codexbridge_token` query parameters, and `CODEXBRIDGE_*` environment overrides with the GCF equivalents. Reissue a connection URL/token instead of reusing one from an old session. The owner configuration default now uses `~/.gcf/` and the environment prefix is `GCF_*`.
- **Do not overwrite or auto-migrate:** project-local `.ai-bridge/` tasks and handoffs remain owned by their repository, independent of optional Notion. Leave old state untouched until its contents and the new connection are verified. A clean install does **not** restore ignored state or credentials automatically.

For first-time installs, no migration is necessary. The current local test suite covers a fresh GCF launcher and package manifest; it does **not** prove that every older user installation can be migrated automatically.

## Privacy before public source releases

Source files, npm package metadata, GitHub repository links and **Git commit metadata** are distinct privacy surfaces. A new clean release candidate does not remove author names or email addresses from an already public GitHub history. Before any push, review the destination account/organization and use a Git author identity approved by the owner (an intentionally public address or a GitHub noreply address). The project's existing public GitHub links identify its account owner; publishing anonymously requires a separate owner-approved destination. Never commit personal machine paths, token-bearing URLs, `.env` files or the ignored per-project `.ai-bridge/` history. Private state stays on the user's machine; GitHub is not a backup for it.

## License

[MIT](LICENSE), based on [naplesblue/codexbridge](https://github.com/naplesblue/codexbridge). The original copyright notice is retained. GPT Codex Flow is an independent project, not an official OpenAI product.
