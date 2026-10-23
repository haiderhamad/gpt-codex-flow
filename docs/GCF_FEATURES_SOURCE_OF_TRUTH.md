# GPT Codex Flow — capabilities and evidence

Updated 22 October 2026. Live source and tests take precedence over narrative. **IMPLEMENTED** means code exists; **VERIFIED** is limited to the stated test/evidence scope; **PROPOSED** is not shipped. The cleanup verification in [current status](GCF_PROJECT_STATUS.md) must pass before treating earlier results as validation of the cleaned tree.

## Supported scope

| Capability | Implementation and bounded evidence |
| --- | --- |
| Approved projects | Explicit canonical folders, IDs, selection, lookup, revocation and private manifest backups. Ordinary directories work; Git-only operations require Git. Core, multi-project and non-Git fixtures cover these boundaries. |
| Cloudflare connection | **Only supported user-facing connection:** owner-started Quick Tunnel through Control Center, selected projects, one shared access policy and fresh token. `test:gcf-cloudflare-oneclick` uses a fake tunnel and real authenticated local MCP. Prior owner-attended ChatGPT read/handoff/Disconnect evidence does not establish current connectivity. |
| Internal MCP transports | HTTP serves the Cloudflare data plane; stdio supports native registration and disposable protocol tests. Preserve their authentication, root selection and tool behavior; they are developer/runtime details. |
| File, Git and command tools | Both assistants can code through actually granted tools. GCF defaults source writes/Bash off; the Quick Tunnel Read Only policy separately permits bounded handoff metadata. Permission, write-policy, read-only and HTTP tests exercise enforcement. Safe Bash is an allowlist, not an OS sandbox. |
| Task Inbox and Transfer Control | Durable correlated messages and advisory request/accept/cancel/reply. Transfer and reverse-handoff fixtures include fresh MCP sessions, source editing and actual tests. Role names do not prove model identity or permission. |
| Shared context and history | Recognized project history and recorded GCF operations support later continuation. Optional owner-local initialization creates one short history for a new empty project without overwriting existing history. Activity outside GCF is not silently captured. |
| Lead preferences | ChatGPT Lead, Codex Lead and Auto — Recommend are advisory. Caller-reported Codex availability can recommend ChatGPT coding takeover; it is not verified quota telemetry or an automatic session switch. |
| Skills and Agent Profiles | Bounded discovery/read of installed instructions and role metadata. A profile is not an independently running agent. |
| Native Codex handoff | Accepted unexpired transfer, clean approved Git worktree, executable pin, bounded arguments, ordinary native sandbox request and Git postflight. Runner/preflight/postflight/executable tests use disposable fixtures. |
| Local Auto | Owner-started foreground per-root worker, claim-before-launch, duplicate prevention, cancellation, conservative stale-lock recovery, bounded replay history and return receipts. Tests use fake Codex plus real local MCP. No multi-item backlog or OS autostart. |
| Full Access | Manual owner-local Full Bash connection setup and separately attended native `danger-full-access` exist as high-risk paths. Native Auto refuses Full Access. Negative/argv tests do not certify a safe positive Full Access run. |
| Parallel worktrees | Scoped sessions, patch bundles, review, recovery and optional advisory signatures. Simulated peer trials do not prove two live model workers or authenticated principals. See [role-proof boundary](gcf-role-proof-trust-boundary.md). |
| Owner-local Control Center | Separate loopback listener, one-use unlock, private session, Host/Origin/CSRF protections, native project confirmation and Cloudflare lifecycle. Owner API/browser fixtures cover these boundaries. Legacy HTTP Admin HTML is retired (`/` and `/setup` return 410). |
| Landing and README | Static light brand, two task/result SVGs, automatic reduced-motion behavior (manual Pause button removed) and sanitized demo screenshot. Prior Chromium review covered desktop/tablet/mobile. GitHub-rendered README and non-Chromium/assistive-technology acceptance remain separate. |

## Historical real-client evidence

- On 18 October 2026, the owner supplied `PASS_ISOLATED_OWNER_LIVE_CODEX`: an isolated native Codex invocation with `--ignore-user-config --ephemeral`, one allowed source edit, Git postflight, Node test exit 0 and a genuine correlated receipt retrieved by a fresh read-only MCP session.
- The same day's owner-attended Codex App → ChatGPT → Codex App workflow included a real ChatGPT `package.json` edit, targeted/core tests exit 0 and a correlated return independently read by Codex App. Codex App's additional test rerun was blocked by its Bash-off policy.
- These records establish bounded human-approved workflow evidence. They do not attest exact model identity, autonomous switching, current client connectivity or OS sandbox containment. Regular automated regressions do not invoke paid models.

## Security and release limits

Ordinary native Codex execution requests `workspace-write` with network disabled, ignored user configuration and ephemeral state. Independent MCP file/Bash tools do not inherit this boundary. Git postflight detects changes; it cannot reverse outside-workspace effects. See [native sandbox decision](GCF_NATIVE_SANDBOX_V1_DECISION.md) and [security policy](../SECURITY.md).

Signed Owner Broker/XPC research was retired on 22 October 2026. Its historical SQLite rollback counterexample demonstrated unsafe prototype authorization; removing that prototype does not create a signed owner identity service. Privileged unattended execution remains unsupported.

**Not shipped or not verified:** hidden ChatGPT/Codex memory synchronization, automatic consumer conversation creation, subscription quota reads/bypass, general background multi-agent scheduling, actual Windows sandbox containment, universal MCP OS isolation, full screen-reader certification, published npm installation or exact remote-clone acceptance. Public source and Pages publication require separate owner approval. The supported Cloudflare connection uses a bearer credential; it does not implement OAuth.
