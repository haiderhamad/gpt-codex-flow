// Optional independent-agent E2E: real Codex, no GCF MCP and no Notion account.
// Does not run during ordinary unit tests and never changes Codex configuration.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gcf-notion-standalone-')));
const a='agent-'+randomUUID().slice(0,8), n='memory-'+randomUUID().slice(0,8);
try {
  fs.writeFileSync(path.join(root,'AGENTS.md'),
    '# Local project instructions\\nRead the project-root NOTION_MEMORY.md before answering.\\nLocal AGENT_KEY='+a+'\\n');
  fs.writeFileSync(path.join(root,'NOTION_MEMORY.md'),
    '# Optional Notion rules\\nLocal MEMORY_KEY='+n+'\\nThis is an offline read test: do not use any Notion account or change files.\\n');
  const result=spawnSync('codex',[
    'exec','--ignore-user-config','--ephemeral','--skip-git-repo-check',
    '--sandbox','read-only','-C',root,
    'Read AGENTS.md and its referenced NOTION_MEMORY.md. Do not edit files or contact external MCP servers. Reply only with the exact two values AGENT_KEY and MEMORY_KEY found in those files.'
  ],{encoding:'utf8',timeout:90000,maxBuffer:180000});
  if(result.error) throw result.error;
  assert.equal(result.status,0,'Codex did not successfully finish detached local instructions check');
  const out=result.stdout??'';
  assert.ok(out.includes(a)&&out.includes(n),'Codex did not demonstrate reading both local files');
  assert.equal(fs.readFileSync(path.join(root,'AGENTS.md'),'utf8').includes(a),true);
  assert.equal(fs.readFileSync(path.join(root,'NOTION_MEMORY.md'),'utf8').includes(n),true);
  console.log('PASS Codex read AGENTS.md and linked NOTION_MEMORY.md without any GCF MCP, read-only and ephemeral.');
} finally {fs.rmSync(root,{recursive:true,force:true});}
