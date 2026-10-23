import assert from 'node:assert/strict';
import {validateCandidateList,checkCandidate,runtimeScripts} from './gcf-package-candidate.mjs';
const required=['dist/stdio.js','dist/http.js','dist/projectRootsFile.js'];
const good=['package.json','README.md','LICENSE',...runtimeScripts,...required];
assert.equal(validateCandidateList(good.map(path=>({path})),required).fileCount,good.length);
for(const bad of ['scripts/unsigned-native-helper.swift','scripts/gcf-cli-smoke.mjs',
  'dist/server.js.map','docs/internal.md','.env','../escape'])
 assert.throws(()=>validateCandidateList([...good,bad].map(path=>({path})),required));
assert.throws(()=>validateCandidateList([...good,good[0]].map(path=>({path})),required),/Duplicate/);
assert.throws(()=>validateCandidateList(good.slice(1).map(path=>({path})),required),/Missing/);
const r=await checkCandidate({offlineInstall:true});
assert.equal(r.status,'CANDIDATE_PACKLIST_AND_STAGED_BIN_VERIFIED');
assert.equal(r.scoped_release_status,'NOT_APPROVED');
assert.equal(r.staged_bin_help_passed,true);
assert.equal(r.staged_orchestration_imports_passed,true);
assert.equal(r.runtimeScripts,runtimeScripts.length);
assert.ok(runtimeScripts.includes('scripts/gcf-local-auto-worker.mjs'));
assert.equal(r.isolated_manifest_dry_run_passed,true);
assert.equal(r.npm_pack_dry_run_passed,true);
assert.equal(r.npm_install_attempted,true);
assert.ok(['OFFLINE_PACKED_BIN_VERIFIED','OFFLINE_DEPENDENCIES_UNAVAILABLE'].includes(r.installation.status));
assert.equal(r.original_repository_modified,false);
assert.equal(r.npm_pack_tarball_created,true);
assert.equal(r.scoped_release_status,'NOT_APPROVED');
console.log('OFFLINE_INSTALL_STATUS='+r.installation.status+' EXIT='+r.installation.exit_code+' DETAILS='+r.installation.diagnostic);
console.log('PASS: disposable staged GCF candidate and bounded offline install attempt; no publishing');
