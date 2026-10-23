#!/usr/bin/env node
/**
 * Bounded read-only scan of Git objects reachable through local refs.
 * Outputs types and truncated object IDs only, never matched content.
 * This is not a full credential audit and cannot certify publication safety.
 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const checkout=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const MAX_OBJECTS=50000;
const MAX_BLOB_BYTES=2*1024*1024;
const MAX_TOTAL_BYTES=256*1024*1024;
const MAX_BUFFER=24*1024*1024;
const sensitivePath=/(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc|\.ssh|\.aws|\.codexbridge|\.ai-bridge|id_(?:rsa|ed25519)|credentials(?:\.[^/]*)?|secrets?\.json|[^/]+\.(?:pem|p12|pfx|key|sqlite|db))(?:\/|$)/i;
const detectors=[
  ['PRIVATE_KEY_MATERIAL',new RegExp('-----BEGIN (?:RSA|OPENSSH|EC|DSA|ENCRYPTED) PRIVATE KEY-----')],
  ['GITHUB_TOKEN_PATTERN',new RegExp('(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,}')],
  ['SERVICE_TOKEN_PATTERN',new RegExp('(?:sk-proj-|sk-live-|xox[baprs]-)[a-zA-Z0-9_-]{20,}')],
  ['AWS_ACCESS_KEY_PATTERN',new RegExp('(?:AKIA|ASIA)[A-Z0-9]{16}')],
  ['CREDENTIAL_URL_PATTERN',new RegExp('(?:https?|postgres(?:ql)?):\\/\\/[^\\s/@:]+:[^\\s/@]+@[^\\s/]+')]
];
function git(root,args,input,maxBuffer=MAX_BUFFER){
  const p=spawnSync('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{
    cwd:root,shell:false,input,encoding:null,timeout:45000,maxBuffer,
    env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0'}
  });
  if(p.error||p.status!==0)throw Error('Read-only git history inspection refused: '+args[0]);
  return p.stdout;
}
function batches(items,count=600){
  const out=[];
  for(let i=0;i<items.length;i+=count)out.push(items.slice(i,i+count));
  return out;
}
export function auditGitHistory(root=checkout){
  const objectLines=git(root,['rev-list','--objects','--all']).toString('utf8').trim().split('\n').filter(Boolean);
  if(objectLines.length>MAX_OBJECTS)throw Error('Too many reachable objects for bounded history audit.');
  const paths=new Map();
  const ids=[];
  for(const line of objectLines){
    const split=line.indexOf(' ');
    const oid=split===-1?line:line.slice(0,split);
    if(!/^[0-9a-f]{40,64}$/.test(oid))throw Error('Unexpected git object name.');
    ids.push(oid);
    if(split!==-1)paths.set(oid,line.slice(split+1));
  }
  let blobList=[], commitCount=0, treeCount=0;
  for(const chunk of batches(ids)){
    const lines=git(root,['cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      Buffer.from(chunk.join('\n')+'\n')).toString('utf8').trim().split('\n');
    if(lines.length!==chunk.length)throw Error('Git object descriptor mismatch.');
    for(let i=0;i<lines.length;i++){
      const match=/^([0-9a-f]{40,64}) (blob|tree|commit|tag) ([0-9]+)$/.exec(lines[i]);
      if(!match||match[1]!==chunk[i])throw Error('Git object descriptor invalid.');
      const size=Number(match[3]);
      if(!Number.isSafeInteger(size)||size<0)throw Error('Unexpected Git object size.');
      if(match[2]==='blob')blobList.push({oid:match[1],size,path:paths.get(match[1])||null});
      else if(match[2]==='commit')commitCount++;
      else if(match[2]==='tree')treeCount++;
    }
  }
  const findings=[];
  const add=(code,object)=>findings.push({code,object:object.oid.slice(0,12)});
  let scanned=0,binarySkipped=0,largeSkipped=0,total=0,sensitiveNames=0;
  const binaryObjects=[];
  function binaryFormat(bytes){
    if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'PNG';
    if(bytes.subarray(0,3).equals(Buffer.from([255,216,255])))return 'JPEG';
    if(bytes.subarray(0,6).toString('ascii').startsWith('GIF8'))return 'GIF';
    if(bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP')return 'WEBP';
    if(bytes.subarray(0,4).toString('ascii')==='%PDF')return 'PDF';
    return 'UNRECOGNIZED';
  }
  const scan=[];
  for(const blob of blobList){
    if(blob.path&&sensitivePath.test(blob.path)){sensitiveNames++;add('HISTORICAL_SENSITIVE_PATH',blob);}
    if(blob.size>MAX_BLOB_BYTES){largeSkipped++;continue;}
    total+=blob.size;
    if(total>MAX_TOTAL_BYTES)throw Error('Historical blob bytes exceed bounded scan; manual review required.');
    scan.push(blob);
  }
  for(const group of batches(scan,25)){
    const bytes=group.reduce((sum,b)=>sum+b.size,0);
    const output=git(root,['cat-file','--batch'],Buffer.from(group.map(b=>b.oid).join('\n')+'\n'),Math.max(MAX_BUFFER,bytes+group.length*256+1024));
    let pos=0;
    for(const blob of group){
      const newline=output.indexOf(10,pos);
      if(newline<0)throw Error('Git blob header is missing.');
      const header=output.subarray(pos,newline).toString('utf8');
      const match=/^([0-9a-f]{40,64}) blob ([0-9]+)$/.exec(header);
      if(!match||match[1]!==blob.oid||Number(match[2])!==blob.size)throw Error('Git blob contents mismatch.');
      const begin=newline+1,end=begin+blob.size;
      if(end>=output.length||output[end]!==10)throw Error('Git blob framing invalid.');
      const bytes=output.subarray(begin,end);
      if(bytes.includes(0)){
        binarySkipped++;
        const format=binaryFormat(bytes);
        binaryObjects.push({object:blob.oid.slice(0,12),format,recorded_path:blob.path});
        if(format==='UNRECOGNIZED')add('UNRECOGNIZED_BINARY_OBJECT',blob);
      }
      else{
        scanned++;
        const content=bytes.toString('utf8');
        for(const [code,regex] of detectors)if(regex.test(content))add(code,blob);
      }
      pos=end+1;
    }
    if(pos!==output.length)throw Error('Git blob batch has trailing bytes.');
  }
  const limited=findings.slice(0,80);
  return {
    status:findings.length?'REVIEW_REQUIRED':'NO_HEURISTIC_FINDINGS',
    scope:'ALL_REFS_REACHABLE_GIT_OBJECTS_NOT_WORKTREE',
    counts:{objects:ids.length,commits:commitCount,trees:treeCount,blobs:blobList.length,
      text_blobs_scanned:scanned,binary_blobs_skipped:binarySkipped,
      large_blobs_unscanned:largeSkipped,history_bytes_selected:total,
      sensitive_path_objects:sensitiveNames,findings:findings.length},
    findings:limited,truncated:findings.length>limited.length,
    binary_objects:binaryObjects,
    matched_values_exposed:false,git_index_changed:false,git_history_modified:false,
    credential_clearance:false,publication_authorized:false,
    limitations:'Heuristic historical object scan across local refs only. Blobs above 2 MiB and binary bytes not content-checked; refs/reflogs may change, encoded tokens and unrecognized credentials are not detected. Public candidate index and manual review remain separate requirements.'
  };
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==2){process.stderr.write('Usage: node scripts/gcf-git-history-audit.mjs\n');process.exitCode=2;}
  else{
    try{process.stdout.write(JSON.stringify(auditGitHistory(),null,2)+'\n');}
    catch(error){process.stderr.write('HISTORY AUDIT INCOMPLETE: '+error.message+'\n');process.exitCode=2;}
  }
}
