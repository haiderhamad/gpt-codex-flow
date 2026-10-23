import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {readProjectRootsManifest} from './projectRootsFile.js';

/** Local-only readiness check. It does not start a tunnel or prove ChatGPT Web is connected. */
export function chatgptQuickConnectReadiness(
  manifest: string,
  sourceRoot: string,
  probeCloudflared: () => boolean = () => {
    const result = spawnSync('cloudflared',['--version'],{
      timeout:3000,encoding:'utf8',shell:false,stdio:'ignore'
    });
    return result.status === 0;
  }
) {
  const checks: Array<{key:string;label:string;ready:boolean}> = [];
  let validFolders = false;
  try {
    validFolders = readProjectRootsManifest(manifest).length > 0;
  } catch { /* Missing or invalid owner allowlists must fail closed. */ }
  checks.push({key:'folders',label:'An approved folder is ready',ready:validFolders});
  const compiled = fs.existsSync(path.join(sourceRoot,'dist','http.js'));
  checks.push({key:'server',label:'Local MCP build is available',ready:compiled});
  let cloudflared = false;
  try {cloudflared = probeCloudflared() || fs.existsSync(path.join(os.homedir(),'.codexbridge','bin',process.platform==='win32'?'cloudflared.exe':'cloudflared'));} catch {/* Missing binary is not a connection failure. */}
  checks.push({key:'cloudflared',label:'Cloudflare Quick Tunnel is installed',ready:cloudflared});
  // Manual Cloudflare Quick Tunnel already uses a GCF access token in its URL.
  // ChatGPT's "No authentication" means no OAuth handshake, NOT anonymous MCP access.
  checks.push({key:'token',label:'Access-token protected Cloudflare launcher is available',ready:compiled});
  const prerequisitesReady = validFolders && compiled && cloudflared;
  return {
    state:prerequisitesReady?'ready_to_start':'setup_incomplete',
    label:prerequisitesReady?'Ready for Cloudflare setup':'Setup needs attention',
    detail:prerequisitesReady
      ? 'Choose one project and access level, then Start Cloudflare. A local Mac approval is required; ChatGPT app registration remains manual.'
      : 'Complete the local MCP build and install cloudflared before starting the connection.',
    transport:'cloudflare-quick',
    manualStartOnly:false,
    authenticationRequired:true,
    externalConnectionStarted:false,
    clientConnectionVerified:false,
    canConnect:prerequisitesReady,
    canTest:false,
    canCheck:true,
    checks
  };
}
