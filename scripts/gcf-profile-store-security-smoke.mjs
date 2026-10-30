import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {saveWorkspaceProfile, readWorkspaceProfile, profilePathForRoot} from '../dist/profileStore.js';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'gcf-profile-security-'));
const original=process.env.GCF_HOME;
try {
  process.env.GCF_HOME=path.join(temp,'owner');
  const root=path.join(temp,'repo');
  const destination=saveWorkspaceProfile(root,{tunnel:'none',write:'off',bash:'off'});
  assert.equal(readWorkspaceProfile(root).write,'off');
  assert.equal(fs.statSync(destination).mode & 0o777,0o600);
  const outside=path.join(temp,'outside.json');
  fs.writeFileSync(outside,'PRIVATE SENTINEL');
  fs.unlinkSync(destination); fs.symlinkSync(outside,destination);
  assert.throws(()=>saveWorkspaceProfile(root,{write:'workspace'}),/link/);
  assert.throws(()=>readWorkspaceProfile(root),/link/);
  assert.equal(fs.readFileSync(outside,'utf8'),'PRIVATE SENTINEL');
  fs.unlinkSync(destination); fs.linkSync(outside,destination);
  assert.throws(()=>saveWorkspaceProfile(root,{}),/link/);
  assert.throws(()=>readWorkspaceProfile(root),/link/);
  fs.unlinkSync(destination);
  fs.writeFileSync(destination,' '.repeat(65537));
  assert.throws(()=>readWorkspaceProfile(root),/bounded/);
  fs.unlinkSync(destination);
  assert.throws(()=>saveWorkspaceProfile(root,{token:'a'.repeat(65537)}),/size limit/);
  const profiles=path.dirname(profilePathForRoot(root));
  fs.renameSync(profiles,profiles+'-original'); fs.symlinkSync(temp,profiles);
  assert.throws(()=>saveWorkspaceProfile(root,{}),/symlink/);
  process.env.GCF_HOME=path.join(temp,'linked-home');
  fs.symlinkSync(temp,process.env.GCF_HOME);
  assert.throws(()=>saveWorkspaceProfile(root,{}),/symlink/);
  console.log('PASS: atomic private profile save; file, hardlink, directory and home symlinks denied; bounded reads/writes');
} finally {
  if(original===undefined)delete process.env.GCF_HOME; else process.env.GCF_HOME=original;
  fs.rmSync(temp,{recursive:true,force:true});
}
