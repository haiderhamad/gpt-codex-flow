# GPT Codex Flow — Parallel Role Proof Trust Boundary

**Status:** IMPLEMENTED as an optional, advisory test mode; VERIFIED with disposable fixtures. **NOT** a production identity authenticator.

## What is implemented

- `scripts/gcf-parallel-role-proof.mjs`: canonical Ed25519 SPKI public key validation and strict distinct-key requirement. The transcript signs an unambiguous JSON array with version domain separator, session UUID, Git base HEAD, role name, hash of assigned task, ordered owned paths, Git patch SHA-256 and evidence SHA-256.
- `createParallelSession({ rolePublicKeys: { chatgpt, codex } })` stores public keys, never private keys, in `parallel-session.json`. This opt-in signed mode requires a valid signature at `reportParallelRole`; unsigned legacy sessions still work and are explicitly unverified.
- `previewParallelSession`, `exportParallelReviewBundle` and `inspectParallelSessionRecovery` validate persisted signed role reports. Tampered reports, changed tasks/keys, wrong role, changed Git patch fingerprints and replay from other sessions fail. Review manifests record `role_signatures_verified` and always `worker_identity_verified: false`.
- No actual Native Codex invocation, key registration with a trusted service, or remote signature-execution endpoint was introduced.

## Threat model and non-goals

**Cryptographic validity is not identity verification.** The public keys and enforcement flag live in an agent-writable local session file; an adversary with sufficient filesystem access could replace the entire file, remove both the trust keys and strict flag (legacy downgrade), or substitute their own keypairs and signatures. The code detects internally inconsistent key/mode edits, but **not** complete trusted-record replacement. Cryptographic proof merely demonstrates possession of the matching private key *relative to whatever public key was loaded from that file*.

Local code currently cannot assert that ChatGPT, Codex, a particular MCP client, a macOS process, or a human actually owns those keys. Names like `chatgpt` and `codex` are role labels, not credentials.

## Separate pinned-enrollment audit prototype (2026-10-16)

- Added `scripts/gcf-parallel-trust-audit.mjs` with the pure, read-only `auditPinnedParallelEnrollment({session, enrollment})`. Its `enrollment` parameter models a pin provided **independently** of the mutable `parallel-session.json`, comparing exact session ID, Git HEAD, goal, distinct registered Ed25519 public keys, role tasks and assigned target paths. It also verifies report signatures and checks their changed paths remain within the pinned assignments. Unexpected session schema, terminal status, incomplete reports, unsigned downgrade or tampered key/role/path/signature is refused.
- `scripts/gcf-parallel-trust-audit-smoke.mjs` uses a separately held test pin and verifies a *whole forged session* with new, internally valid signatures still fails external pin comparison. This makes the original all-record-replacement threat **detectable only when the caller supplies a genuinely independent reference**.
- This prototype creates, installs, persists, authenticates and cryptographically seals **no trusted enrollment**. The Node validator and caller are themselves agent-writable. Neither a caller-provided `enrollment` object nor this audit's `status: PASS` conveys macOS process identity, broker code integrity, device owner consent or permission to execute. All outputs explicitly leave `client_identity_verified` and `owner_approval_granted` false.
- Signed mode must be mandatory by a *separate immutable broker-controlled policy* for a particular enrolled session. An arbitrary caller supplying both the record **and** pins can bypass this audit. Before release, port/reimplement the comparison inside a signed, independently installed broker and bind enrollment to authenticated OS clients, leases and revocation.

## Native macOS CryptoKit verifier — offline fixture (2026-10-17)

- **IMPLEMENTED:** `scripts/gcf-owner-native-role-audit.swift` implements a read-only CryptoKit Ed25519 verification of the role-report transcript emitted by the Node signing helper. It validates an external enrollment reference against the session ID, base Git HEAD, goal, role-specific canonical SPKI public key, signed task, assigned paths, changed-path subset, patch SHA-256 and evidence. Requires signed and reviewable session state. No local account authorization, execution, workspace edits, enrollment writes, XPC service, code signing, installation or MCP endpoint.
- **TESTED:** `scripts/gcf-owner-native-role-audit-smoke.mjs` compiles the Swift verifier to a disposable temporary executable with `GCF_OWNER_ROLE_AUDIT_TEST`, signs test role reports in Node, submits signed records to CryptoKit, asserts cross-language parity (including a Unicode task), and exercises wrong-role proofs, session replay, changed baseline/task/evidence/scope, pin/key substitution with fresh internally valid signatures, signed-mode downgrade, partial reporting and forged authority flags. The executable is removed after testing. `npm run test:gcf-owner-native-role-audit` PASS; `npm run test:gcf-core` PASS (Build + 19 focused test groups); `git diff --check` PASS.
- **CRITICAL TRUST BOUNDARY:** Both the candidate session **and** the supposedly pinned enrollment are provided together to this disposable test executable through stdin by a test harness. This is cross-language *cryptographic correctness*, **not** independent tamper-resistant enrollment. A malicious caller controlling both inputs can fabricate an internally consistent record. The Swift source/binary are built from agent-writable repository content and are not signed/pinned/installed. Do not use `PASS:CRYPTOGRAPHIC_ROLE_PROOF_ONLY` as an access token or owner authorization. The verifier explicitly reports `CLIENT_IDENTITY_VERIFIED=false` and `OWNER_APPROVAL_GRANTED=false`.
- **HISTORICAL PROPOSAL, SUPERSEDED 2026-10-22:** A signed independent broker was originally proposed to authenticate enrollment, code identities and owner consent. That design and its Broker/XPC fixture sources have been removed from v1. Current Codex Native Sandbox does **not** create verified cross-client role identity or authorize elevated unattended execution. Human presence still cannot be inferred from a session flag.

## Required before genuine identity/ownership enforcement

1. A separate trusted local macOS broker (signed/pinned and **outside agent-writeable repositories**) registers each permitted client public key against an authenticated local process/session and distinct principal.
2. Trusted broker persists the enrollment and required proof mode outside editable Git/worktree metadata. Prevent fallback to legacy mode once signed mode is enrolled.
3. Agent private keys reside outside shared worktrees, one per authenticated principal, with short-lived signing grants bound to a session, exact task, paths and expected patch.
4. Trusted broker independently validates registration, caller/recipient, lease, revocation and exact signed manifest **before** authorizing writes/execution or export; use OS-level sandbox/isolation and audit.
5. Negative E2E tests must cover principal substitution, swapped keys, rollback/downgrade, replay between sessions, task/path mutation, revocation during execution, symlink/TOCTOU and process restarts.

**Release gate: BLOCKED.** Passing fixture tests alone is insufficient for trustworthy multi-agent authentication. Do not allow a role signature to grant write permissions, Native Codex execution, commits, merges or pushes.
