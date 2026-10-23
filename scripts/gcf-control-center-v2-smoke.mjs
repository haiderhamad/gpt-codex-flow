import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {startControlCenter} from '../dist/gcfControlCenter.js';
import {renderControlCenterPage} from '../dist/gcfControlCenterPage.js';
import {nativeFolderDialog} from '../dist/nativeFolderPicker.js';
import {testLocalConnection} from '../dist/ownerConnections.js';
import {chatgptProjectInstructions} from '../dist/gcfProjectGuidance.js';
import {projectHistoryPath} from '../dist/gcfProjectHistory.js';
import {readProjectRootsManifest,readProjectRootsManifestSnapshot} from '../dist/projectRootsFile.js';
const pack=JSON.parse(fs.readFileSync('package.json','utf8'));
assert.ok(pack.files.includes('scripts/gcf-ui.mjs'),'npm package must contain the Control Center launcher');
assert.equal(pack.bin.gcf,'scripts/gcf-cli.mjs');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gcf-v2-')));
const ordinary=path.join(root,'ordinary');const git=path.join(root,'git');
const projectA=path.join(root,'Project A'),projectB=path.join(root,'Project B');fs.mkdirSync(projectA);fs.mkdirSync(projectB);
assert.match(chatgptProjectInstructions(projectA),/Project A/);
assert.ok(!chatgptProjectInstructions(projectA).includes('Project B'));
assert.match(chatgptProjectInstructions(projectB),/Project B/);
assert.ok(chatgptProjectInstructions(projectB).length<=1500);
fs.mkdirSync(ordinary);fs.mkdirSync(git);fs.mkdirSync(path.join(git,'.git'));fs.writeFileSync(path.join(ordinary,'hello.txt'),'safe folder\n');
const manifest=path.join(root,'settings','projects.json');
let nextPick={cancelled:false,path:ordinary};let approve=true;let approvals=0;
const server=await startControlCenter({manifest,sourceRoot:process.cwd(),pickFolder:async()=>nextPick,approveChange:async()=>{approvals++;return approve;}});
const request=(route,method='GET',body,extra={})=>fetch(server.origin+route,{method,headers:{...(method==='POST'?{origin:server.origin,'content-type':'application/json'}:{}),...extra},body:method==='POST'?JSON.stringify(body):undefined});
try {
  assert.equal((await request('/owner/status')).status,401);
  assert.equal((await request('/owner/projects','POST',{action:'add',path:ordinary},{authorization:'Bearer fake'})).status,401);
  assert.equal((await request('/owner/pick-folder','POST',{}, {origin:'https://evil.test'})).status,403);
  const unlocked=await request('/owner/session','POST',{code:server.bootstrapCode});assert.equal(unlocked.status,200);
  const cookie=unlocked.headers.get('set-cookie').split(';')[0];
  const html=await (await request('/','GET',undefined,{cookie})).text();
  const csrf=html.match(/const csrf="([a-f0-9]{64})"/)?.[1];assert.ok(csrf);
  const inlineJs=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];assert.ok(inlineJs);
  for (const platform of ['win32','darwin','linux']) {
    const page=renderControlCenterPage(csrf,platform);
    assert.ok(page.includes('const hostPlatform='+JSON.stringify(platform)), 'explicit host platform: '+platform);
    assert.ok(page.includes('id="cloud-terminal-label"'));
    assert.ok(page.includes('Set-Location -LiteralPath'),'PowerShell command path supported');
    assert.ok(page.includes('Windows PowerShell'),'Windows copy guidance supported');
    assert.ok(page.includes('macOS Terminal'),'macOS copy guidance supported');
    assert.doesNotThrow(()=>new vm.Script(page.match(/<script>([\s\S]*?)<\/script>/)?.[1]),platform+' inline JS parses');
  }
  assert.doesNotThrow(()=>new vm.Script(inlineJs,{filename:'gcf-inline-dashboard.js'}),'Control Center inline JavaScript must parse');
  assert.match(inlineJs,/connect\.hidden=codexRegistered/, 'registered Codex button must be hidden instead of confusing disabled control');
  assert.match(inlineJs,/await refreshConnections\(\);\}\}/, 'connection button must refresh its final registered state');
  // UX copy must distinguish connection readiness from a verified live client.
  for (const expected of ['1. Projects','2. Connections','3. Workflow','4. Status',
    'GPT Codex Flow','Connect securely through Cloudflare.',
    'No live client session verified','id="unlock"','id="add-folder"',
     'id="chatgpt-permissions-help"','id="cloudflare-connection-setup"',
     'id="cloud-access"','id="cloud-project"','id="cloud-command-copy"','id="cloud-start"','id="cloud-stop"','id="cloud-url-copy"','id="cloud-url-panel"',
     'Full Access (Advanced)','Edit &amp; Test','cloud-handoff-policy','cloud-full-confirm','manual fallback','read:[\'handoff\',\'off\']','Handoff is available at every access level','id="chatgpt-project-guide"',
     'id="instructions-project"','id="instructions-copy"','id="history-init"',
     'Settings → Plugins','Allow read actions',
     'https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt']) {
    assert.ok(html.includes(expected),'Missing Control Center UX element: '+expected);
  }
  const h={cookie,'x-gcf-csrf':csrf};
  assert.equal((await request('/owner/pick-folder','POST',{}, {cookie})).status,403);
  assert.equal((await request('/owner/projects','POST',{action:'add',path:ordinary},h)).status,400);
  let picked=await request('/owner/pick-folder','POST',{},h);assert.equal(picked.status,200);
  let ticket=(await picked.json()).ticket;
  approve=false;
  let save=await request('/owner/projects','POST',{action:'add',ticket,access:'read'},h);
  assert.equal((await save.json()).cancelled,true);assert.equal(fs.existsSync(manifest),false);
  assert.equal((await request('/owner/projects','POST',{action:'add',ticket,access:'read'},h)).status,400);
  approve=true;
  nextPick={cancelled:true};assert.equal((await (await request('/owner/pick-folder','POST',{},h)).json()).cancelled,true);
  nextPick={cancelled:false,path:ordinary};ticket=(await (await request('/owner/pick-folder','POST',{},h)).json()).ticket;
  assert.equal((await request('/owner/projects','POST',{action:'add',ticket,access:'edit'},h)).status,400);
  assert.equal(fs.existsSync(manifest),false,'browser edit request must not create authorization');
  nextPick={cancelled:false,path:ordinary};ticket=(await (await request('/owner/pick-folder','POST',{},h)).json()).ticket;
  save=await request('/owner/projects','POST',{action:'add',ticket,access:'read'},h);assert.equal(save.status,200);
  assert.equal((await (await request('/owner/status','GET',undefined,{cookie})).json()).permissions.restartRequired,true);
  assert.deepEqual(readProjectRootsManifest(manifest),[ordinary]);
  assert.equal((await request('/owner/projects','POST',{action:'add',path:git,access:'edit'},h)).status,400);
  nextPick={cancelled:false,path:ordinary};ticket=(await (await request('/owner/pick-folder','POST',{},h)).json()).ticket;
  assert.equal((await request('/owner/projects','POST',{action:'add',ticket,access:'read'},h)).status,400);
  const alias=path.join(root,'alias');fs.symlinkSync(ordinary,alias);
  nextPick={cancelled:false,path:alias};assert.equal((await request('/owner/pick-folder','POST',{},h)).status,400);
  nextPick={cancelled:false,path:git};ticket=(await (await request('/owner/pick-folder','POST',{},h)).json()).ticket;
  assert.equal((await request('/owner/projects','POST',{action:'add',ticket,access:'read'},h)).status,200);
  assert.deepEqual(readProjectRootsManifest(manifest),[ordinary,git]);
  assert.equal((await request('/owner/project-instructions','GET',undefined,{cookie,'x-gcf-project':projectA})).status,400,'unapproved project must not expose instructions');
  assert.equal((await request('/owner/project-instructions','GET',undefined,{cookie,'x-gcf-project':ordinary})).status,200);
  nextPick={cancelled:false,path:projectA};picked=await (await request('/owner/pick-folder','POST',{},h)).json();assert.equal(picked.newProject,true);assert.equal(picked.history,null);
  save=await request('/owner/projects','POST',{action:'add',ticket:picked.ticket,access:'read',initializeHistory:true},h);
  assert.equal(save.status,200);assert.equal((await save.json()).history?.state,'created');
  assert.ok(fs.readFileSync(path.join(projectA,'docs/PROJECT_HISTORY.md'),'utf8').includes('Project A'));
  assert.equal(projectHistoryPath(projectA),'docs/PROJECT_HISTORY.md');
  let tpl=await (await request('/owner/project-instructions','GET',undefined,{cookie,'x-gcf-project':projectA})).json();
  assert.match(tpl.template,/Project A/);assert.ok(tpl.template.length<=1500);
  const original=fs.readFileSync(path.join(projectA,'docs/PROJECT_HISTORY.md'),'utf8');
  nextPick={cancelled:false,path:projectB};picked=await (await request('/owner/pick-folder','POST',{},h)).json();
  save=await request('/owner/projects','POST',{action:'add',ticket:picked.ticket,access:'read',initializeHistory:false},h);
  assert.equal(save.status,200);assert.equal(fs.existsSync(path.join(projectB,'docs/PROJECT_HISTORY.md')),false);
  tpl=await (await request('/owner/project-instructions','GET',undefined,{cookie,'x-gcf-project':projectB})).json();
  assert.match(tpl.template,/Project B/);assert.ok(!tpl.template.includes('Project A'));
  assert.equal(fs.readFileSync(path.join(projectA,'docs/PROJECT_HISTORY.md'),'utf8'),original);
  assert.equal((await request('/owner/project-instructions','GET',undefined,{'x-gcf-project':projectA})).status,401);
  assert.equal((await request('/owner/projects','POST',{action:'remove',path:projectA},h)).status,200);
  assert.equal((await request('/owner/projects','POST',{action:'remove',path:projectB},h)).status,200);
  assert.equal((await request('/owner/connections','POST',{client:'codex',action:'test'},h)).status,400);
  assert.equal((await testLocalConnection(manifest,process.cwd())).state,'local_test_passed');
  assert.equal((await request('/owner/connections','POST',{client:'chatgpt',action:'connect'},h)).status,400);
  let status=await (await request('/owner/status','GET',undefined,{cookie})).json();
  assert.deepEqual(status.projects.map(p=>p.git),[false,true]);
  fs.renameSync(ordinary,path.join(root,'moved'));
  status=await (await request('/owner/status','GET',undefined,{cookie})).json();assert.equal(status.projects[0].status,'missing');
  nextPick={cancelled:false,path:path.join(root,'moved')};ticket=(await (await request('/owner/pick-folder','POST',{},h)).json()).ticket;
  assert.equal((await request('/owner/projects','POST',{action:'replace',previous:ordinary,ticket},h)).status,200);
  assert.deepEqual(readProjectRootsManifest(manifest),[path.join(root,'moved'),git]);
  assert.equal((await request('/owner/projects','POST',{action:'remove',path:git},h)).status,200);
  assert.equal(fs.existsSync(git),true);
  assert.equal((await request('/owner/projects','POST',{action:'remove',path:path.join(root,'moved')},h)).status,200);
  assert.deepEqual(readProjectRootsManifestSnapshot(manifest),[]);
  assert.throws(()=>readProjectRootsManifest(manifest));
  assert.equal(fs.existsSync(path.join(root,'moved','hello.txt')),true);
  assert.ok(fs.readdirSync(path.dirname(manifest)).filter(f=>f.includes('.backup-')).length>=3);
  assert.ok(approvals>=4);
  const macPick=await nativeFolderDialog('pick',async (command,args)=>{assert.equal(command,'osascript');assert.ok(args.includes('POSIX path of (choose folder with prompt "Choose a folder for GPT Codex Flow")'));return {code:0,stdout:git+'\n',stderr:''};},'darwin');
  assert.deepEqual(macPick,{cancelled:false,path:git});
  assert.deepEqual(await nativeFolderDialog('pick',async()=>({code:1,stdout:'',stderr:'User canceled. (-128)'}),'darwin'),{cancelled:true});
  // Regression: Cloudflare's "Allow" is a confirmation, not a path to parse.
  const macCloudAllow=await nativeFolderDialog('connect-cloudflare',async (command,args)=>{
    assert.equal(command,'osascript');
    assert.ok(args.some(arg=>arg.includes('Start a public Cloudflare connection')));
    return {code:0,stdout:'Allow',stderr:''};
  },'darwin');
  assert.deepEqual(macCloudAllow,{cancelled:false,path:''});
  assert.deepEqual(await nativeFolderDialog('connect-cloudflare',async()=>({code:0,stdout:'Cancel',stderr:''}),'darwin'),{cancelled:true});
  assert.deepEqual(await nativeFolderDialog('connect-cloudflare',async()=>({code:1,stdout:'',stderr:'User canceled. (-128)'}),'darwin'),{cancelled:true});
  assert.deepEqual(await nativeFolderDialog('approve',async()=>({code:0,stdout:'Allow',stderr:''}),'darwin'),{cancelled:false,path:''});
  const winPick=await nativeFolderDialog('pick',async(command,args)=>{assert.equal(command,'powershell.exe');assert.equal(args.includes('-Command'),true);return {code:0,stdout:'C:\\Projects\\Example\n',stderr:''};},'win32');
  assert.equal(winPick.cancelled,false);
  // A Dashboard that remains active must be able to disconnect after 20 min.
  const actualNow=Date.now;
  try {
    Date.now=()=>actualNow()+19*60_000;
    let live=await request('/owner/connections','GET',undefined,{cookie});
    assert.equal(live.status,200,'valid owner activity refreshes the session');
    assert.match(live.headers.get('set-cookie')||'',/gcf_owner=/);
    Date.now=()=>actualNow()+22*60_000;
    live=await request('/owner/connections','GET',undefined,{cookie});
    assert.equal(live.status,200,'refreshed owner session remains usable past original timeout');
    Date.now=()=>actualNow()+44*60_000;
    assert.equal((await request('/owner/connections','GET',undefined,{cookie})).status,401,'idle sessions still expire');
  } finally {Date.now=actualNow;}
  console.log('PASS native pick/cancel, non-Git and Git approval, duplicate/symlink denial, missing replacement, remove without deletion, backups, empty manifest fail-closed, session/Origin/CSRF');
}finally{await new Promise(resolve=>server.server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
