import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {codexConnectionState,connectCodex} from '../dist/ownerConnections.js';

const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gcf-codex-connect-')));
const bin=path.join(root,'bin');fs.mkdirSync(bin);
const saved=path.join(root,'entry.json');const manifest=path.join(root,'projects.json');fs.writeFileSync(manifest,'{}');
const cli=path.join(bin,'codex');
fs.writeFileSync(cli,`#!/usr/bin/env node
const fs=require('node:fs');
const argv=process.argv.slice(2),file=process.env.GCF_FAKE_CODEX_ENTRY;
if(argv[0]!=='mcp')process.exit(3);
if(argv[1]==='get') {if(!fs.existsSync(file))process.exit(1);process.stdout.write(fs.readFileSync(file));process.exit(0);}
if(argv[1]==='add') {const sep=argv.indexOf('--');if(sep!==3)process.exit(4);fs.writeFileSync(file,JSON.stringify({enabled:true,transport:{type:'stdio',command:argv[sep+1],args:argv.slice(sep+2)}}));process.exit(0);}
process.exit(5);
`,{mode:0o700});
const oldPath=process.env.PATH,oldEntry=process.env.GCF_FAKE_CODEX_ENTRY;
process.env.PATH=bin+path.delimiter+(oldPath??'');process.env.GCF_FAKE_CODEX_ENTRY=saved;
try {
  assert.equal((await codexConnectionState(manifest,process.cwd())).state,'not_configured');
  assert.equal((await connectCodex(manifest,process.cwd())).state,'registered');
  const entry=JSON.parse(fs.readFileSync(saved,'utf8'));
  assert.equal(entry.transport.command,process.execPath);
  assert.deepEqual(entry.transport.args,[path.join(process.cwd(),'scripts','gcf-cli.mjs'),'start','--transport','stdio','--manifest',manifest,'--write','off','--bash','off']);
  assert.equal((await connectCodex(manifest,process.cwd())).state,'registered');
  entry.transport.args.push('--bash','full');fs.writeFileSync(saved,JSON.stringify(entry));
  assert.equal((await codexConnectionState(manifest,process.cwd())).state,'attention');
  console.log('PASS isolated Codex registration: fixed read-only argv, discovery, repeat, mismatched entry refused');
} finally {
  process.env.PATH=oldPath;
  if(oldEntry===undefined)delete process.env.GCF_FAKE_CODEX_ENTRY;else process.env.GCF_FAKE_CODEX_ENTRY=oldEntry;
  fs.rmSync(root,{recursive:true,force:true});
}
