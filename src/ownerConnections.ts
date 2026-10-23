import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const NAME = 'gcf-local-control-center';
async function run(command: string,args: string[],limit=16_384): Promise<{code:number;out:string}> {
  return new Promise((resolve,reject) => {
    const child=spawn(command,args,{shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,
      CODEXBRIDGE_ALLOW_HOME:'0',CODEXBRIDGE_ALLOWED_ROOTS:'',CODEBASE_BRIDGE_ALLOWED_ROOTS:''}});
    let out='',error='';const timer=setTimeout(()=>child.kill(),20_000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',part=>{out+=part;if(out.length>limit)child.kill();});
    child.stderr.on('data',part=>{error+=part;if(error.length>limit)child.kill();});
    child.once('error',err=>{clearTimeout(timer);reject(err);});
    child.once('close',code=>{clearTimeout(timer);resolve({code:code??1,out:out.slice(0,limit)});});
  });
}
function expectedArgs(manifest:string, sourceRoot:string) {
  return [path.join(sourceRoot,'scripts','gcf-cli.mjs'),'start','--transport','stdio','--manifest',manifest,'--write','off','--bash','off'];
}
export async function codexConnectionState(manifest:string,sourceRoot:string) {
  try {
    const found=await run('codex',['mcp','get',NAME,'--json']);
    if(found.code!==0) return {state:'not_configured',label:'Not connected',detail:'Connect Codex to use your approved folders.',canConnect:true,canTest:false};
    const data=JSON.parse(found.out);
    const expected=expectedArgs(manifest,sourceRoot);
    const matches=data?.enabled===true && data?.transport?.type==='stdio' &&
      data?.transport?.command===process.execPath &&
      JSON.stringify(data?.transport?.args)===JSON.stringify(expected);
    return matches
      ? {state:'registered',label:'Codex MCP registered',detail:'This connection is already saved in Codex. Test local folder access, then open Codex to confirm its client session.',canConnect:false,canTest:fs.existsSync(manifest)}
      : {state:'attention',label:'Connection needs review',detail:'An existing Codex entry uses different settings. Review it in Advanced settings.',canConnect:false,canTest:false};
  } catch {return {state:'unavailable',label:'Codex unavailable',detail:'Install or open a supported Codex CLI to connect.',canConnect:false,canTest:false};}
}
export async function connectCodex(manifest:string,sourceRoot:string) {
  const state=await codexConnectionState(manifest,sourceRoot);
  if(state.state!=='not_configured') return state;
  const args=['mcp','add',NAME,'--',process.execPath,...expectedArgs(manifest,sourceRoot)];
  const result=await run('codex',args);
  if(result.code!==0) throw Error('Codex could not save the connection. Open Advanced settings for manual setup.');
  const after=await codexConnectionState(manifest,sourceRoot);
  if(after.state!=='registered') throw Error('Codex registration could not be verified.');
  return after;
}
export async function testLocalConnection(manifest:string,sourceRoot:string) {
  const result=await run(process.execPath,[path.join(sourceRoot,'scripts','gcf-cli.mjs'),'verify','--manifest',manifest],32_768);
  if(result.code!==0) throw Error('Folder read test failed. Check that your saved folders still exist.');
  let report: any;
  try {report=JSON.parse(result.out);} catch {throw Error('Folder read test returned an unreadable result.');}
  if(report.status!=='VERIFIED_LOCAL_MCP' || report.approved_roots_match!==true || report.folder_tree_verified!==true)
    throw Error('Folder read test did not verify all approved folders.');
  return {state:'local_test_passed',label:'Local folder read passed',detail:'Approved folders were read through a separate local MCP test. This does not verify an open Codex app session.',canConnect:false,canTest:true};
}
