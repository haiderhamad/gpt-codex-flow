import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { executeScopedSandbox } from "../dist/scopedSandboxExecutor.js";

if (process.platform !== "darwin") {
  console.log("SKIP: scoped executor requires independent native Windows/Linux validation.");
  process.exit(0);
}
const exists = p => access(p).then(() => true, () => false);
const cli = execFileSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).trim();
const temp = await mkdtemp(join(homedir(), "cb-executor-smoke-"));
const workspace = join(temp, "workspace");
const outside = join(temp, "outside");
try {
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  const insideFile = join(workspace, "in.txt");
  const outsideFile = join(outside, "out.txt");
  await writeFile(insideFile, "SAFE_INSIDE_MARKER");
  await writeFile(outsideFile, "SAFE_OUTSIDE_MARKER");

  const run = (command, extra = {}) => executeScopedSandbox({
    codexExecutable: cli, workspaceRoot: workspace, command, timeoutMs: 10_000, ...extra
  });
  let r = await run(["/bin/cat", insideFile]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.stdout.trim(), "SAFE_INSIDE_MARKER");
  console.log("PASS: real executor reads allowed workspace file");

  r = await run(["/bin/cat", outsideFile]);
  assert.notEqual(r.exitCode, 0, "Outside read unexpectedly allowed");
  assert.equal(r.stdout.includes("SAFE_OUTSIDE_MARKER"), false);
  assert.match(r.stderr, /Operation not permitted|Permission denied/i);
  console.log("PASS: real executor denies outside read");

  const insideWrite = join(workspace, "write.txt");
  r = await run(["/usr/bin/touch", insideWrite]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(await exists(insideWrite), true);
  console.log("PASS: real executor permits inside write");

  const outsideWrite = join(outside, "write.txt");
  r = await run(["/usr/bin/touch", outsideWrite]);
  assert.notEqual(r.exitCode, 0);
  assert.equal(await exists(outsideWrite), false);
  assert.match(r.stderr, /Operation not permitted|Permission denied/i);
  console.log("PASS: real executor denies outside write");

  const linkToOutside = join(workspace, "link-to-outside");
  await symlink(outside, linkToOutside, "dir");
  r = await run(["/bin/cat", join(linkToOutside, "out.txt")]);
  assert.notEqual(r.exitCode, 0, "Symlink outside read unexpectedly allowed");
  assert.equal(r.stdout.includes("SAFE_OUTSIDE_MARKER"), false);
  assert.match(r.stderr, /Operation not permitted|Permission denied/i);
  console.log("PASS: real executor denies outside read through symlink");

  const symlinkOutsideWrite = join(linkToOutside, "via-link.txt");
  r = await run(["/usr/bin/touch", symlinkOutsideWrite]);
  assert.notEqual(r.exitCode, 0, "Symlink outside write unexpectedly allowed");
  assert.equal(await exists(join(outside, "via-link.txt")), false);
  assert.match(r.stderr, /Operation not permitted|Permission denied/i);
  console.log("PASS: real executor denies outside write through symlink");

  const networkProbe = [
    "import errno,socket,sys",
    "s=socket.socket();s.settimeout(2)",
    "try:s.connect(('1.1.1.1',443))",
    "except PermissionError as e:",
    " print('NETWORK_DENIED',e.errno)",
    " sys.exit(77 if e.errno in (errno.EPERM,errno.EACCES) else 78)",
    "except Exception as e:",
    " print('INCONCLUSIVE',type(e).__name__)",
    " sys.exit(78)",
    "else:",
    " print('NETWORK_ALLOWED')",
    " sys.exit(0)",
    "finally:s.close()"
  ].join("\n");
  r = await run(["python3", "-c", networkProbe]);
  assert.equal(r.exitCode, 77, `Network denied test inconclusive: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /NETWORK_DENIED/);
  console.log("PASS: real executor denies tested outbound TCP");

  r = await run(["python3", "-c", "print('X' * 4096)"], { maxOutputBytes: 1024 });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.stdout) <= 1024, "Executor exceeded configured output limit");
  console.log("PASS: executor caps large output");

  process.env.CB_SCOPED_PARENT_TEST_MARKER = "fake-nonsecret-test-value";
  try {
    r = await run(["/usr/bin/env"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.includes("CB_SCOPED_PARENT_TEST_MARKER"), false);
    assert.equal(r.stdout.includes("CODEX_HOME="), true);
    console.log("PASS: production executor does not inherit parent environment marker");
  } finally {
    delete process.env.CB_SCOPED_PARENT_TEST_MARKER;
  }

  r = await executeScopedSandbox({
    codexExecutable: cli, workspaceRoot: workspace,
    command: ["/bin/sleep", "5"], timeoutMs: 1000
  });
  assert.equal(r.timedOut, true, "Long-running sandbox command did not time out");
  assert.ok(r.durationMs < 4500, "Timeout did not stop long-running process promptly");
  console.log("PASS: executor enforces timeout");

  const revokeController = new AbortController();
  const cancellation = executeScopedSandbox({
    codexExecutable: cli, workspaceRoot: workspace,
    command: ["/bin/sleep", "10"], timeoutMs: 10_000,
    abortSignal: revokeController.signal
  });
  setTimeout(() => revokeController.abort(), 1000);
  const cancelledResult = await cancellation;
  assert.equal(cancelledResult.cancelled, true, "Revocation did not cancel native process");
  assert.equal(cancelledResult.timedOut, false, "Cancellation misreported as timeout");
  assert.ok(cancelledResult.durationMs < 4500, "Cancellation did not stop process promptly");
  console.log("PASS: real executor cancels active native sandbox process");

  const alreadyRevoked = new AbortController();
  alreadyRevoked.abort();
  await assert.rejects(
    executeScopedSandbox({
      codexExecutable: cli, workspaceRoot: workspace,
      command: ["/bin/echo", "should-not-run"],
      abortSignal: alreadyRevoked.signal
    }),
    /revoked before launch/
  );
  console.log("PASS: revoked execution cannot start");

  await assert.rejects(
    executeScopedSandbox({ codexExecutable: "codex", workspaceRoot: workspace, command: ["/bin/echo", "x"] }),
    /absolute/
  );
  await assert.rejects(
    executeScopedSandbox({ codexExecutable: cli, workspaceRoot: "/", command: ["/bin/echo", "x"] }),
    /Filesystem root/
  );
  await assert.rejects(
    executeScopedSandbox({ codexExecutable: cli, workspaceRoot: workspace, command: [] }),
    /Structured command/
  );
  console.log("PASS: malformed/untrusted launch inputs fail closed");
  console.log("PASS: scoped native macOS executor focused tests (not MCP integration or Windows security).");
} finally {
  await rm(temp, { recursive: true, force: true });
}
