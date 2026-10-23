// GPT Codex Flow: disposable, real MCP functional regression.
// Runs no Codex agent, requests no OS owner authentication or privileged access.
// All writes, Git commits and subprocess tests are confined to a throwaway fixture.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "gcf-functional-e2e-"));
let client;

function git(...args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, "fixture git failed: " + (r.stderr || r.stdout));
}

function verified(result, label) {
  assert.equal(Boolean(result?.isError), false, label + ": " + JSON.stringify(result));
  return result.structuredContent ?? {};
}

try {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "test"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".ai-bridge/\n");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "gcf-functional-e2e-fixture",
    private: true,
    type: "module",
    scripts: { "test:unit": "node --test" }
  }, null, 2) + "\n");
  // Separate terminal-owned fixture process: exercises the handoff executor,
  // without starting native Codex or running arbitrary user repository code.
  await fs.writeFile(path.join(root, "fixture-review-agent.mjs"),
    "import fs from 'node:fs';\n" +
    "const i = process.argv.indexOf('--task-file');\n" +
    "if (i < 0 || !fs.readFileSync(process.argv[i + 1], 'utf8').includes('Review verified greeting fix')) process.exit(13);\n" +
    "fs.appendFileSync('src/greeting.mjs', '// reviewed by fixture recipient\\n');\n" +
    "console.log('fixture recipient completed');\n");
  await fs.writeFile(path.join(root, "src", "greeting.mjs"),
    "export function greeting() { return 'before'; }\n");
  await fs.writeFile(path.join(root, "test", "greeting.test.mjs"),
    "import { test } from 'node:test';\n" +
    "import assert from 'node:assert/strict';\n" +
    "import { greeting } from '../src/greeting.mjs';\n" +
    "test('greeting fixed', () => assert.equal(greeting(), 'after'));\n");
  git("init", "-q");
  git("add", ".gitignore", "package.json", "src/greeting.mjs", "test/greeting.test.mjs");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "-q", "-m", "fixture baseline");

  client = new Client({ name: "gcf-functional-e2e", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["dist/stdio.js", "--root", root, "--allow-root", root,
      "--write", "workspace", "--bash", "safe", "--tool-mode", "standard"],
    cwd: process.cwd(),
    env: { ...process.env, CODEXBRIDGE_ROOT: root,
      CODEXBRIDGE_ALLOWED_ROOTS: root, CODEXBRIDGE_WRITE_MODE: "workspace",
      CODEXBRIDGE_BASH_MODE: "safe" }
  }));
  const tools = (await client.listTools()).tools.map((x) => x.name);
  for (const name of ["read", "preview_change_set", "apply_change_set", "bash",
    "task_plan", "task_resume", "handoff_to_agent", "read_handoff", "show_changes"]) {
    assert.ok(tools.includes(name), "missing expected MCP tool " + name);
  }
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  const initial = verified(await call("read", { path: "src/greeting.mjs" }), "read");
  assert.match(JSON.stringify(initial), /before/);
  const failed = verified(await call("bash", {
    command: "npm run test:unit", timeout_ms: 20_000
  }), "expected red test invocation");
  assert.notEqual(failed.exitCode, 0, "the original fixture should fail its unit test");
  assert.match(failed.stdout + failed.stderr, /not ok|AssertionError|ERR_ASSERTION/);

  const change = {
    path: "src/greeting.mjs",
    old_text: "'before'",
    new_text: "'after'",
    expected_replacements: 1
  };
  verified(await call("preview_change_set", { changes: [change] }), "preview");
  assert.match(await fs.readFile(path.join(root, "src", "greeting.mjs"), "utf8"), /before/);
  verified(await call("apply_change_set", { changes: [change] }), "apply");
  assert.match(await fs.readFile(path.join(root, "src", "greeting.mjs"), "utf8"), /after/);

  const green = verified(await call("bash", {
    command: "npm run test:unit", timeout_ms: 20_000
  }), "expected green test invocation");
  assert.equal(green.exitCode, 0, "fixed code should pass actual npm unit test");
  assert.match(green.stdout, /pass 1|# pass 1/);
  const changes = verified(await call("show_changes"), "show_changes");
  assert.match(JSON.stringify(changes), /src\/greeting\.mjs/);

  const task = verified(await call("task_plan", {
    goal: "Repair greeting fixture and hand off review",
    target_paths: ["src/greeting.mjs"],
    plan_steps: ["Read failing code", "Fix message", "Run unit test", "Hand off evidence"]
  }), "task_plan");
  assert.ok(task.task_id, "task_plan must persist a task ID");
  const resumed = verified(await call("task_resume"), "task_resume");
  assert.equal(resumed.active, true);
  assert.equal(resumed.task_id, task.task_id);

  verified(await call("handoff_to_agent", {
    agent: "codex", title: "Review verified greeting fix",
    plan: "Review src/greeting.mjs, preserve working tree, verify with npm run test:unit. " +
      "The ChatGPT MCP client already made the change and the unit test passed. " +
      "Do not automatically execute an agent."
  }), "handoff_to_agent");
  const handoff = verified(await call("read_handoff"), "read_handoff");
  assert.match(JSON.stringify(handoff), /Review verified greeting fix|greeting\.mjs/);

  // A real second OS process executes the existing local CLI handoff adapter
  // against this disposable fixture, then the original MCP client reviews it.
  const localExecution = spawnSync(process.execPath, [
    'scripts/codexbridge.mjs', 'execute-handoff', '--root', root,
    '--agent', 'custom',
    '--command', `"${process.execPath.replaceAll('"', '\\"')}" fixture-review-agent.mjs --task-file {{plan_file}}`,
    '--yes'
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
  assert.equal(localExecution.status, 0,
    `local handoff failed: ${localExecution.stdout || ''} ${localExecution.stderr || ''}`);
  assert.match(await fs.readFile(path.join(root, 'src', 'greeting.mjs'), 'utf8'), /reviewed by fixture recipient/);
  const localStatus = await fs.readFile(path.join(root, '.ai-bridge', 'agent-status.md'), 'utf8');
  const localDiff = await fs.readFile(path.join(root, '.ai-bridge', 'implementation-diff.patch'), 'utf8');
  assert.match(localStatus, /Agent: custom/);
  assert.match(localStatus, /Exit code: 0/);
  assert.match(localDiff, /reviewed by fixture recipient/);
  const reviewed = verified(await call('read', { path: 'src/greeting.mjs' }), 'MCP read after local handoff');
  assert.match(JSON.stringify(reviewed), /reviewed by fixture recipient/);
  const postHandoffTest = verified(await call('bash', {
    command: 'npm run test:unit', timeout_ms: 20_000
  }), 'MCP test after local handoff');
  assert.equal(postHandoffTest.exitCode, 0);
  assert.equal(verified(await call('task_resume'), 'resume after CLI').task_id, task.task_id);

  const outside = await call("write", { path: "../outside-gcf-e2e.txt", content: "BAD\n" });
  assert.equal(Boolean(outside.isError), true, "MCP path traversal write must be refused");

  console.log("PASS: real MCP read -> failing test -> preview -> edit -> passing test -> Git diff");
  console.log("PASS: MCP task persistence -> handoff -> separate CLI fixture agent -> MCP review and green retest (Native Codex not executed)");
  console.log("PASS: outside-workspace write refused; disposable fixture removed");
} finally {
  if (client) await client.close();
  await fs.rm(root, { recursive: true, force: true });
}
