import express from 'express';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {readProjectRootsManifestSnapshot, validateProjectRoots} from './projectRootsFile.js';
import {renderControlCenterPage} from './gcfControlCenterPage.js';
import {nativeFolderDialog, type NativeResult} from './nativeFolderPicker.js';
import {readOwnerFolders, saveOwnerFolders} from './ownerProjectStore.js';
import {codexConnectionState, connectCodex, testLocalConnection} from './ownerConnections.js';
import {chatgptQuickConnectReadiness} from './gcfQuickConnectReadiness.js';
import {inspectOwnerProjectHandoff} from './gcfTaskHandoffStatus.js';
import {previewOwnerCodexHandoff} from './gcfNativeHandoffBridge.js';
import {ownerLeadSnapshot,saveOwnerProjectLead,previewProjectTaskRouting} from './gcfLeadPreferences.js';
import {saveOwnerCodexExecutionPreferences} from './gcfCodexExecutionPreferences.js';
import {projectHistoryPath,freshProjectFolder,initializeProjectHistory} from './gcfProjectHistory.js';
import {chatgptProjectInstructions} from './gcfProjectGuidance.js';
import {initializeNotionMemory,notionMemoryStatus,optionalNotionAgentsBlock,optionalNotionPointerBlock} from './gcfNotionMemory.js';
import {createCloudflareLauncher,type CloudLauncher,type CloudAccess} from './gcfCloudflareLauncher.js';

const secret = () => randomBytes(32).toString('hex');
const equal = (a: unknown, b: string) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

/** A separate control plane. Never mounted on, proxied by, or given credentials from MCP. */
export async function startControlCenter(options: {manifest: string; port?: number; sourceRoot: string;
  pickFolder?: () => Promise<NativeResult>; approveChange?: () => Promise<boolean>;
  cloudLauncher?:CloudLauncher}) {
  if (!path.isAbsolute(options.manifest)) throw Error('Manifest must be an absolute path.');
  const app = express();
  app.disable('x-powered-by');
  let origin = '';
  let bootstrap = secret();
  const bootstrapExpires = Date.now() + 5 * 60_000;
  let session = '', csrf = '', expires = 0;
  let lastCodexTestAt = 0;
  let foldersChangedThisSession = false;
  const cloud=options.cloudLauncher??createCloudflareLauncher(options.sourceRoot,{leadManifest:options.manifest});
  let cloudActionInProgress=false;
  const picked = new Map<string,{path:string;expires:number}>();
  let windowStart = Date.now(), requests = 0;
  app.use((req, res, next) => {
    res.set({'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY',
      'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== origin.slice(7) ||
      (req.headers.origin !== undefined && req.headers.origin !== origin) ||
      (req.headers['sec-fetch-site'] && !['same-origin','none'].includes(String(req.headers['sec-fetch-site'])))) {
      res.status(403).json({error:'Owner-local Host and Origin required.'}); return;
    }
    if (req.url.includes('?')) {res.status(400).json({error:'Query parameters are not accepted.'}); return;}
    if (Date.now() - windowStart > 60_000) {windowStart = Date.now(); requests = 0;}
    if (++requests > 120) {res.status(429).json({error:'Too many requests. Wait one minute.'}); return;}
    if (!['GET','POST'].includes(req.method)) {res.sendStatus(405); return;}
    if (req.method === 'POST' && (req.headers.origin !== origin || !req.is('application/json'))) {
      res.status(403).json({error:'Same-origin JSON required.'}); return;
    }
    next();
  });
  app.use(express.json({limit:'8kb', strict:true}));
  const authenticated = (cookie: string | undefined) => Boolean(session && Date.now() < expires &&
    cookie?.split(';').filter(part => part.trim().startsWith('gcf_owner=')).length === 1 &&
    cookie.split(';').some(part => equal(part.trim(), 'gcf_owner='+session)));
  app.get('/', (req, res) => res.type('html').send(renderControlCenterPage(authenticated(req.headers.cookie) ? csrf : '')));
  let attempts = 0;
  app.post('/owner/session', (req, res) => {
    if (++attempts > 10 || !bootstrap || Date.now() >= bootstrapExpires || !equal(req.body?.code, bootstrap)) {
      res.status(401).json({error:'Invalid or expired code. Restart the Control Center for a new code.'}); return;
    }
    bootstrap = ''; session = secret(); csrf = secret(); expires = Date.now() + 20 * 60_000;
    res.cookie('gcf_owner', session, {httpOnly:true, secure:true, sameSite:'strict', path:'/', maxAge:20*60_000});
    res.json({ok:true});
  });
  app.use('/owner', (req, res, next) => {
    if (!authenticated(req.headers.cookie)) {res.status(401).json({error:'Unlock with the code in your local Terminal.'}); return;}
    if (req.method === 'POST' && !equal(req.headers['x-gcf-csrf'], csrf)) {res.status(403).json({error:'Invalid CSRF token. Reload this page.'}); return;}
    // Sliding owner inactivity timeout: a currently open Dashboard may continue
    // managing a live tunnel. Sleeping/closed dashboards still expire safely.
    expires = Date.now() + 20 * 60_000;
    res.cookie('gcf_owner', session, {httpOnly:true,secure:true,sameSite:'strict',path:'/',maxAge:20*60_000});
    next();
  });
  function snapshot() {
    return readOwnerFolders(options.manifest);
  }
  app.get('/owner/status', (_req, res) => {
    try {
      const roots = snapshot();
      res.json({sourceDirectory:options.sourceRoot, manifest:options.manifest, projects:roots.map(root => {
        try {validateProjectRoots([root]); return {path:root,name:path.basename(root),status:'ready',git:fs.existsSync(path.join(root,'.git')),history:projectHistoryPath(root),notionMemory:notionMemoryStatus(root)};}
        catch {return {path:root,name:path.basename(root),status:fs.existsSync(root)?'attention':'missing',git:false};}
      }), issue:roots.length ? '' : 'Add a folder to begin.',
      controlCenter:'Running on loopback', mcp:cloud.status().state==='tunnel_ready'?'Owner-started Cloudflare tunnel ready (ChatGPT unverified)':'No cloud client connection verified',
      activeMode:cloud.status().state==='tunnel_ready'?'Cloudflare ('+cloud.status().access+' / '+(cloud.status().projects?.length??1)+' projects)':'No MCP runtime started', savedMode:'Read only',
      permissions:{default:'read',active:cloud.status().state==='tunnel_ready'?'Cloudflare: '+cloud.status().access+' (ChatGPT unverified)':'Not checked here',restartRequired:foldersChangedThisSession},
      connectionCommands: {stdio: ['node','scripts/gcf-cli.mjs','start','--manifest',options.manifest,'--transport','stdio','--write','off','--bash','off'].map(quote).join(' '), http: ['node','scripts/gcf-cli.mjs','start','--manifest',options.manifest,'--transport','http','--write','off','--bash','off'].map(quote).join(' '), verify:['node','scripts/gcf-cli.mjs','verify','--manifest',options.manifest].map(quote).join(' ')}, clientSessions:null, modelIdentityVerified:false});
    } catch {res.json({manifest:options.manifest,projects:[],issue:'Manifest is invalid or unsafe. Inspect it in Terminal; it has not been overwritten.'});}
  });
  app.post('/owner/pick-folder', async (req,res) => {
    if (Object.keys(req.body ?? {}).length) {res.status(400).json({error:'The folder picker does not accept a path.'});return;}
    try {
      const result = await (options.pickFolder ?? (() => nativeFolderDialog('pick')))();
      if (result.cancelled) {res.json({cancelled:true});return;}
      validateProjectRoots([result.path]);
      const ticket = secret();
      picked.clear();
      picked.set(ticket,{path:result.path,expires:Date.now()+5*60_000});
      res.json({cancelled:false,path:result.path,name:path.basename(result.path),ticket,newProject:freshProjectFolder(result.path),history:projectHistoryPath(result.path),notionMemory:notionMemoryStatus(result.path)});
    } catch (error) {res.status(400).json({error:error instanceof Error?error.message:'Could not open the folder picker.'});}
  });
  app.post('/owner/projects', async (req,res) => {
    try {
      const body = req.body ?? {};
      if (!['add','remove','replace'].includes(body.action) || Object.keys(body).some(key => !['action','path','previous','ticket','access','initializeHistory','initializeNotionMemory'].includes(key)))
        throw Error('Choose Add, Remove, or Replace.');
      if (body.access !== undefined && body.access !== 'read') throw Error('This connection supports Read Only. Advanced access needs separate local authorization.');
      if(body.initializeHistory!==undefined && (body.action!=='add'||typeof body.initializeHistory!=='boolean'))throw Error('Project history can only be initialized for a newly added folder.');
      if(body.initializeNotionMemory!==undefined && (body.action!=='add'||typeof body.initializeNotionMemory!=='boolean')) throw Error('Notion memory can only be initialized when adding a folder.');
      const before = snapshot();
      if (body.action === 'add' && before.some(root => !fs.existsSync(root)))
        throw Error('Remove or replace the missing folder first.');
      let next: string[];
      if (body.action === 'remove') {
        if (typeof body.path !== 'string' || !before.includes(body.path)) throw Error('This folder is not in your list. Refresh and try again.');
        next = before.filter(root => root !== body.path);
      } else {
        const selection = typeof body.ticket === 'string' ? picked.get(body.ticket) : undefined;
        if (!selection || Date.now() > selection.expires) throw Error('Choose the folder again. This selection has expired.');
        picked.delete(body.ticket);
        validateProjectRoots([selection.path]);
        if (body.action === 'replace') {
          if (typeof body.previous !== 'string' || !before.includes(body.previous) || fs.existsSync(body.previous))
            throw Error('Select a missing folder to replace. Refresh the list and try again.');
          next = before.map(root => root === body.previous ? selection.path : root);
        } else {
          next = [...before,selection.path];
        }
      }
      if (JSON.stringify(before) === JSON.stringify(next)) throw Error('Nothing changed.');
      // Native OS dialog is a second local consent step; it is not cryptographic identity proof.
      const approved = await (options.approveChange ?? (async () => !(await nativeFolderDialog('approve')).cancelled))();
      if (!approved) {res.json({cancelled:true});return;}
      const result = saveOwnerFolders(options.manifest,before,next);
      let history:null|{state:'created'|'existing';path:string}=null;
      let historyError:string|undefined;
      if(body.action==='add' && body.initializeHistory===true){
        const added=next.find(root=>!before.includes(root));
        if(added)try{history=initializeProjectHistory(added);}catch(error){historyError=error instanceof Error?error.message:String(error);}
      }
      let notionMemory=null;
      let notionError;
      if(body.action==='add' && body.initializeNotionMemory===true){
        const added=next.find(root=>!before.includes(root));
        if(added)try{notionMemory=initializeNotionMemory(added);}catch(error){notionError=error instanceof Error?error.message:String(error);}
      }
      lastCodexTestAt = 0;
      foldersChangedThisSession = true;
      res.json({saved:true,history,historyError,notionMemory,notionError,backupCreated:Boolean(result.backup),restartRequired:true,
        projects:next.map(root => ({path:root,name:path.basename(root),status:fs.existsSync(root)?'ready':'missing'}))});
    } catch (error) {res.status(400).json({error:error instanceof Error?error.message:'Could not save the folder list.'});}
  });
  app.get('/owner/workflow', (_req,res) => {
    try {res.json({projects:ownerLeadSnapshot(options.manifest),previewOnly:true});}
    catch {res.status(400).json({error:'Owner workflow settings need review.'});}
  });
  app.post('/owner/workflow/status', (req,res) => {
    try {
      if(Object.keys(req.body??{}).join(',')!=='project')throw Error('Select one approved project.');
      res.json(inspectOwnerProjectHandoff(options.manifest,req.body.project));
    }catch(error){res.status(400).json({error:error instanceof Error?error.message:'Task status unavailable.'});}
  });
  app.post('/owner/workflow/codex-preview', async (req,res) => {
    try {
      if(Object.keys(req.body??{}).join(',')!=='project')throw Error('Select one approved project.');
      const result=await previewOwnerCodexHandoff(options.manifest,req.body.project,options.sourceRoot);
      res.json(result);
    }catch(error){res.status(400).json({error:error instanceof Error?error.message:'Codex handoff preview unavailable.'});}
  });
  app.post('/owner/workflow', (req,res) => {
    try {
      const body=req.body ?? {};
      if(body.action==='save' && Object.keys(body).sort().join(',')==='action,expected,mode,project') {
        res.json(saveOwnerProjectLead(options.manifest,body.project,body.mode,body.expected));return;
      }
      if(body.action==='save_codex' && Object.keys(body).sort().join(',')==='action,effort,expectedEffort,expectedModel,model,project') {
        res.json(saveOwnerCodexExecutionPreferences(options.manifest,body.project,body.model,body.effort,body.expectedModel,body.expectedEffort));return;
      }
      if(body.action==='preview' && Object.keys(body).every(key=>['action','project','goal','availability'].includes(key))) {
        res.json(previewProjectTaskRouting(options.manifest,body.project,body.goal,body.availability));return;
      }
      throw Error('Invalid workflow request.');
    }catch(error){res.status(400).json({error:error instanceof Error?error.message:'Workflow unavailable.'});}
  });
  // Owner-local, explicitly approved opt-in for a folder already in the manifest.
  // Never contacts Notion, changes the manifest, or modifies AGENTS.md / task data.
  app.post('/owner/project-notion-memory', async (req,res) => {
    try {
      const body=req.body??{};
      if(Object.keys(body).length!==1 || typeof body.project!=='string' || !body.project)
        throw Error('Select one approved project.');
      const project=body.project;
      if(!snapshot().includes(project)) throw Error('This project is not in your approved folders.');
      validateProjectRoots([project]);
      const current=notionMemoryStatus(project);
      if(current.status==='invalid') throw Error('Existing Notion instructions are invalid or unsafe; no files were changed.');
      if(current.enabled) {res.json({state:'existing',notionMemory:current,pointer:current.source==='file'?optionalNotionPointerBlock():null,remoteSyncVerified:false});return;}
      const approved=await (options.approveChange ?? (async()=>!(await nativeFolderDialog('enable-notion')).cancelled))();
      if(!approved) {res.json({cancelled:true});return;}
      // Recheck after the native dialog; refuse changed roots or unsafe files.
      if(!snapshot().includes(project)) throw Error('The approved project list changed. Refresh and retry.');
      validateProjectRoots([project]);
      const created=initializeNotionMemory(project);
      res.json({...created,notionMemory:notionMemoryStatus(project),pointer:optionalNotionPointerBlock(),remoteSyncVerified:false});
    } catch(error) {
      res.status(400).json({error:error instanceof Error?error.message:'Cannot enable optional Notion Memory.'});
    }
  });
  app.get('/owner/project-instructions', (req,res) => {
    try {
      const project=req.headers['x-gcf-project'];
      if(typeof project!=='string'||!snapshot().includes(project)) throw Error('Select an approved project.');
      validateProjectRoots([project]);
      res.json({project,name:path.basename(project),template:chatgptProjectInstructions(project),history:projectHistoryPath(project),notionMemory:notionMemoryStatus(project),optionalAgentsBlock:optionalNotionAgentsBlock(),optionalNotionPointerBlock:optionalNotionPointerBlock()});
    }catch(error){res.status(400).json({error:error instanceof Error?error.message:'Project unavailable.'});}
  });
  app.get('/owner/connections', async (_req,res) => {
    const state = await codexConnectionState(options.manifest,options.sourceRoot);
    const codex = state.state === 'registered' && Date.now()-lastCodexTestAt < 20*60_000
      ? {...state,state:'local_test_passed',label:'Local folder read passed',detail:'Local MCP tools read the approved folders. Open Codex to confirm its own session.'}
      : state;
    res.json({codex,
      chatgpt:chatgptQuickConnectReadiness(options.manifest,options.sourceRoot),cloudflare:cloud.status()});
  });
  app.post('/owner/cloudflare', async (req,res) => {
    const body=req.body??{};
    if(cloudActionInProgress){res.status(409).json({error:'Cloudflare is already starting or changing. Try again when the action completes.'});return;}
    try {
      if(body.action==='stop'&&Object.keys(body).length===1){
        cloudActionInProgress=true;
        res.json({cloudflare:await cloud.stop()});return;
      }
      if(body.action!=='start'||Object.keys(body).sort().join(',')!=='access,action,fullAccessConfirmed,projects'||
        !['read','edit','test','full'].includes(body.access)||typeof body.fullAccessConfirmed!=='boolean'||
        !Array.isArray(body.projects)||body.projects.length<1||body.projects.length>20||
        body.projects.some((project:unknown)=>typeof project!=='string'))
        throw Error('Choose 1–20 approved projects and one access level.');
      if(body.access==='full')throw Error('Full Access requires Advanced manual setup.');
      if(body.access!=='full'&&body.fullAccessConfirmed)throw Error('Full Access confirmation is only valid for Full Access.');
      const approvedRoots=snapshot();
      if(body.projects.some((project:string)=>!approvedRoots.includes(project)))throw Error('One or more projects are not approved.');
      const projects=validateProjectRoots(body.projects as string[]);
      if(cloud.status().state==='starting'||cloud.status().state==='tunnel_ready')throw Error('Stop the active connection before switching projects or access.');
      cloudActionInProgress=true;
      const approved=await (options.approveChange??(async()=>!(await nativeFolderDialog('connect-cloudflare')).cancelled))();
      if(!approved){res.json({cancelled:true,cloudflare:cloud.status()});return;}
      // Full Bash is granted ONLY to the exact revalidated selection, after owner-local consent.
      if(projects.some(project=>!snapshot().includes(project)))throw Error('Approved projects changed. Review the selection again.');
      const state=await cloud.start(projects,body.access as CloudAccess);
      res.json({cloudflare:state});
    } catch(error) {
      res.status(400).json({error:error instanceof Error?error.message:'Cloudflare unavailable.'});
    } finally {cloudActionInProgress=false;}
  });
  app.post('/owner/connections', async (req,res) => {
    try {
      if (Object.keys(req.body ?? {}).sort().join(',') !== 'action,client')
        throw Error('Invalid connection request.');
      if (req.body.client === 'chatgpt' && req.body.action === 'check') {
        res.json({chatgpt:chatgptQuickConnectReadiness(options.manifest,options.sourceRoot)});
        return;
      }
      if (req.body.client !== 'codex' || !['connect','test'].includes(req.body.action))
        throw Error('This client connection is not available here.');
      if (snapshot().length===0) throw Error('Add a folder first.');
      if (req.body.action === 'connect') {
        const approved=await (options.approveChange ?? (async()=>!(await nativeFolderDialog('approve')).cancelled))();
        if (!approved) {res.json({cancelled:true});return;}
      }
      if (req.body.action === 'test' && (await codexConnectionState(options.manifest,options.sourceRoot)).state !== 'registered')
        throw Error('Connect Codex first, then test the local folder connection.');
      const codex=req.body.action==='connect'
        ? await connectCodex(options.manifest,options.sourceRoot)
        : await testLocalConnection(options.manifest,options.sourceRoot);
      if (req.body.action === 'test') lastCodexTestAt = Date.now();
      res.json({codex});
    } catch(error) {res.status(400).json({error:error instanceof Error?error.message:'Connection unavailable.'});}
  });
  app.post('/owner/preview', (req, res) => {
    try {
      const body = req.body;
      if (!body || Object.keys(body).sort().join(',') !== 'action,path' ||
        !['add','remove','recover'].includes(body.action) || typeof body.path !== 'string' || body.path.length > 4096) throw Error('Choose an action and an exact absolute Git path.');
      const roots = snapshot();
      const selected = body.path;
      const missingRoots = roots.filter(root => !fs.existsSync(root));
      // A valid new project should not mysteriously fail just because a previously
      // approved root was moved. Turn Add into an explicit, reviewed recovery plan.
      const actualAction = body.action === 'add' && missingRoots.length ? 'recover' : body.action;
      let finalRoots: string[];
      let args: string[];
      if (actualAction === 'remove') {
        if (!roots.includes(selected) || roots.length < 2) throw Error('Select an exact saved root. Keep at least one approved project.');
        finalRoots = validateProjectRoots(roots.filter(root => root !== selected));
        args = ['scripts/gcf-projects-remove.mjs','--run','--output',options.manifest,'--project',selected];
      } else {
        validateProjectRoots([selected]); // Reject aliases/symlinks instead of silently approving another root.
        const retained = actualAction === 'recover' ? roots.filter(root => fs.existsSync(root)) : roots;
        if (actualAction === 'recover' && retained.length === roots.length) throw Error('No missing roots to recover. Use Add instead.');
        if(retained.includes(selected)) throw Error('This project is already saved. Choose another folder.');
        finalRoots = validateProjectRoots([...retained,selected]);
        args = ['scripts/gcf-projects-onboard.mjs','--run','--output',options.manifest,
          ...(actualAction === 'recover' ? ['--replace-missing'] : []),'--project',selected];
      }
      const command = ['node', ...args].map(quote).join(' ');
      res.json({roots:finalRoots, removedMissing:actualAction === 'recover' ? missingRoots : [], commands:['cd '+quote(options.sourceRoot),command,
        ['node','scripts/gcf-cli.mjs','verify','--manifest',options.manifest].map(quote).join(' ')],
        message:actualAction === 'recover' ? 'This review will add your project and remove only the missing saved entries shown below. Nothing has changed yet. Confirm in your local Terminal; the original settings will be backed up.' : 'Preview only. Review the changes and confirm in your local Terminal. Active connections are unchanged.'});
    } catch (error) {res.status(400).json({error:error instanceof Error ? error.message : 'Invalid preview.'});}
  });
  app.use((_req,res) => {res.sendStatus(404);});
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error?.status === 413 ? 413 : 400).json({error:'Invalid or oversized request body.'});
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve,reject) => {
    const listener = app.listen(options.port ?? 0,'127.0.0.1',(error?: Error) => error ? reject(error) : resolve(listener));
    listener.once('error',reject);
  });
  server.requestTimeout = 70_000; server.headersTimeout = 10_000;
  server.once('close',()=>{void cloud.stop();});
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing listener address.');
  origin = 'http://127.0.0.1:'+address.port;
  return {server, origin, bootstrapCode:bootstrap};
}
