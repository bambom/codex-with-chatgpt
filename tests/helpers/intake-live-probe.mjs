import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { hashDocument, hashBytes } from '@magicgamestudio/ui-design-contract';
import { SPEC_DIGEST } from '@magicgamestudio/ui-design-contract/spec';
import { Workspace } from '../../dist/workspace/manager.js';
import { pairPlatform, platformSpecification, platformOnlineProtocol, platformContext, platformCheckpoint, platformIntakeRequest, disconnectPlatform } from '../../dist/ui-design/platform.js';
import { beginIntake, uploadIntakeBundle, intakeStatus, submitIntakeBundle, readStandardRevision, publishNativeDraft } from '../../dist/ui-design/intake.js';
const fixture=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
process.env.C2C_STATE_DIR=path.join(fixture.runDirectory,'state');
const work=path.join(fixture.runDirectory,'workspace');await fs.mkdir(work,{recursive:true});
const workspace=new Workspace(work);
try {
  if(fixture.phase==='native') {
    const context=await platformContext(workspace,fixture.designId);
    const checkpoint=await platformCheckpoint(workspace,fixture.designId,context.nativeSequence,context.nativeSha256);
    const requestId=randomUUID();const receipt=await publishNativeDraft(workspace,fixture.designId,requestId,checkpoint.checkpointId,context.standardRevision);
    const retry=await publishNativeDraft(workspace,fixture.designId,requestId,checkpoint.checkpointId,context.standardRevision);
    const revision=await readStandardRevision(workspace,fixture.designId,receipt.committedRevision);
    if(JSON.stringify(receipt)!==JSON.stringify(retry)||receipt.origin!=='NATIVE_DRAFT'||receipt.nativeImported||!receipt.published
      ||!revision.document.nodes.some(n=>n.id==='title'&&n.text.content==='标题中文'))throw Error('Native publication receipt/content mismatch');
    const disconnected=await disconnectPlatform(workspace);
    await fs.writeFile(path.join(fixture.runDirectory,'native-result.json'),JSON.stringify({receipt,retryExact:true,revisionRead:true,credentialRevoked:disconnected.revoked===true},null,2));
  }else {
  await pairPlatform(workspace,fixture.server,fixture.pairingCode);
  const protocol=await platformOnlineProtocol(workspace);
  const context=await platformContext(workspace,fixture.designId);
  const checkpoint=await platformCheckpoint(workspace,fixture.designId,context.nativeSequence,context.nativeSha256);
  const requestId=randomUUID();
  const stage=await beginIntake(workspace,fixture.designId,requestId,checkpoint.checkpointId,context.standardRevision);
  const retry=await beginIntake(workspace,fixture.designId,requestId,checkpoint.checkpointId,context.standardRevision);
  if(retry.submissionId!==stage.submissionId)throw Error('Begin retry created another intake');
  const document=(await platformSpecification(workspace,'example')).data;document.designId=fixture.designId;
  if(fixture.publication)document.nodes.find(n=>n.id==='title').text.color='#111111ff';
  const bundle=path.join(work,'bundle');await fs.mkdir(path.join(bundle,'files'),{recursive:true});await fs.mkdir(path.join(bundle,'outputs'));
  for(const name of ['source.png','reference.png','skin.png','skinNext.png','fixture-font.ttf'])
    await fs.copyFile(path.join(fixture.contractFixtures,'files',name),path.join(bundle,'files',name));
  for(const name of ['preview','overview'])await fs.copyFile(path.join(bundle,'files/reference.png'),path.join(bundle,'outputs',name+'.png'));
  await fs.writeFile(path.join(bundle,'outputs/provenance.json'),JSON.stringify({synthetic:true,purpose:'Intake byte and resume integration; no visual approval',...(fixture.chunkResume?{padding:'x'.repeat(2*1048576)}:{})}));
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
  let uploaded;
  if(fixture.chunkResume) {
    const bytes=await fs.readFile(path.join(bundle,files[7].path));
    await platformIntakeRequest(workspace,fixture.designId,'/submissions/'+stage.submissionId+'/files/7/chunks/0','PUT',bytes.subarray(0,1048576));
    const input=path.join(fixture.runDirectory,'chunk-worker.json'),output=path.join(fixture.runDirectory,'chunk-worker-result.json');
    await fs.writeFile(input,JSON.stringify({work,state:process.env.C2C_STATE_DIR,args,output}));
    await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./chunk-resume-live.mjs',import.meta.url)),input],{timeout:120000});
    uploaded=JSON.parse(await fs.readFile(output,'utf8'));
    if(uploaded.resumedBytes!==1048576)throw Error('New plugin process did not resume the retained block');
  }else uploaded=await uploadIntakeBundle(workspace,args);
  const resumed=await uploadIntakeBundle(workspace,args);
  const skinPath=path.join(bundle,'files/skin.png'),original=await fs.readFile(skinPath),tampered=Buffer.from(original);tampered[0]^=1;
  await fs.writeFile(skinPath,tampered);let localTamperRejected=false;
  try{await uploadIntakeBundle(workspace,args);}catch(error){localTamperRejected=error?.code==='FILE_HASH';}
  await fs.writeFile(skinPath,original);
  let stored=await intakeStatus(workspace,fixture.designId,stage.submissionId),receipt=null;
  if(fixture.publication) {
    receipt=await submitIntakeBundle(workspace,args);
    const retry=await submitIntakeBundle(workspace,args);
    const revision=await readStandardRevision(workspace,fixture.designId,receipt.committedRevision);
    if(JSON.stringify(receipt)!==JSON.stringify(retry)||hashDocument(revision.document)!==hashDocument(document))throw Error('Formal receipt/revision mismatch');
    stored=await intakeStatus(workspace,fixture.designId,stage.submissionId);
  }
  const disconnected=fixture.keepConnection?{revoked:false}:await disconnectPlatform(workspace);
  const result={liveProtocol:protocol.capabilities.resumableIntake===true,bundleStored:['BUNDLE_STORED','COMMITTED'].includes(stored.state)&&stored.files.every(f=>f.stored),
    resumePassed:uploaded.uploadedFiles===7&&uploaded.resumedFiles===1&&resumed.uploadedFiles===0&&resumed.resumedFiles===8,
    localTamperRejected,credentialRevoked:disconnected.revoked===true,formalSubmission:stored.submitted,publication:stored.published,
    submissionId:stage.submissionId,retainedFiles:stored.files.length,nativeDocumentChanged:!!fixture.publication,existingUserDataUsed:false,receipt,
    chunkResume:!!fixture.chunkResume,resumedBytes:uploaded.resumedBytes,uploadedBlocks:uploaded.uploadedBlocks};
  if(!result.liveProtocol||!result.bundleStored||!result.resumePassed||!localTamperRejected||(!fixture.keepConnection&&!result.credentialRevoked)
    ||result.formalSubmission!==!!fixture.publication||result.publication!==!!fixture.publication)throw Error('Intake assertion failed');
  await fs.writeFile(path.join(fixture.runDirectory,'result.json'),JSON.stringify(result,null,2));
  }
}catch(error){process.stderr.write(JSON.stringify({error:error?.code??'PROBE_FAILED',message:error?.message??'Probe failed'})+'\n');process.exitCode=1;}
