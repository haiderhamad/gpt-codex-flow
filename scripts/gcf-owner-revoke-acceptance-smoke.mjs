import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {prepareAcceptance,inspectFixture,verifyAcceptance} from './gcf-owner-revoke-acceptance.mjs';
const prepared=await prepareAcceptance();
try {
 assert.equal(prepared.status,'READY_FOR_HUMAN_OWNER_REVIEW');
 const inspection=await inspectFixture(prepared.fixture);
 assert.equal(inspection.status,'AWAITING_MANUAL_OWNER_APPROVAL');
 const verify=await verifyAcceptance(prepared.fixture);
 assert.equal(verify.approved,false);
 assert.equal(verify.status,'AWAITING_MANUAL_OWNER_APPROVAL');
 assert.equal(JSON.parse(await fs.readFile(prepared.manifest,'utf8')).roots.length,2);
 assert.ok(prepared.owner_command.includes('gcf-cli.mjs'));
 // Simulate only the post-consent fixture state, NOT a real owner's approval.
 await fs.writeFile(prepared.manifest,JSON.stringify({version:1,roots:[prepared.GitA]})+'\n');
 const after=await verifyAcceptance(prepared.fixture);
 assert.equal(after.status,'OWNER_REVOCATION_AND_RECONNECT_VERIFIED');
 assert.equal(after.GitB_denied,true);
 assert.equal(after.project_count,1);
 assert.equal((await fs.readFile(prepared.GitB+'/marker.txt','utf8')).trim(),'Git-B');
 console.log('PASS: owner revocation fixture setup/preview intact, read-only verification waits for genuine terminal consent');
}finally{await fs.rm(prepared.fixture,{recursive:true,force:true});}
