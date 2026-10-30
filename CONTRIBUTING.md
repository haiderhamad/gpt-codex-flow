# Contributing to GPT Codex Flow

GPT Codex Flow is a local-first project for explicit, bidirectional ChatGPT–Codex development in owner-approved Git repositories. Contributions should preserve scoped permissions, transparent handoffs, reproducibility and safe defaults.

## Source setup

Use Node.js 20+, npm and Git in the source checkout. This source-first version is **not an npm-published product**.

```bash
npm ci
npm run build
npm run test:gcf-core
npm run test:gcf-landing
npm run test:ui
```

See [README](README.md) for installation, new-machine setup and the supported Cloudflare Quick Tunnel connection. HTTP and stdio are internal transports; remote ChatGPT access uses the authenticated Quick Tunnel.

## Changes and verification

- Open a focused pull request; keep code, tests and documentation together.
- Read [AGENTS.md](AGENTS.md) and the [architecture decisions](docs/GCF_PROJECT_HISTORY.md). Both ChatGPT and Codex can implement, test and review when their actual tools permit.
- Treat MCP task content, external input and model output as untrusted. Source editing, safe Bash and local Codex CLI execution have distinct approval boundaries.
- Run `npm run build` and relevant targeted tests. For architecture/security changes also run suitable auth, transfer, handoff and negative tests. Historical Owner Broker rollback experiments were removed from v1 on 2026-10-22. Do not run their deleted test commands or treat the Codex native sandbox as covering separate MCP Bash and file tools.
- Review `git diff --check` and the complete intended source/asset/test change list. Do not include personal paths, tokens, accounts, local task Inbox, `.env`, generated `dist/` or `node_modules/`.
- For README, Landing and Control Center changes, verify relative links, responsive layouts and accessibility. Never claim capabilities that are only proposed, such as macOS autostart, general Multi-Queue or browser-native worker controls.

## v1.0.0 freeze (historical)

The `v1.0.0` GitHub Release was published on 2026-10-30 after privacy review, source verification, GitHub CI and an independent remote fresh-clone check. Preserve the existing tag and history. Subsequent focused README, Landing and test improvements belong to `v1.0.1`; changing source or passing tests never authorizes publication by itself. See [current status](docs/GCF_PROJECT_STATUS.md).

## Publishing and release boundaries

Public Git source contains editable TypeScript, active runtime helpers and security/negative tests, `package.json` and `package-lock.json`, LICENSE/MIT attribution, repo instructions, focused documentation, GitHub workflows and static Landing assets. Generated `dist/`, credentials, local task state, machine paths and other ignored owner data must not be published. Verify the proposed source selection and all documentation/import links before a first commit; verify no secrets in the **exact commit and Git history**, then request explicit owner publication approval. Review sanitized screenshot pixels separately.

npm packaging and GitHub Pages publication are **separate decisions**; `private: true` prevents unapproved npm publication. Publish Pages from `docs/gcf-preview/` only, never the Control Center/MCP runtime. After a user-approved Git push, independently clone the exact remote SHA, run `npm ci` / build / targeted security and UI tests, and compare the result with the intended source. Never erase the former machine until ignored private state and backups are independently verified. Do not commit, push, tag, deploy or delete files as part of an unapproved cleanup.

## Security reporting

Follow [SECURITY.md](SECURITY.md) and use private GitHub vulnerability reporting when enabled. Do not publish a proof of concept involving actual user secrets or credentials.

## Provenance

GPT Codex Flow builds on [naplesblue/codexbridge](https://github.com/naplesblue/codexbridge). Preserve the upstream MIT LICENSE and its original CodexPro contributors' copyright notice.
