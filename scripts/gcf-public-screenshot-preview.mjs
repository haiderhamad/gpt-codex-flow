#!/usr/bin/env node
// Owner-review helper: encode current public Control Center screenshot as local JPEG
// thumbnails. Prints only a requested base64 chunk; no network or repo writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='control-center'||
  !/^(?:0|[1-9]\d{0,2})$/.test(args[1])) {
  process.stderr.write('Usage: node scripts/gcf-public-screenshot-preview.mjs control-center PART\n');
  process.exitCode=2;
}else{
  const rel='control-center-demo.png';
  const input=path.join(root,'docs/gcf-preview/screenshots',rel);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'gcf-owner-screenshot-review-'));
  try{
    const output=path.join(temp,'review.jpg');
    const result=spawnSync('/usr/bin/sips',['-s','format','jpeg','-s','formatOptions','55',
      '-Z','960','--out',output,input],{encoding:'utf8',shell:false,timeout:12000});
    if(result.error||result.status!==0)throw Error('Local image preview unavailable.');
    const data=fs.readFileSync(output);
    if(data.length>350000)throw Error('Image preview exceeds safe transfer budget.');
    const b64=data.toString('base64');
    const part=Number(args[1]),unit=13000;
    if(part>=Math.ceil(b64.length/unit))throw Error('Requested part out of range.');
    process.stdout.write(JSON.stringify({image:args[0],part,parts:Math.ceil(b64.length/unit),
      bytes:data.length,base64:b64.slice(part*unit,(part+1)*unit)})+'\n');
  }catch(e){
    process.stderr.write('VISUAL PREVIEW ERROR: '+e.message+'\n');process.exitCode=2;
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}