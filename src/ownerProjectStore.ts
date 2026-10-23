import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readProjectRootsManifestSnapshot, validateProjectRootPaths, validateProjectRoots} from './projectRootsFile.js';

export function readOwnerFolders(file: string): string[] {
  return fs.lstatSync(file,{throwIfNoEntry:false}) ? readProjectRootsManifestSnapshot(file) : [];
}

/** Owner-only atomic allowlist replacement. Never deletes a workspace directory. */
export function saveOwnerFolders(file: string, expected: string[], next: string[]): {backup?: string} {
  if (!path.isAbsolute(file)) throw Error('Settings path must be absolute.');
  const before = readOwnerFolders(file);
  if (JSON.stringify(before) !== JSON.stringify(expected)) throw Error('Folder list changed. Reload and review it again.');
  const normalized = validateProjectRootPaths(next);
  // Missing historical entries may remain while an owner removes them one by one.
  // They never become live MCP roots; startup still validates the complete list.
  const present = normalized.filter(root => fs.existsSync(root));
  if (present.length) validateProjectRoots(present);
  const dir = path.dirname(file);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const parent = fs.lstatSync(dir);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('Settings folder is unsafe.');
  if (fs.existsSync(file)) readProjectRootsManifestSnapshot(file); // Recheck symlink/hardlink/size.
  const temp = path.join(dir,'.gcf-folders-'+randomUUID()+'.tmp');
  let backup: string | undefined;
  try {
    const fd = fs.openSync(temp, fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW??0),0o600);
    try {fs.writeFileSync(fd,JSON.stringify({version:1,roots:normalized},null,2)+'\n');fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    if (JSON.stringify(readOwnerFolders(file)) !== JSON.stringify(expected)) throw Error('Folder list changed before saving. Reload and try again.');
    if (fs.existsSync(file)) {
      backup = file+'.backup-'+randomUUID();
      fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backup,0o600);
    }
    fs.renameSync(temp,file);
  } finally {try {fs.unlinkSync(temp);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}}
  return {backup};
}
