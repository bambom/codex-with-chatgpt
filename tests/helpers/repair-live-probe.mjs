import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hashDocument,hashBytes} from '@magicgamestudio/ui-design-contract';
import {SPEC_DIGEST} from '@magicgamestudio/ui-design-contract/spec';
import {Workspace} from '../../dist/workspace/manager.js';
import {pairPlatform,platformSpecification,platformContext,platformCheckpoint,disconnectPlatform} from '../../dist/ui-design/platform.js';
import {beginIntake,uploadIntakeBundle,validateIntake,readIntakeCandidate,beginIntakeRepair,submitIntakeBundle,readStandardRevision} from '../../dist/ui-design/intake.js';
const fixture=JSON.parse(await fs.readFile(process.argv[2],'utf8')),phase=process.argv[3];
process.env.C2C_STATE_DIR=path.join(fixture.runDirectory,'state');
const work=path.join(fixture.runDirectory,'workspace');await fs.mkdir(work,{recursive:true});const workspace=new Workspace(work);
const bundle=path.join(work,'bundle'),attemptPath=path.join(fixture.runDirectory,'attempt-private.json');
const local={designId:fixture.designId,documentPath:'bundle/document.json',manifestPath:'bundle/manifest.json',packageDirectory:'bundle'};
try {
  if(phase==='reject') {
    await pairPlatform(workspace,fixture.server,fixture.pairingCode);
    const context=await platformContext(workspace,fixture.designId),cp=await platformCheckpoint(workspace,fixture.designId,context.nativeSequence,context.nativeSha256);
    const stage=await beginIntake(workspace,fixture.designId,randomUUID(),cp.checkpointId,context.standardRevision);
    const document=(await platformSpecification(workspace,'example')).data;document.designId=fixture.designId;
    await fs.mkdir(path.join(bundle,'files'),{recursive:true});
    for(const name of ['source.png','reference.png','skin.png','skinNext.png','fixture-font.ttf'])await fs.copyFile(path.join(fixture.contractFixtures,'files',name),path.join(bundle,'files',name));
    await fs.writeFile(path.join(bundle,'preview.png'),'This preview is deliberately not a PNG');
    await fs.copyFile(path.join(bundle,'files/reference.png'),path.join(bundle,'overview.png'));
    await fs.writeFile(path.join(bundle,'provenance.json'),JSON.stringify({synthetic:true,humanVisualApproval:false,purpose:'Immutable repair integration'}));
    const inputs=[['files/source.png','original','source'],['files/reference.png','approved','reference'],['files/skin.png','asset','skin'],['files/skinNext.png','asset','skinNext'],['files/fixture-font.ttf','font','fixtureFont'],['preview.png','preview','preview'],['overview.png','overview','overview'],['provenance.json','provenance','provenance']];
    const files=[];for(const [file,role,logicalId] of inputs){const bytes=await fs.readFile(path.join(bundle,file));files.push({path:file,role,logicalId,version:1,sha256:hashBytes(bytes),byteLength:bytes.length});}
    const manifest={schemaVersion:'0.1.0',designId:fixture.designId,submissionId:stage.submissionId,baseRevision:context.standardRevision,specDigest:SPEC_DIGEST,documentHash:hashDocument(document),files};
    await fs.writeFile(path.join(bundle,'document.json'),JSON.stringify(document));await fs.writeFile(path.join(bundle,'manifest.json'),JSON.stringify(manifest));
    await uploadIntakeBundle(workspace,{...local,submissionId:stage.submissionId});
    let failure;try{await validateIntake(workspace,fixture.designId,stage.submissionId);}catch(error){failure=error;}
    if(failure?.code!=='PNG_REQUIRED'||failure.details?.issues[0]?.path!=='/manifest/files/5'||failure.details.issues[0].assetId!=='preview')throw Error('Expected located PNG rejection');
    await fs.writeFile(attemptPath,JSON.stringify({submissionId:stage.submissionId,requestId:randomUUID(),failedManifestHash:hashDocument(manifest)}));
  }else {
    const previous=JSON.parse(await fs.readFile(attemptPath,'utf8'));
    const retained=await readIntakeCandidate(workspace,fixture.designId,previous.submissionId);
    if(retained.status.state!=='BUNDLE_STORED'||retained.errors[0]?.code!=='PNG_REQUIRED'||retained.status.assetManifestHash!==previous.failedManifestHash)throw Error('Failed attempt not recovered');
    const context=await platformContext(workspace,fixture.designId),cp=await platformCheckpoint(workspace,fixture.designId,context.nativeSequence,context.nativeSha256);
    const repaired=await beginIntakeRepair(workspace,fixture.designId,previous.submissionId,previous.requestId,cp.checkpointId,context.standardRevision);
    const retry=await beginIntakeRepair(workspace,fixture.designId,previous.submissionId,previous.requestId,cp.checkpointId,context.standardRevision);
    if(repaired.submissionId!==retry.submissionId||repaired.repair?.sourceLastError?.code!=='PNG_REQUIRED'||repaired.validation!==null)throw Error('Repair binding/retry mismatch');
    const bytes=await fs.readFile(path.join(bundle,'files/reference.png'));await fs.writeFile(path.join(bundle,'preview.png'),bytes);
    const manifest=retained.manifest;manifest.submissionId=repaired.submissionId;manifest.baseRevision=context.standardRevision;manifest.files[5].sha256=hashBytes(bytes);manifest.files[5].byteLength=bytes.length;
    await fs.writeFile(path.join(bundle,'manifest.json'),JSON.stringify(manifest));
    const uploaded=await uploadIntakeBundle(workspace,{...local,submissionId:repaired.submissionId});
    if(uploaded.uploadedFiles!==1||uploaded.repair?.reusedFileCount!==7)throw Error('Wrong immutable file reuse');
    const receipt=await submitIntakeBundle(workspace,{...local,submissionId:repaired.submissionId});
    const published=await readStandardRevision(workspace,fixture.designId,receipt.committedRevision);
    if(published.receipt.submissionId!==repaired.submissionId||receipt.status!=='COMMITTED')throw Error('Repair publication unconfirmed');
    const source=await readIntakeCandidate(workspace,fixture.designId,previous.submissionId);
    if(source.status.state!=='CANCELLED'||source.status.assetManifestHash!==previous.failedManifestHash||source.errors[0]?.code!=='PNG_REQUIRED')throw Error('Parent evidence changed');
    const disconnected=await disconnectPlatform(workspace);
    await fs.writeFile(path.join(fixture.runDirectory,'result.json'),JSON.stringify({receipt,reusedFiles:7,uploadedFiles:1,secondProcess:true,historicalErrorRetained:true,credentialRevoked:disconnected.revoked===true},null,2));
  }
}catch(error){console.error(error.code??error.name,error.message);process.exitCode=1;}
