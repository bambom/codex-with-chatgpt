import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashDocument, hashBytes } from '@magicgamestudio/ui-design-contract';
import { Workspace } from '../../dist/workspace/manager.js';
import { platformContext, platformCheckpoint, disconnectPlatform } from '../../dist/ui-design/platform.js';
import { beginIntake, uploadIntakeBundle, validateIntake, prepareCommitIntake, commitIntake, intakeStatus, readStandardRevision } from '../../dist/ui-design/intake.js';
const fixture=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
process.env.C2C_STATE_DIR=path.join(fixture.runDirectory,'state');
const work=path.join(fixture.runDirectory,'workspace'),workspace=new Workspace(work),pending=path.join(fixture.runDirectory,'merge-pending.json');
try {
  if(fixture.phase==='prepare') {
    const context=await platformContext(workspace,fixture.designId),base=await readStandardRevision(workspace,fixture.designId,context.standardRevision);
    const checkpoint=await platformCheckpoint(workspace,fixture.designId,context.nativeSequence,context.nativeSha256);
    const stage=await beginIntake(workspace,fixture.designId,randomUUID(),checkpoint.checkpointId,context.standardRevision);
    const doc=base.document,manifest=base.manifest;
    const bytes=await fs.readFile(path.join(work,'bundle/files/skinNext.png')),hash=hashBytes(bytes);
    function replace(value){if(value&&typeof value==='object'){if(value.id==='skin'&&value.sha256&&value.version){value.sha256=hash;value.version=2;}for(const child of Object.values(value))replace(child);}}
    replace(doc);await fs.writeFile(path.join(work,'bundle/files/skin.png'),bytes);
    manifest.submissionId=stage.submissionId;manifest.baseRevision=context.standardRevision;manifest.documentHash=hashDocument(doc);
    Object.assign(manifest.files.find(f=>f.logicalId==='skin'),{sha256:hash,version:2,byteLength:bytes.length});
    await fs.writeFile(path.join(work,'merge-document.json'),JSON.stringify(doc));await fs.writeFile(path.join(work,'merge-manifest.json'),JSON.stringify(manifest));
    const args={designId:fixture.designId,submissionId:stage.submissionId,documentPath:'merge-document.json',manifestPath:'merge-manifest.json',packageDirectory:'bundle'};
    await uploadIntakeBundle(workspace,args);const report=await validateIntake(workspace,fixture.designId,stage.submissionId);
    await fs.writeFile(pending,JSON.stringify({submissionId:stage.submissionId,report,document:doc}));
  }else {
    const n=JSON.parse(await fs.readFile(pending,'utf8'));
    const preparation=await prepareCommitIntake(workspace,fixture.designId,n.submissionId,n.report.validationId);
    if(preparation.mergeStrategy!=='FINITE_ASSET_POSITION'||preparation.resourceSide!=='CANDIDATE'||preparation.committedDocumentHash===n.report.documentHash)throw Error('Actual edited native page was not merged');
    const receipt=await commitIntake(workspace,fixture.designId,n.submissionId,n.report.validationId,preparation.preparationId);
    const retry=await commitIntake(workspace,fixture.designId,n.submissionId,n.report.validationId,preparation.preparationId);
    const revision=await readStandardRevision(workspace,fixture.designId,receipt.committedRevision),status=await intakeStatus(workspace,fixture.designId,n.submissionId);
    const title=revision.document.nodes.find(n=>n.id==='title'),before=n.document.nodes.find(n=>n.id==='title');
    if(JSON.stringify(receipt)!==JSON.stringify(retry)||hashDocument(status.validation)!==hashDocument(n.report)||title.text.content!==before.text.content
      ||title.frame.x!==before.frame.x+1||title.frame.y!==before.frame.y||revision.document.assets.find(a=>a.id==='skin').version!==2)throw Error('Merged revision lost candidate resources or actual native position');
    const disconnected=await disconnectPlatform(workspace);
    await fs.writeFile(path.join(fixture.runDirectory,'merge-result.json'),JSON.stringify({receipt,preparation,retryExact:true,candidateReportPreserved:true,nativePositionPreserved:true,resourceReplacementPreserved:true,credentialRevoked:disconnected.revoked===true}));
  }
}catch(error){process.stderr.write(JSON.stringify({error:error?.code??'PROBE_FAILED',message:error?.message??'Probe failed'})+'\n');process.exitCode=1;}
