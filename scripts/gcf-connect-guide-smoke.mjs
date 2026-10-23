// Preview-only guide verification; no Codex CLI is started or configured.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeProjectRootsManifest} from '../dist/projectRootsFile.js';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cli=path.join(repo,'scripts','gcf-cli.mjs');
const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"gcf local 'preview' ")));
const root=path.join(dir,'Repo A');
const manifest=path.join(dir,"approved owner's roots.json");
async function invoke(args){
  return spawnSync(process.execPath,[cli,'connect-guide',...args],{
    cwd:repo,encoding:'utf8',timeout:10000,
    env:{...process.env,CODEXBRIDGE_HOME:path.join(dir,'other-config')}
  });
}
try{
  await fs.mkdir(root,{recursive:true});
  const git=spawnSync('git',['init','-q'],{cwd:root,encoding:'utf8'});
  assert.equal(git.status,0,git.stderr);
  await fs.writeFile(path.join(root,'.gitignore'),'.ai-bridge/\n');
  await fs.writeFile(manifest,JSON.stringify(makeProjectRootsManifest([root]))+'\n',{mode:0o600});
  const old=await fs.readFile(manifest,'utf8');
  const output=await invoke(['--manifest',manifest]);
  assert.equal(output.status,0,output.stderr);
  assert.match(output.stdout,/Native Codex registration guide \(PREVIEW ONLY\)/);
  assert.match(output.stdout,/READ ONLY/);
  assert.match(output.stdout,/Bash: OFF/);
  assert.match(output.stdout,/Codex CLI/);
  assert.match(output.stdout,/codex mcp add gpt-codex-flow --/);
  assert.doesNotMatch(output.stdout,/ChatGPT Desktop|Add server > STDIO/);
  assert.match(output.stdout,/ChatGPT connects through Cloudflare Quick Tunnel/);
  assert.match(output.stdout,/model|Model/);
  assert.match(output.stdout,/'"'"'/); // POSIX quoting of apostrophes in paths.
  assert.match(output.stdout,/--write.*off/);
  const noteOnly=await invoke(['--manifest',manifest,'--write','handoff']);
  assert.equal(noteOnly.status,0,noteOnly.stderr);
  assert.match(noteOnly.stdout,/HANDOFF NOTES ONLY/);
  assert.match(noteOnly.stdout,/--write.*handoff/);
  assert.match(noteOnly.stdout,/source edits and Bash remain disabled/);
  assert.match(noteOnly.stdout,/Git privacy: PASS/);
  const doctorGood=spawnSync(process.execPath,[cli,'doctor','--manifest',manifest],{
    cwd:repo,encoding:'utf8',timeout:10000
  });
  assert.equal(doctorGood.status,0,doctorGood.stderr);
  const reportGood=JSON.parse(doctorGood.stdout);
  assert.equal(reportGood.handoff_write_git_privacy_ready,true);
  assert.deepEqual(reportGood.privacy_warnings,[]);
  assert.notEqual((await invoke(['--manifest',manifest,'--write','workspace'])).status,0);
  assert.notEqual((await invoke(['--manifest',manifest,'--bash','safe'])).status,0);
  assert.notEqual((await invoke(['--manifest',manifest,'--transport','http'])).status,0);
  assert.notEqual((await invoke(['--manifest',path.join(dir,'missing.json')])).status,0);
  // Removal of ignore protection must block note-write onboarding, never read-only.
  await fs.writeFile(path.join(root,'.gitignore'),'# privacy missing\n');
  const unsafeReadonly=await invoke(['--manifest',manifest]);
  assert.equal(unsafeReadonly.status,0,unsafeReadonly.stderr);
  assert.match(unsafeReadonly.stdout,/Privacy warning/);
  const unsafeHandoff=await invoke(['--manifest',manifest,'--write','handoff']);
  assert.notEqual(unsafeHandoff.status,0,'unsafe Git root cannot print write-enabled command');
  assert.match(unsafeHandoff.stderr,/Refusing handoff-write registration preview/);
  const doctorUnsafe=spawnSync(process.execPath,[cli,'doctor','--manifest',manifest],{
    cwd:repo,encoding:'utf8',timeout:10000
  });
  assert.equal(doctorUnsafe.status,0,doctorUnsafe.stderr);
  const reportUnsafe=JSON.parse(doctorUnsafe.stdout);
  assert.equal(reportUnsafe.status,'READY','read-only connection should stay possible');
  assert.equal(reportUnsafe.handoff_write_git_privacy_ready,false);
  assert.equal(reportUnsafe.privacy_warnings.length,1);
  // Tracked .ai-bridge contents remain unsafe even when ignored again.
  await fs.writeFile(path.join(root,'.gitignore'),'.ai-bridge/\n');
  await fs.mkdir(path.join(root,'.ai-bridge'),{recursive:true});
  await fs.writeFile(path.join(root,'.ai-bridge','tracked.txt'),'fixture only\n');
  const tracked=spawnSync('git',['add','-f','.ai-bridge/tracked.txt'],{
    cwd:root,encoding:'utf8',timeout:10000
  });
  assert.equal(tracked.status,0,tracked.stderr);
  const trackedGuide=await invoke(['--manifest',manifest,'--write','handoff']);
  assert.notEqual(trackedGuide.status,0,'tracked metadata must block handoff');
  assert.match(trackedGuide.stderr,/contains tracked files/);
  const doctorTracked=spawnSync(process.execPath,[cli,'doctor','--manifest',manifest],{
    cwd:repo,encoding:'utf8',timeout:10000
  });
  assert.equal(doctorTracked.status,0,doctorTracked.stderr);
  const reportTracked=JSON.parse(doctorTracked.stdout);
  assert.equal(reportTracked.handoff_write_git_privacy_ready,false);
  assert.equal(reportTracked.projects[0].task_inbox_git_privacy.tracked_bridge_paths,1);
  assert.equal(await fs.readFile(manifest,'utf8'),old);
  assert.deepEqual((await fs.readdir(root)).sort(),['.ai-bridge','.git','.gitignore'].sort());
  console.log('PASS: read-only/handoff local guides generated without registering MCP, starting Codex or changing roots');
  console.log('PASS: quoted paths with spaces/apostrophes, invalid privilege escalation refused');
}finally{
  await fs.rm(dir,{recursive:true,force:true});
}
