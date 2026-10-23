#!/usr/bin/env node
/**
 * Read-only privacy and integrity preflight for the current public Control Center screenshot.
 * PNG headers/chunks can be audited here; visible pixel text CANNOT be cleared automatically.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=[
  'docs/gcf-preview/screenshots/control-center-demo.png'
];
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
const CRC_TABLE=Array.from({length:256},(_,i)=>{
  let c=i;
  for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;
  return c>>>0;
});
function crc32(buffer,start,end){
  let c=0xffffffff;
  for(let i=start;i<end;i++)c=CRC_TABLE[(c^buffer[i])&255]^(c>>>8);
  return (c^0xffffffff)>>>0;
}
function inspect(rel){
  const file=path.join(root,rel);
  const info=fs.lstatSync(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>5*1024*1024)throw Error('Public screenshot is not bounded regular file: '+rel);
  const png=fs.readFileSync(file);
  if(!png.subarray(0,8).equals(signature))throw Error('Public screenshot is not PNG: '+rel);
  let pos=8,chunks=0,idat=0,ihdr=0,iend=0,width=0,height=0;
  const flagged=[];
  const chunkNames={};
  while(pos<png.length){
    if(pos+12>png.length)throw Error('Truncated PNG chunk: '+rel);
    const size=png.readUInt32BE(pos),type=png.subarray(pos+4,pos+8).toString('ascii');
    const end=pos+12+size;
    if(size>5*1024*1024||end>png.length)throw Error('Oversized/truncated PNG chunk: '+rel);
    if(!/^[A-Za-z]{4}$/.test(type))throw Error('Unrecognized PNG chunk type: '+rel);
    if(crc32(png,pos+4,pos+8+size)!==png.readUInt32BE(pos+8+size))
      throw Error('PNG CRC mismatch: '+rel);
    chunkNames[type]=(chunkNames[type]||0)+1;
    if(type==='IHDR'){
      if(ihdr||chunks||size!==13)throw Error('PNG header inconsistent: '+rel);
      ihdr++;
      width=png.readUInt32BE(pos+8);height=png.readUInt32BE(pos+12);
      if(width<600||width>4000||height<400||height>4000)throw Error('Unexpected public capture dimensions: '+rel);
    }else if(type==='IDAT'){idat++;}
    else if(type==='IEND'){
      if(size!==0||iend||end!==png.length)throw Error('PNG end/trailing data invalid: '+rel);
      iend++;
    }else if(['tEXt','iTXt','zTXt','eXIf','iCCP'].includes(type)){
      flagged.push(type);
    }else if(type.charCodeAt(0)>=65&&type.charCodeAt(0)<=90){
      if(!['PLTE'].includes(type))flagged.push(type);
    }
    pos=end;chunks++;
    if(chunks>10000)throw Error('Excessive PNG chunks: '+rel);
  }
  if(!ihdr||!iend||!idat)throw Error('Incomplete PNG structure: '+rel);
  return {path:rel,width,height,bytes:png.length,chunks:chunkNames,
    sensitive_metadata_chunks:flagged};
}
export function auditPublicScreenshots(){
  const result=files.map(inspect);
  const review=result.flatMap(x=>x.sensitive_metadata_chunks.map(k=>({file:x.path,chunk:k})));
  return {status:review.length?'PNG_METADATA_REQUIRES_REVIEW':'PNG_STRUCTURE_AND_METADATA_PASS',
    screenshots:result,review,
    image_pixel_text_reviewed:false,owner_visual_approval:false,
    private_data_certified:false,git_index_changed:false,
    publication_performed:false,
    limitation:'PNG structure and ancillary chunk audit, NOT OCR, human pixel/privacy review, or proof that visible UI paths/user data are absent.'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const result=auditPublicScreenshots();
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    if(result.status!=='PNG_STRUCTURE_AND_METADATA_PASS')process.exitCode=1;
  }catch(error){
    process.stderr.write('PUBLIC SCREENSHOT AUDIT REFUSED: '+error.message+'\n');process.exitCode=2;
  }
}