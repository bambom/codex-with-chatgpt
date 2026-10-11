import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../../dist/workspace/manager.js';
import { pairPlatform, disconnectPlatform } from '../../dist/ui-design/platform.js';
import { readStandardHistory, readStandardRevision, readCopySource } from '../../dist/ui-design/intake.js';
const fixture=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
process.env.C2C_STATE_DIR=path.join(fixture.runDirectory,'state');
const work=path.join(fixture.runDirectory,'workspace');await fs.mkdir(work);const workspace=new Workspace(work);
try {
  await pairPlatform(workspace,fixture.server,fixture.pairingCode);
  const receipts=[];let before=0;
  do {
    const page=await readStandardHistory(workspace,fixture.designId,before,1);receipts.push(...page.revisions);before=page.nextBefore;
  }while(before!==null);
  if(receipts.length!==3||receipts.some((r,i)=>r.origin!=='DESIGN_COPY'||r.committedRevision!==3-i))throw Error('Incomplete copied history');
  const revision=await readStandardRevision(workspace,fixture.designId,3),archive=await readCopySource(workspace,fixture.designId,3);
  if(archive.producer.validation.documentHash===archive.revision.receipt.committedDocumentHash||revision.document.designId!==fixture.designId)throw Error('Copied merge provenance was lost');
  const disconnected=await disconnectPlatform(workspace);
  await fs.writeFile(path.join(fixture.runDirectory,'result.json'),JSON.stringify({historyCount:receipts.length,archiveVerified:true,independentCopiedDesign:true,credentialRevoked:disconnected.revoked===true,existingUserDataUsed:false}));
}catch(error){process.stderr.write(JSON.stringify({error:error?.code??'PROBE_FAILED',message:error?.message??'Probe failed'})+'\n');process.exitCode=1;}
