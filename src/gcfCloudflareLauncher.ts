/** Supervised, owner-local Cloudflare Quick Tunnel lifecycle. Never mounts owner routes on MCP. */
import {randomBytes} from 'node:crypto';
import {spawn, type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateProjectRoots} from './projectRootsFile.js';

export type CloudAccess = 'read'|'edit'|'test'|'full';
export const CLOUD_ACCESS_MODES: Readonly<Record<CloudAccess,{write:'handoff'|'workspace';bash:'off'|'safe'|'full'}>> = Object.freeze({
  read:{write:'handoff',bash:'off'},
  edit:{write:'workspace',bash:'off'},
  test:{write:'workspace',bash:'safe'},
  full:{write:'workspace',bash:'full'}
});
export interface CloudState {
  state:'stopped'|'starting'|'tunnel_ready'|'error';
  project?:string;
  projects?:string[];
  access?:CloudAccess;
  message:string;
  /** A bearer secret. Return only from authenticated owner-local routes. Never log it. */
  serverUrl?:string;
}
export interface CloudLauncher {
  status(): CloudState;
  start(projects:string[],access:CloudAccess):Promise<CloudState>;
  stop():Promise<CloudState>;
}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function unusedLocalPort():Promise<number>{
  const listener=createServer();
  await new Promise<void>((ok,no)=>{listener.once('error',no);listener.listen(0,'127.0.0.1',ok);});
  const a=listener.address();if(!a||typeof a==='string')throw Error('Could not reserve local MCP port.');
  await new Promise<void>((ok,no)=>listener.close(error=>error?no(error):ok()));
  return a.port;
}
function launcherEnvironment(projects:string[],port:number,token:string,access:CloudAccess,leadManifest?:string):NodeJS.ProcessEnv{
  const base=Object.fromEntries(Object.entries(process.env).filter(([k])=>
    !k.startsWith('GCF_')&&!k.startsWith('CODEBASE_BRIDGE_')&&
    !['NODE_OPTIONS','NODE_PATH','PORT','HOST'].includes(k)
  ));
  const mode=CLOUD_ACCESS_MODES[access];
  return {...base,GCF_ROOT:projects[0],GCF_ALLOWED_ROOTS:projects.join(path.delimiter),
    GCF_ALLOW_HOME:'0',GCF_HOST:'127.0.0.1',
    GCF_PORT:String(port),GCF_TUNNEL_MODE:'1',
    GCF_HTTP_AUTH_MODE:'legacy',
    GCF_HTTP_TOKEN:token,
    GCF_WRITE_MODE:mode.write,GCF_BASH_MODE:mode.bash,
    GCF_INHERIT_ENV:'0',GCF_CODEX_SESSIONS:'off',
    ...(leadManifest?{GCF_OWNER_LEAD_MANIFEST:leadManifest}:{})};
}
function cloudflaredBinary():string{
  const binary=process.platform==='win32'?'cloudflared.exe':'cloudflared';
  const local=path.join(os.homedir(),'.gcf','bin',binary);
  return fs.existsSync(local)?local:binary;
}
export function createCloudflareLauncher(sourceRoot:string,options:{cloudflaredPath?:string;leadManifest?:string}={}):CloudLauncher{
  let server:ChildProcess|null=null, tunnel:ChildProcess|null=null;
  let state:CloudState={state:'stopped',message:'Not running'};
  let generation=0;
  const reset=(message='Stopped')=>{
    ++generation;
    const t=tunnel,s=server;tunnel=null;server=null;
    if(t&&!t.killed) t.kill('SIGTERM');
    if(s&&!s.killed) s.kill('SIGTERM');
    state={state:'stopped',message};
  };
  const observe=(child:ChildProcess,label:string,epoch:number)=>{
    child.once('exit',()=>{if(epoch===generation&&state.state!=='stopped')reset(label+' stopped.');});
    child.once('error',()=>{if(epoch===generation&&state.state!=='stopped')reset(label+' could not start.');});
  };
  return {
    status(){return {...state};},
    async stop(){reset();return {...state};},
    async start(projects,access){
      if(state.state!=='stopped'&&state.state!=='error')throw Error('Stop the existing Cloudflare connection before starting another.');
      if(!Object.hasOwn(CLOUD_ACCESS_MODES,access))throw Error('Invalid access level.');
      const approved=validateProjectRoots(projects);
      const project=approved[0];
      if(!fs.existsSync(path.join(sourceRoot,'dist','http.js')))throw Error('Build the MCP runtime before connecting.');
      reset('Starting');
      const epoch=generation;
      state={state:'starting',project,projects:approved,access,message:'Starting the selected-project local MCP server…'};
      let port=0;
      try{
        port=await unusedLocalPort();
        if(epoch!==generation)throw Error('Connection stopped.');
        const token=randomBytes(32).toString('hex');
        const local='http://127.0.0.1:'+port;
        server=spawn(process.execPath,[path.join(sourceRoot,'dist','http.js')],{
          cwd:sourceRoot,env:launcherEnvironment(approved,port,token,access,options.leadManifest),stdio:['ignore','ignore','pipe'],shell:false
        });
        observe(server,'Local MCP',epoch);
        // Do not forward raw output: errors may contain private paths or credentials.
        server.stderr?.resume();
        let online=false;
        for(let i=0;i<100;i++){
          if(epoch!==generation)throw Error('Connection stopped.');
          if(!server||server.exitCode!==null)throw Error('Local MCP server exited before it became ready.');
          try{
            const response=await fetch(local+'/healthz',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(800)});
            if(response.ok){online=true;break;}
          }catch{}
          await delay(120);
        }
        if(!online)throw Error('Local MCP health check did not succeed.');
        if(epoch!==generation)throw Error('Connection stopped.');
        state={state:'starting',project,projects:approved,access,message:'Opening Cloudflare Quick Tunnel…'};
        const publicHost=await new Promise<string>((resolve,reject)=>{
          const child=spawn(options.cloudflaredPath??cloudflaredBinary(),['tunnel','--url',local],{cwd:sourceRoot,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GCF_')&&!k.startsWith('CODEBASE_BRIDGE_'))),stdio:['ignore','ignore','pipe'],shell:false});
          tunnel=child;observe(child,'Cloudflare',epoch);
          let partial='';
          let settled=false;
          const timer=setTimeout(()=>finish(Error('Cloudflare did not return a public URL. Check cloudflared installation/network.')),45_000);
          function finish(error?:Error,host?:string){
            if(settled)return;settled=true;clearTimeout(timer);
            error?reject(error):resolve(host!);
          }
          child.on('error',()=>finish(Error('Could not launch cloudflared. Install it and retry.')));
          child.on('exit',()=>finish(Error('Cloudflare exited before returning a URL.')));
          child.stderr?.on('data',(part:Buffer)=>{
            partial=(partial+String(part)).slice(-5000);
            const match=partial.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
            if(match)finish(undefined,match[0].toLowerCase());
          });
        });
        if(epoch!==generation)throw Error('Connection stopped.');
        const url=new URL(publicHost+'/mcp');
        url.searchParams.set('gcf_token',token);
        state={state:'tunnel_ready',project,projects:approved,access,message:'Cloudflare ready for '+approved.length+' project(s). Add the private URL in ChatGPT; client not verified yet.',serverUrl:url.toString()};
        return {...state};
      }catch(error){
        if(epoch===generation){reset();state={state:'error',project,projects:approved,access,message:error instanceof Error?error.message:'Connection failed.'};}
        throw Error(epoch===generation?state.message:(error instanceof Error?error.message:'Connection stopped.'));
      }
    }
  };
}
