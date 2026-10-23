# GPT Codex Flow — current status

Updated 22 October 2026. This is a local source candidate at v0.1.0 (`private: true`), not a publication certificate. No current public source revision, npm release, Pages deployment or clean remote install is certified.

## Public-release cleanup — code and documentation checks passed; publishing pending

**IMPLEMENTED:** The user-facing connection is Cloudflare Quick Tunnel only. Documentation is consolidated into one root README and focused development, feature, security, architecture and release references. Obsolete setup guides, README drafts, agent milestone briefs and dated reports are removed after reference inspection; their unique architectural/security decisions are retained in [history](GCF_PROJECT_HISTORY.md) and the maintained [security policy](../SECURITY.md).

**VERIFIED on 22 October 2026 after owner-approved file deletion:** `npm run build` and `npm run test:gcf-release-integrity` passed on the owner's Mac; a subsequent connected-workspace rerun of `test:gcf-core`, `test:gcf-landing`, `test:gcf-visual` (five Chromium layouts), `test:gcf-control-center-v2`, `test:gcf-cloudflare-oneclick` (fake tunnel plus real local MCP), `test:gcf-release-integrity` (306 imports, 83 documentation/asset links) and `git diff --check` all exited 0. Cloudflare testing did not establish a new live external ChatGPT connection. **PENDING:** final source/security/privacy review, real GitHub README rendering and independently verified remote clone/install after owner-approved publication; offline package installation is not yet proven.

Existing unrelated dirty/untracked work is preserved. This cleanup performs no commit, push, publication, deployment, live Cloudflare tunnel or paid model run.

## 2026-10-23 — README first-run onboarding (IMPLEMENTED / VERIFIED)

- Reorganized root README with a sequential five-stage installation and user onboarding flow: actual/conditional Git clone vs existing local source, Node/Git/cloudflared and optional Codex requirements, `npm ci` then `npm run gcf:ui`, local owner unlock code, Add Folder, Connections → Start Cloudflare, private MCP URL registration in ChatGPT and `list_projects` / `project_summary` read-only verification. Includes disconnect/restart behavior, permissions, privacy, troubleshooting and development/new Mac guidance. Distinguished the static Landing from local Control Center and marked public GitHub clone as future/unverified.
- Verified after edits: `npm run test:gcf-landing`, `npm run test:gcf-release-integrity` (306 imports; 77 documentation/asset links), `git diff --check` all Exit 0. No actual external ChatGPT tunnel setup attempted, commit or publication.

## 2026-10-23 — GitHub end-user README refinement (IMPLEMENTED / VERIFIED)

- Rewrote canonical README quick start from GitHub end-user perspective: `git clone`, `cd`, `npm ci`, `npm run gcf:ui`, then approve a project and connect ChatGPT using Cloudflare Quick Tunnel. Removed internal source-preview/prepublication and personal-checkout instructions, future-conditional wording and release-gate details from user-facing quick start. Kept permissions, credential warnings and troubleshooting. No changes to runtime, remote publication or connection permissions.
- VERIFIED: `npm run test:gcf-landing`, `npm run test:gcf-release-integrity` (306 imports; 75 local docs/assets links) and `git diff --check` Exit 0. Note: README is authored for users accessing a future published GitHub repo, but repo publication and independent remote clone/install are still pending owner approval.

## 2026-10-23 — Professional README presentation refresh (IMPLEMENTED / VERIFIED)

- Compared GitHub README presentation patterns from Abblix/Oidc.Server and othneildrew/Best-README-Template; improved source README hero, limited factual shields (Node 20+, TypeScript, MCP, MIT), concise navigation, small inline feature icons and a centered task-flow illustration. Removed unnecessary `Illustrative, not live status. Task flow · GIF fallback.` caption while retaining accessible diagram alt text and licensing/security caveats. Avoided release/CI badges with unverified status and kept user-focused installation and Cloudflare setup.
- VERIFIED targeted checks: `npm run test:gcf-landing`, `npm run test:gcf-release-integrity` (306 imports, 75 local links), `git diff --check` all Exit 0. No GitHub push or remote rendering acceptance yet.

## 2026-10-23 — Pre-push Markdown consolidation (IMPLEMENTED; physical deletion pending)

- Owner approved retiring `docs/FINAL_SECURITY_REVIEW.md`, `docs/PROJECT_OVERVIEW.md`, and `docs/RELEASE_MANIFEST.md` after migrating unique information. Maintained security/release policies now live in `SECURITY.md` and `CONTRIBUTING.md`, architectural runtime map and decisions in `docs/GCF_PROJECT_HISTORY.md`, README user setup remains canonical. Updated `AGENTS.md`, README and dependent docs; corrected stale removed Pause button mention. Removed the three documents from `scripts/gcf-source-candidate-preview.mjs` curated docs list. They currently remain present in local checkout and are omitted by preview; their physical deletion is pending a direct owner terminal rm because connected safe Bash blocks deletion.
- PASSED: `test:gcf-landing`, `test:gcf-release-integrity` (306 imports, 75 local links), `test:gcf-source-candidate-preview`, `test:gcf-public-source-prepare-preview` (206 selected, 3 excluded), and `git diff --check`. Candidate audit reports NO_STATIC_FINDINGS. No staging, push, release or deployment performed. History/remote Git private data and human screenshot pixel review remain separate release gates.

## Current implementation

- Owner-approved ordinary folders with Git detected per project, explicit selection, recovery/revocation and private manifest backups.
- Both ChatGPT and Codex can code using their available sessions and explicitly granted tools. Task Inbox, continuity checkpoints and advisory Transfer Control retain task context.
- Separate owner-local Control Center and authenticated tunneled MCP data plane. Old HTTP Admin HTML is retired; its read-only diagnostic/security tests remain active.
- Owner-started native Codex with executable pin, accepted-task checks, ordinary `workspace-write`/network-disabled request, bounded postflight, cancellation and receipts. Local Auto rejects native Full Access and processes a single accepted-transfer slot.
- Static light Landing with reusable brand mark, two task/result SVGs, pause/reduced-motion behavior and sanitized Control Center demo.

## 2026-10-22 — Landing navigation and public privacy preflight (IMPLEMENTED / VERIFIED)

- Updated only the public Landing header/navigation styling and anchor scrolling in `docs/gcf-preview/index.html` and `theme-light.css`: full-width sticky header, scroll offset measured from actual header height, all navigation links visible via horizontal scrolling on narrow displays, direct fragment URL correction. `scripts/gcf-landing-capture.mjs` now clicks all four primary navigation anchors in each of five real-Chrome viewport sizes, verifies sticky position and checks target headings stay visible below the header. Final browser tests pass at 1440, 768, 390, 375 and 844 pixels.
- **VERIFIED:** `npm run test:gcf-public-source-audit` returned `NO_STATIC_FINDINGS` for 210 tracked-and-untracked source candidates (0 detected private paths, key patterns, manual binary concerns or symlinks); `npm run test:gcf-public-screenshots` reported structurally valid 1440×900 PNG, no sensitive metadata chunks. This is **not** manual pixel/visible text privacy clearance, credential guarantee, historical Git-secret audit, or independent owner visual acceptance. `npm run test:gcf-public-source-prepare-preview` returned read-only readiness; no public source staging or upload.
- **REGRESSION:** `npm run build`, `test:gcf-landing`, `test:gcf-visual`, `test:gcf-project-guide-browser`, `test:gcf-release-integrity` and `git diff --check` all exit 0; prior Cloudflare/Core regressions remain as separately recorded. No live public tunnel, commit, push, GitHub publication or deployment. Exact remote clone/build remains pending owner-approved publication.

## 2026-10-22 — Anchor spacing refinement (IMPLEMENTED / VERIFIED)

- After owner screenshot showed large whitespace when navigating to `#workflow`, corrected section scroll positioning for actual inner content, reduced oversized section top padding/headings, and top-aligned the Control Center showcase. Kept sticky navigation and responsive horizontal links. Strengthened real Chrome navigation test to check the first H2 lies within 32 px below sticky header for each of four navigation anchors at desktop, tablet, two mobile widths and landscape. `npm run test:gcf-visual`, `test:gcf-landing`, `test:gcf-release-integrity`, `git diff --check` all exit 0 after refinement. No commit, push or deployment.

## 2026-10-23 — Local system regression and MCP bridge diagnostic (VERIFIED WITH LIMITS)

- **Local tests executed against current dirty checkout:** `npm run build`, `test:gcf-core`, `test:ui`, `test:gcf-cloudflare-oneclick`, `test:gcf-control-center`, `test:gcf-control-center-v2`, `test:gcf-quick-connect-readiness`, `test:gcf-codex-registration`, `test:gcf-native-sandbox-contract`, `test:gcf-landing`, `test:gcf-project-guide-browser`, `test:gcf-release-integrity`, `test:gcf-public-source-audit`, `test:gcf-public-screenshots`, `test:gcf-cross-client-resume`, `test:gcf-auto-worker`, `test:readonly-access`, `test:origin`, `test:gcf-nongit-workspace`, `test:gcf-native-preflight`, `test:gcf-package-audit`, `test:gcf-package-candidate`, `git diff --check` and **final rerun of `test:gcf-visual`** all exited 0. The first visual run failed on `#dashboard` at 1440px: target heading could not move up because the browser had reached maximum scroll. Increased only the bottom call-to-action section's desktop padding from 42px to 60px, giving enough scroll range while keeping other content compact. Final Chrome five-size nav tests passed.
- **Actual connected MCP read-only diagnostic:** `codexbridge_self_test` returned 9 pass, 3 warnings, 0 fails; warnings reflect standard tool mode and explicitly skipped write/Pro-context probes. Tool policy verified safe Bash and HTTP bearer auth. Real source/project select and project summary succeeded; no native Codex/model run performed.
- **Limits:** Cloudflare one-click test uses a fake public tunnel and real local MCP. Cross-client resume test uses two independent local simulated MCP clients, not real ChatGPT Web/Desktop. Native sandbox test checks argv/contract, not actual Windows isolation. Source privacy audit found zero static findings but excluded Git history and human pixel review. Package candidate test reported `ENOTCACHED`: absence of cached offline dependencies is not a successful offline installation. No live external connection, public publication, commit, push, deploy or private data write.

## Historical verification retained

Prior 22 October checks reported exit 0 for build/core, smoke, auth/Host/Origin/permissions, native preflight/postflight/worker, Control Center API/browser, fake-Cloudflare, Landing and Chromium responsive tests. They fixed retired-Admin test assumptions, exact continuity-checkpoint accounting, shared-state tool metadata/catalog coverage and non-Git diagnostics. Do not remove those regression assertions during cleanup.

The prior browser review covered Landing at 1440/768/390/375 and 844 landscape and Control Center at 1440/768/390. It tested keyboard/Copy, broken assets/anchors, reduced motion, overflow and console errors. Chromium evidence does not certify Safari/Firefox, a screen reader or GitHub's README renderer.

The owner-attended isolated native Codex and real reverse ChatGPT handoffs passed on 18 October; [feature evidence](GCF_FEATURES_SOURCE_OF_TRUTH.md) records their scope. Regular tests use fake binaries/simulated clients and start no public tunnel.

## Open limitations and next gates

- Actual Windows-native Codex sandbox network/filesystem containment and supported OS-specific flags remain unverified. A local argv contract/defined CI job is not native acceptance.
- MCP file/Bash tools remain a separate trust boundary from Codex sandbox. Safe command allowlists and Git worktrees are not universal OS containment.
- Core packaging fixtures can pass while explicitly reporting missing offline dependencies (`ENOTCACHED`); this is blocker detection, not an offline install pass.
- No unattended privileged executor, automatic consumer-session switching, model identity attestation, multi-item queue or OS login service is claimed.
- Public source selection, secret/pixel review, explicit owner publication approval and independent clone of the exact uploaded commit remain release gates. Git excludes private owner state; new-Mac backup/restore is separate.

See [contributing/release boundaries](../CONTRIBUTING.md) and [README](../README.md) for reproducible setup and tests. No old-Mac erasure clearance is given.
