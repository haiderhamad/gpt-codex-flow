#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {startControlCenter} from '../dist/gcfControlCenter.js';
const args=process.argv.slice(2);
let manifest=path.join(process.env.GCF_HOME ? path.resolve(process.env.GCF_HOME) : path.join(os.homedir(),'.gcf'),'gpt-codex-flow','projects.json');
let port=0, open=true;
for(let i=0;i<args.length;i++) {
  if(args[i]==='--no-open') open=false;
  else if(args[i]==='--manifest' && args[i+1]) manifest=args[++i];
  else if(args[i]==='--port' && args[i+1]) {port=Number(args[++i]); if(!Number.isInteger(port)||port<1||port>65535) throw Error('Invalid port');}
  else throw Error('Usage: npm run gcf:ui -- [--no-open] [--port 8790] [--manifest /absolute/projects.json]');
}
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {server,origin,bootstrapCode}=await startControlCenter({manifest,port,sourceRoot});
console.log('GPT Codex Flow Control Center: '+origin+'\nLocal unlock code (one use, expires in 5 minutes): '+bootstrapCode+'\nPaste this code into the page. Keep this Terminal open. Session expires in 20 minutes.\nNo MCP runtime or tunnel started. Press Ctrl+C to stop.');
if(open) {
  const command=process.platform==='darwin'?'open':process.platform==='win32'?'explorer.exe':'xdg-open';
  const child=spawn(command,[origin],{stdio:'ignore',shell:false});
  child.on('error',()=>console.error('Open the local URL above in your browser.')); child.unref();
}
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>process.exit(0)));
