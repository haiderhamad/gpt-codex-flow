// M21 security regression tests: bounded, read-only Skill-package resources.
// Uses real filesystem operations and no model or network calls.
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {listSkillResources,readSkillResource} from '../dist/skillResources.js';
import {makeProjectRootsManifest} from '../dist/projectRootsFile.js';

const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gcf-skill-resources-')));
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const workspaceA=path.join(root,'workspace-a');
const workspaceB=path.join(root,'workspace-b');
const outside=path.join(root,'outside');
const manifest=path.join(root,'roots.json');
const selection={name:'fixture-skill',source:'workspace',includeGlobal:false};
const workspace=(dir)=>({id:'test-'+path.basename(dir),root:dir,openedAt:new Date(0).toISOString()});
const resource=(...parts)=>path.join(workspaceA,'.codex','skills','fixture',...parts);
let client;

try {
  await Promise.all([fs.mkdir(workspaceA,{recursive:true}),fs.mkdir(workspaceB,{recursive:true}),fs.mkdir(outside,{recursive:true})]);
  await fs.mkdir(path.join(workspaceA,'.git'));
  await fs.mkdir(resource('references','nested'),{recursive:true});
  await fs.writeFile(resource('SKILL.md'),'---\nname: fixture-skill\ndescription: M21 test fixture\n---\n');
  await fs.writeFile(resource('references','nested','guide.md'),'hello M21\n');
  await fs.writeFile(path.join(outside,'private.md'),'outside secret\n');

  // Verify the actual Node-to-Darwin mechanism before relying on it: Node does
  // not publish O_NOFOLLOW_ANY, but numeric open flags reach the kernel.
  const protectedFlags=fsSync.constants.O_RDONLY|0x20000000;
  const clean=await fs.open(resource('references','nested','guide.md'),protectedFlags)
    .then(async(handle)=>{await handle.close();return true;})
    .catch(()=>false);
  const direct=path.join(resource('references'),'direct-swap');
  await fs.symlink(outside,direct);
  const swapped=await fs.open(path.join(direct,'private.md'),protectedFlags)
    .then(async(handle)=>{await handle.close();return false;})
    .catch((error)=>error?.code==='ELOOP');
  await fs.rm(direct);
  assert.equal(clean,true,'Node must accept whole-path no-follow for ordinary files before Skill reads can be enabled');
  assert.equal(swapped,true,'whole-path no-follow must reject an intermediate symlink');

  const basic=await readSkillResource(workspace(workspaceA),selection,{resource_path:'references/nested/guide.md'});
  assert.equal(basic.text,'hello M21\n');
  assert.equal(basic.complete,true);
  assert.equal(basic.total_bytes,10);
  assert.equal(Object.hasOwn(basic,'sha256'),false,'full-file hashing must not force a whole-file read');
  await assert.rejects(readSkillResource(workspace(workspaceA),selection,{resource_path:'references/../SKILL.md'}),/outside approved|relative POSIX/);
  console.log('PASS: bounded normal resource read and traversal rejection');

  // Simulate a parent directory replacement after the resource path was part
  // of an ordinary package tree.  Both the package reader and the kernel path
  // resolution must refuse the new symlink; no outside text may be returned.
  const replaced=path.join(resource('references'),'replaced');
  await fs.mkdir(replaced);
  await fs.writeFile(path.join(replaced,'private.md'),'original package file\n');
  await fs.rm(replaced,{recursive:true});
  await fs.symlink(outside,replaced);
  await assert.rejects(readSkillResource(workspace(workspaceA),selection,{resource_path:'references/replaced/private.md'}));
  console.log('PASS: intermediate-directory symlink replacement denied by Node/Darwin whole-path no-follow');

  // Grow the file immediately before the module's bounded handle.read call.
  // The FileHandle method hook makes this TOCTOU regression deterministic
  // without adding a production-only test hook to the resource implementation.
  const growing=resource('references','nested','growing.md');
  await fs.writeFile(growing,'x'.repeat(100_000));
  const growingIdentity=await fs.stat(growing);
  const probeHandle=await fs.open(growing,'r');
  const fileHandlePrototype=Object.getPrototypeOf(probeHandle);
  await probeHandle.close();
  const originalRead=fileHandlePrototype.read;
  let grew=false;
  fileHandlePrototype.read=async function(...args){
    const identity=await this.stat();
    if(!grew&&identity.dev===growingIdentity.dev&&identity.ino===growingIdentity.ino){
      grew=true;await fs.appendFile(growing,'y');
    }
    return originalRead.apply(this,args);
  };
  try {
    await assert.rejects(readSkillResource(workspace(workspaceA),selection,{
      resource_path:'references/nested/growing.md',max_bytes:100_000
    }),/changed while reading/);
  } finally { fileHandlePrototype.read=originalRead; }
  assert.equal(grew,true);
  console.log('PASS: concurrent file mutation is rejected after a bounded read');

  // The public MCP surface is available only after the capability and direct
  // security tests above pass.  Verify both handlers are read-only and retain
  // the same traversal boundary over the real stdio transport.
  await fs.writeFile(manifest,JSON.stringify(makeProjectRootsManifest([workspaceA]))+'\n',{mode:0o600});
  client=new Client({name:'m21-skill-resource-test',version:'1.0.0'},{capabilities:{}});
  await client.connect(new StdioClientTransport({
    command:process.execPath,
    args:[path.join(repo,'scripts','gcf-cli.mjs'),'start','--manifest',manifest,'--transport','stdio','--write','off','--bash','off'],
    cwd:repo,
    env:{...process.env,GCF_ALLOW_HOME:'1',GCF_ROOT:workspaceA}
  }));
  const tools=(await client.listTools()).tools;
  for(const name of ['list_skill_resources','read_skill_resource']){
    const tool=tools.find((item)=>item.name===name);
    assert.ok(tool,'M21 MCP tool missing: '+name);
    assert.equal(tool.annotations?.readOnlyHint,true,'M21 MCP tool must be read-only: '+name);
  }
  const mcpListed=await client.callTool({name:'list_skill_resources',arguments:{
    name:'fixture-skill',source:'workspace',include_global_skills:false
  }});
  assert.equal(Boolean(mcpListed.isError),false,JSON.stringify(mcpListed));
  const read=await client.callTool({name:'read_skill_resource',arguments:{
    name:'fixture-skill',source:'workspace',include_global_skills:false,
    resource_path:'references/nested/guide.md'
  }});
  assert.equal(Boolean(read.isError),false,JSON.stringify(read));
  assert.match(read.content.find((item)=>item.type==='text')?.text??'',/Text \(JSON string\): "hello M21\\n"/);
  const traversal=await client.callTool({name:'read_skill_resource',arguments:{
    name:'fixture-skill',source:'workspace',include_global_skills:false,
    resource_path:'references/../SKILL.md'
  }});
  assert.equal(Boolean(traversal.isError),true,'MCP traversal must be denied');
  await client.close();client=undefined;
  console.log('PASS: read-only MCP handlers expose only bounded, traversal-safe Skill resources');

  // Exhaust a directory with non-resource entries.  The scan must stop by
  // entries examined, rather than allocating/visiting an unbounded tree.
  const noisy=resource('references','noisy');
  await fs.mkdir(noisy);
  await Promise.all(Array.from({length:2100},(_,i)=>fs.writeFile(path.join(noisy,`entry-${String(i).padStart(4,'0')}.bin`),'x')));
  const listed=await listSkillResources(workspace(workspaceA),selection,{limit:50});
  assert.equal(listed.scan_limit_reached,true);
  assert.ok(listed.entries_examined<=listed.scan_entry_limit);
  assert.equal(listed.scan_entry_limit,2000);
  console.log('PASS: directory resource scan is capped by examined entries');

  // A selected workspace may not use a similarly named Skill from a different
  // workspace.  This guards resource reads from cross-workspace path leakage.
  await assert.rejects(readSkillResource(workspace(workspaceB),selection,{resource_path:'references/nested/guide.md'}),/Skill not found/);
  console.log('PASS: workspace isolation prevents cross-workspace Skill reads');
} finally {
  await client?.close().catch(()=>undefined);
  await fs.rm(root,{recursive:true,force:true});
}
