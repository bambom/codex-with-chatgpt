import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashDocument, hashBytes } from '@magicgamestudio/ui-design-contract';
import { SPEC_DIGEST } from '@magicgamestudio/ui-design-contract/spec';
import { Workspace } from '../../dist/workspace/manager.js';
import { pairPlatform, platformSpecification, platformOnlineProtocol, platformContext, platformCheckpoint, platformIntakeRequest, disconnectPlatform } from '../../dist/ui-design/platform.js';
import { beginIntake, uploadIntakeBundle, intakeStatus } from '../../dist/ui-design/intake.js';
const fixture=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
process.env.C2C_STATE_DIR=path.join(fixture.runDirectory,'state');
const work=path.join(fixture.runDirectory,'workspace');await fs.mkdir(work);
const workspace=new Workspace(work);
try {
  await pairPlatform(workspace,fixture.server,fixture.pairingCode);
  const protocol=await platformOnlineProtocol(workspace);
  const context=await platformContext(workspace,fixture.designId);
  const checkpoint=await platformCheckpoint(workspace,fixture.designId,context.nativeSequence,context.nativeSha256);
  const requestId=randomUUID();
  const stage=await beginIntake(workspace,fixture.designId,requestId,checkpoint.checkpointId,context.standardRevision);
  const retry=await beginIntake(workspace,fixture.designId,requestId,checkpoint.checkpointId,context.standardRevision);
  if(retry.submissionId!==stage.submissionId)throw Error('Begin retry created another intake');
  const document=(await platformSpecification(workspace,'example')).data;document.designId=fixture.designId;
  const bundle=path.join(work,'bundle');await fs.mkdir(path.join(bundle,'files'),{recursive:true});await fs.mkdir(path.join(bundle,'outputs'));
  for(const name of ['source.png','reference.png','skin.png','skinNext.png','fixture-font.ttf'])
    await fs.copyFile(path.join(fixture.contractFixtures,'files',name),path.join(bundle,'files',name));
  for(const name of ['preview','overview'])await fs.copyFile(path.join(bundle,'files/reference.png'),path.join(bundle,'outputs',name+'.png'));
  await fs.writeFile(path.join(bundle,'outputs/provenance.json'),JSON.stringify({synthetic:true,purpose:'Intake byte and resume integration; no visual approval'}));
  const files=[];
  const add=async(name,role,id)=>{const bytes=await fs.readFile(path.join(bundle,name));files.push({path:name,role,logicalId:id,version:1,sha256:hashBytes(bytes),byteLength:bytes.length});};
  await add('files/source.png','original','source');
  for(const asset of document.assets)await add('files/'+asset.id+'.png',asset.id==='reference'?'approved':'asset',asset.id);
  await add('files/fixture-font.ttf','font','fixtureFont');
  for(const role of ['preview','overview','provenance'])await add('outputs/'+role+(role==='provenance'?'.json':'.png'),role,role);
  const manifest={schemaVersion:'0.1.0',designId:fixture.designId,submissionId:stage.submissionId,baseRevision:context.standardRevision,specDigest:SPEC_DIGEST,documentHash:hashDocument(document),files};
  await fs.writeFile(path.join(work,'document.json'),JSON.stringify(document));await fs.writeFile(path.join(work,'manifest.json'),JSON.stringify(manifest));
  await platformIntakeRequest(workspace,fixture.designId,'/submissions/'+stage.submissionId+'/candidate','PUT',{document,manifest});
  await platformIntakeRequest(workspace,fixture.designId,'/submissions/'+stage.submissionId+'/files/0','PUT',await fs.readFile(path.join(bundle,files[0].path)));
  const args={designId:fixture.designId,submissionId:stage.submissionId,documentPath:'document.json',manifestPath:'manifest.json',packageDirectory:'bundle'};
  const uploaded=await uploadIntakeBundle(workspace,args);
  const resumed=await uploadIntakeBundle(workspace,args);
  const skinPath=path.join(bundle,'files/skin.png'),original=await fs.readFile(skinPath),tampered=Buffer.from(original);tampered[0]^=1;
  await fs.writeFile(skinPath,tampered);let localTamperRejected=false;
  try{await uploadIntakeBundle(workspace,args);}catch(error){localTamperRejected=error?.code==='FILE_HASH';}
  await fs.writeFile(skinPath,original);
  const stored=await intakeStatus(workspace,fixture.designId,stage.submissionId);
  const disconnected=await disconnectPlatform(workspace);
  const result={liveProtocol:protocol.capabilities.resumableIntake===true,bundleStored:stored.state==='BUNDLE_STORED'&&stored.files.every(f=>f.stored),
    resumePassed:uploaded.uploadedFiles===7&&uploaded.resumedFiles===1&&resumed.uploadedFiles===0&&resumed.resumedFiles===8,
    localTamperRejected,credentialRevoked:disconnected.revoked===true,formalSubmission:stored.submitted,publication:stored.published,
    submissionId:stage.submissionId,retainedFiles:stored.files.length,nativeDocumentChanged:false,existingUserDataUsed:false};
  if(!result.liveProtocol||!result.bundleStored||!result.resumePassed||!localTamperRejected||!result.credentialRevoked||result.formalSubmission||result.publication)throw Error('Intake assertion failed');
  await fs.writeFile(path.join(fixture.runDirectory,'result.json'),JSON.stringify(result,null,2));
}catch(error){process.stderr.write(JSON.stringify({error:error?.code??'PROBE_FAILED',message:error?.message??'Probe failed'})+'\n');process.exitCode=1;}
