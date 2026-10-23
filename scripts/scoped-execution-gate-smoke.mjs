import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ScopedExecutionGate } from "../dist/scopedExecutionGate.js";

const root = await mkdtemp(join(homedir(), "cb-gate-fixture-"));
let clock = 10_000;
let executed = 0;
const executor = async request => {
  executed++;
  assert.equal(request.workspaceRoot, root);
  return { exitCode: 0, signal: null, timedOut: false,
    durationMs: 1, stdout: "APPROVED", stderr: "", truncated: false };
};
const gate = new ScopedExecutionGate(executor, () => clock);
const principalId = "verified-local-fixture";
const command = ["/bin/echo", "safe marker"];
const request = approvalId => ({
  principalId, workspaceRoot: root, codexExecutable: "/usr/bin/false",
  command, timeoutMs: 1000, maxOutputBytes: 1024, approvalId
});
try {
  await assert.rejects(gate.executeApproved(request("missing")), /No active/);
  assert.equal(executed, 0);
  console.log("PASS: inactive gate denies execution");

  const grant = {
    principalId, workspaceRoot: root,
    expiresAtMs: clock + 30_000,
    maxTimeoutMs: 10_000, maxOutputBytes: 4096
  };
  gate.activateFromTrustedLocalControl(grant);
  await assert.rejects(gate.executeApproved(request("missing")), /approval/);
  let approval = gate.approveFromTrustedLocalControl({ principalId, workspaceRoot: root, command });
  await assert.rejects(gate.executeApproved({ ...request(approval), command: ["/bin/echo", "changed"] }), /approval/);
  await assert.rejects(gate.executeApproved({ ...request(approval), principalId: "other" }), /No active/);
  await assert.rejects(gate.executeApproved({ ...request(approval), timeoutMs: 20_000 }), /timeout/);
  assert.equal(executed, 0);
  console.log("PASS: mismatched principal, argv and budget denied without execution");

  assert.equal((await gate.executeApproved(request(approval))).stdout, "APPROVED");
  await assert.rejects(gate.executeApproved(request(approval)), /approval/);
  assert.equal(executed, 1);
  console.log("PASS: exact one-time approval consumed; replay denied");

  approval = gate.approveFromTrustedLocalControl({ principalId, workspaceRoot: root, command, approvalTtlMs: 1000 });
  clock += 1000;
  await assert.rejects(gate.executeApproved(request(approval)), /approval/);
  console.log("PASS: expired approval denied");

  approval = gate.approveFromTrustedLocalControl({ principalId, workspaceRoot: root, command });
  gate.revoke();
  await assert.rejects(gate.executeApproved(request(approval)), /No active/);
  console.log("PASS: revocation prevents new execution");

  gate.activateFromTrustedLocalControl(grant);
  approval = gate.approveFromTrustedLocalControl({ principalId, workspaceRoot: root, command });
  await assert.rejects(gate.executeApproved({ ...request(approval), workspaceRoot: homedir() }), /workspace/);
  gate.activateFromTrustedLocalControl(grant);
  await assert.rejects(gate.executeApproved(request(approval)), /approval/);
  clock += 30_000;
  await assert.rejects(gate.executeApproved(request("anything")), /No active/);
  assert.equal(executed, 1);
  console.log("PASS: workspace scope, grant revision and expiry enforced");

  assert.throws(() => gate.activateFromTrustedLocalControl({ ...grant, expiresAtMs: clock + 121 * 60_000 }), /1–120/);
  assert.throws(() => gate.activateFromTrustedLocalControl({ ...grant, expiresAtMs: clock + 30_000, workspaceRoot: "/" }), /non-root/);
  console.log("PASS: invalid grant constraints fail closed");

  const activeClock = 100_000;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const cancellableExecutor = request => new Promise(resolve => {
    assert.ok(request.abortSignal);
    request.abortSignal.addEventListener("abort", () => resolve({
      exitCode: null, signal: "SIGKILL", timedOut: false, cancelled: true,
      durationMs: 10, stdout: "", stderr: "", truncated: false
    }), { once: true });
    started();
  });
  const cancelGate = new ScopedExecutionGate(cancellableExecutor, () => activeClock);
  cancelGate.activateFromTrustedLocalControl({
    ...grant, expiresAtMs: activeClock + 30_000
  });
  const cancelApproval = cancelGate.approveFromTrustedLocalControl({
    principalId, workspaceRoot: root, command
  });
  const running = cancelGate.executeApproved(request(cancelApproval));
  await startedPromise;
  const anotherApproval = cancelGate.approveFromTrustedLocalControl({
    principalId, workspaceRoot: root, command
  });
  await assert.rejects(cancelGate.executeApproved(request(anotherApproval)), /already running/);
  assert.throws(() => cancelGate.activateFromTrustedLocalControl({
    ...grant, expiresAtMs: activeClock + 30_000
  }), /revoke first/);
  cancelGate.revoke();
  assert.equal((await running).cancelled, true);
  await assert.rejects(cancelGate.executeApproved(request(anotherApproval)), /No active/);
  console.log("PASS: single active execution, revoke aborts running executor signal");

  console.log("Scoped execution authorization gate simulation passed (not wired to MCP).");
} finally {
  await rm(root, { recursive: true, force: true });
}
