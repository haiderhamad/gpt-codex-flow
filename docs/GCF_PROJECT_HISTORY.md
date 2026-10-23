# GPT Codex Flow — architecture decisions

This compact record retains unique decisions from superseded drafts, audits and milestone reports. Historical test evidence is dated; current behavior is described by live source, [capabilities](GCF_FEATURES_SOURCE_OF_TRUTH.md) and [status](GCF_PROJECT_STATUS.md).

## Upstream and local-first design

The project derives from MIT-licensed [naplesblue/codexbridge](https://github.com/naplesblue/codexbridge). Preserve the original copyright/LICENSE and attribution. GCF uses a simple Node.js/TypeScript runtime, project-scoped MCP tools, Git evidence and local owner state. Avoid new frameworks, hosted relays and extra services without a demonstrated need. Personal Skills, agent profiles and credentials are not vendored dependencies.

Both ChatGPT and Codex are coding-capable peers. A ChatGPT lead may implement and run permitted tests; Codex may plan and review. Skills provide instructions; agent profiles alone do not spawn model workers.

## Lead, transfer and authorization are distinct

ChatGPT Lead, Codex Lead and Auto — Recommend are advisory choices. Transfer Control is a separate correlated request/accept/cancel workflow. Neither a selected role, caller-reported availability, Inbox note, `user_confirmed` field nor mutable SQLite/file history grants native execution permission or authenticates a principal.

Execution policy is separate: supervised owner-local execution, an owner-started bounded Local Auto worker, or a separately attended unsafe Full Access action. Recommendations never silently create sessions, read provider quota, bypass account limits or switch consumer models.

## Owner-local control plane — 20 October 2026

The Control Center uses a separate ephemeral loopback listener. Do not extend or tunnel the MCP server into an owner-administration service. A one-use Terminal bootstrap, short-lived memory session, exact Host/Origin, Fetch Metadata, CSRF, private cookies, bounded bodies and rate limits protect the browser surface. This is capability authentication, not OS-backed human identity or protection against malicious same-user software.

Initial Terminal-only preview was superseded by native folder picking and a second local confirmation. Canonical selected paths remain server-side behind short-lived picker tickets. Settings writes are atomic, private and backed up. Removing a project revokes saved access; it does not delete files. Ordinary directories are valid projects; Git is required only for Git-specific operations and native handoff. Restart active servers/workers after revocation where applicable.

The old MCP HTTP Admin renderer was retired on 22 October. `/` and `/setup` return 410; internal health, authenticated diagnostics and MCP endpoints remain for the active runtime and tests.

## Cloudflare Quick Tunnel only — 22 October 2026

The owner selected a single supported user-facing connection: manually started Cloudflare Quick Tunnel from Control Center. Its data plane is an authenticated internal loopback HTTP MCP server with exact selected projects, one shared access policy and a fresh secret URL. Internal stdio remains for native Codex registration and developer tests; internal HTTP is essential to Cloudflare. They are not competing public setup recipes.

The private connection URL is a bearer credential despite the client's “No authentication” setting. Never log/share it. Quick Tunnel hostnames rotate; tunnel readiness is distinct from an actual client request. Disconnect stops the owned tunnel/server; starting the local UI does not expose projects.

Experimental Quick OAuth/session/rotation fixtures did not establish a supported OAuth connection, trusted owner identity or production readiness. The shipped user flow uses the explicit bearer credential. Retain required internal OAuth-discovery/security behavior only where it has active runtime/test coverage; never revive an alternative connection wizard from a fixture.

## Native sandbox scope — 22 October 2026

The initial release uses Codex CLI's native sandbox request for Codex-launched work. Ordinary invocation requests `workspace-write`, no sandbox network, ignored user configuration and ephemeral state, plus executable pinning, accepted-transfer checks and Git postflight. There is no automatic fallback to host execution on sandbox failure. MCP write/Bash tools run under their own permission rules and do not inherit this sandbox.

Signed Owner Broker/XPC experiments were removed from v1. Their SQLite consumed-grant rollback counterexample showed that restoring mutable history could revive authority. An exit-zero reproduction confirmed the failure, not its repair. Process-memory epochs and unsigned XPC fixtures never provided installed trusted caller identity. No signed broker was a production dependency. Privileged unattended execution remains unsupported; removal is a scope decision, not a security certification. [Native sandbox decision](GCF_NATIVE_SANDBOX_V1_DECISION.md).

Optional Ed25519 role proofs verify a transcript relative to supplied keys. An agent can replace mutable enrollment and matching signatures; independent test pins detect substitution only when truly independent. Node/Swift parity fixtures do not supply trusted identity or execution approval. [Role-proof boundary](gcf-role-proof-trust-boundary.md).

## Native lifecycle and evidence

Native work requires an accepted fresh task in an approved clean Git worktree. Preflight/postflight disable repository hooks, fsmonitor and external diff helpers. Exact managed metadata is captured and hashed; arbitrary ignored outputs are rejected. The continuity checkpoint is legitimate managed metadata only when independently captured with required path/type/size/hash checks. A filename exemption is insufficient.

The owner-started Auto worker claims a task before launch, fences an active child, prevents automatic replay and retains bounded history. Stop propagates cancellation to the bounded process group. Stale recovery refuses active/indeterminate/legacy locks even if the worker PID is absent: surviving descendants require owner inspection. History capacity exhaustion stops for inspection instead of erasing replay protection. Lock/PID presence is not authenticated process identity.

Failed/no-change/cancelled runs can return a distinct bounded INCOMPLETE receipt only when protected task/metadata remain intact. Preflight refusal or tampering cannot publish a fabricated completion. Retrieve the actual receipt body through a fresh MCP session; a list item alone is insufficient evidence. Git postflight detects repository changes and cannot prevent or reverse external effects.

On 18 October the owner supplied a genuine isolated Codex edit/test/postflight/fresh-session receipt result. A separate owner-attended Codex App → ChatGPT → Codex App handoff included an actual ChatGPT source edit, tests and correlated readback. These support bounded coding handoffs; exact provider identity, OS containment and autonomous switching remain unproven.

## HTTP security lessons

Tokenless legacy HTTP needs exact raw loopback Host/port validation before all routes, even when Origin is absent; loopback binding alone does not stop DNS rebinding. Forwarded Host never grants access. Authenticated Cloudflare still requires its bearer check. Remote MCP credentials cannot mutate owner settings or broaden runtime permissions.

Owner state uses bounded regular-file reads, link checks, private atomic saves and backups. These are integrity safeguards, not same-user authentication or anti-rollback execution grants. See the maintained [security policy](../SECURITY.md).

## Runtime components

- `src/server.ts` and project/workspace/Git/task modules expose scoped MCP tools, Task Inbox and advisory Transfer Control.
- `src/http.ts` supplies the authenticated internal HTTP MCP data plane, not a remote owner administration endpoint.
- `src/gcfControlCenter.ts` and `src/gcfControlCenterPage.ts` implement the separate loopback owner UI and session/approval controls.
- `src/gcfCloudflareLauncher.ts` starts owner-approved temporary Cloudflare Quick Tunnels using selected projects and a newly generated bearer credential.
- `scripts/gcf-native-transfer-run.mjs` and bounded workers handle independently authorized local native Codex execution, cancellation and Git postflight.

## Public artifacts and visual design

Editable Git source, a future minimal npm runtime and static GitHub Pages are separate artifacts. Keep all active source/tests/helper dependencies in Git. Pages receives only `docs/gcf-preview/`, never Control Center/MCP/private data. Package identity remains a private source candidate; historical publication claims are superseded and no current remote acceptance is certified.

Use the existing off-white/pale-blue/cyan visual system and original C/code mark. Both assistants appear coding-capable. Task/result diagrams remain understandable without motion; Automatic SVG reduced-motion behavior and distinct inline paint/title IDs matter; the public manual Pause control was removed by owner request. A demo screenshot is sanitized fixture evidence, not live telemetry. Keep one maintained root README and focused technical references instead of duplicate setup guides or milestone transcripts.

After owner-approved publication, independently clone the exact remote commit and run installation/build/relevant tests/local verification. Git cannot back up ignored credentials, Inbox state, uncommitted work or global Skills. Private encrypted backup/restore remains separate; a disposable source snapshot cannot certify an old Mac safe to erase.
