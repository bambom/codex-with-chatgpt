import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {unzipSync} from 'fflate';
import {hashDocument} from '@magicgamestudio/ui-design-contract';
import {Workspace} from '../../dist/workspace/manager.js';
import {createJob,importFile,setScene,readWorkflowJob,saveWorkflowJob,inventoryArtifacts} from '../../dist/ui/workflow.js';
import {exportFgui} from '../../dist/ui/fgui.js';
import {migrateLegacy} from '../../dist/ui-design/migration.js';
import {reconstructLocal,localStatus} from '../../dist/ui-design/local.js';
import {migrationShape,MIGRATION_EXTENSION} from '../../dist/ui-design/migration-core.js';
import {pairPlatform,platformContext,platformCheckpoint,disconnectPlatform} from '../../dist/ui-design/platform.js';
import {beginIntake,submitIntakeBundle,readStandardRevision} from '../../dist/ui-design/intake.js';
import {beginExport,readExport,downloadExport} from '../../dist/ui-design/exports.js';
const fixture=JSON.parse(await fs.readFile(process.argv[2],'utf8')),phase=process.argv[3];
process.env.C2C_STATE_DIR=path.join(fixture.runDirectory,'state');const work=path.join(fixture.runDirectory,'workspace');await fs.mkdir(work,{recursive:true});const workspace=new Workspace(work);
const stateFile=path.join(fixture.runDirectory,'prepared.json');
try{
  if(phase==='prepare'){
    await pairPlatform(workspace,fixture.server,fixture.pairingCode);const context=await platformContext(workspace,fixture.designId),checkpoint=await platformCheckpoint(workspace,fixture.designId,context.nativeSequence,context.nativeSha256),intake=await beginIntake(workspace,fixture.designId,randomUUID(),checkpoint.checkpointId,context.standardRevision);
    const {restoreTarget}=await import(pathToFileURL(path.join(fixture.workerDirectory,'dist/targets.js')).href);
    const profile=await restoreTarget(JSON.parse(await fs.readFile(fixture.targetSnapshot,'utf8')),path.join(work,'target'));
    await fs.cp(path.join(fixture.contractFixtures,'files'),path.join(work,'source'),{recursive:true});await fs.writeFile(path.join(work,'source/OFL.txt'),'OFL-1.1');
    let old=await createJob(workspace,{name:'Disposable legacy migration fixture',designFile:'source/reference.png'});
    for(const [name,role]of[['reference.png','asset'],['skin.png','asset'],['fixture-font.ttf','font'],['OFL.txt','license']])old=await importFile(workspace,old.id,{sourcePath:'source/'+name,path:name,role});
    const scene={schemaVersion:1,id:'legacy_live',name:'Legacy live fixture',canvas:{width:640,height:480},entry:'entry',assets:[{id:'background',file:'reference.png',width:640,height:480},{id:'skin',file:'skin.png',width:16,height:12}],fonts:[{id:'font',file:'fixture-font.ttf',family:'Magic UI Fixture Regular',licenseFile:'OFL.txt'}],components:[
      {id:'entry',name:'Entry',semantic:'Component',width:640,height:480,children:[{id:'background',name:'background',type:'Image',assetId:'background',x:0,y:0,width:640,height:480},{id:'item',name:'item',type:'Component',componentId:'item',x:20,y:30,width:100,height:50}]},
      {id:'item',name:'Item',semantic:'Component',width:100,height:50,children:[{id:'image',name:'image',type:'Image',assetId:'skin',x:0,y:0,width:100,height:50},{id:'title',name:'title',type:'Text',text:'标题中文',x:0,y:0,width:100,height:32,style:{fontId:'font',fontSize:20,color:'#112233',singleLine:true}}]}]};
    await setScene(workspace,old.id,{scene,expectedRevision:old.revision});const original=await readWorkflowJob(workspace,old.id),build=path.join(original.root,'builds/legacy-fixture');await fs.mkdir(path.join(build,'Reports'),{recursive:true});
    const report=await exportFgui(scene,profile,path.join(original.root,'inputs'),path.join(build,'FGUI_Source'),old.id);await fs.writeFile(path.join(build,'Reports/fgui_static.json'),JSON.stringify(report));original.job.buildDirectory='builds/legacy-fixture';original.job.artifacts=await inventoryArtifacts(build);original.job.checks.static='passed';await saveWorkflowJob(original.root,original.job);
    const oldHash=hashDocument(await readWorkflowJob(workspace,old.id).then(r=>r.job)),prepared=await migrateLegacy(workspace,{jobId:old.id,designId:fixture.designId,destinationDirectory:'migration',association:{baseRevision:context.standardRevision,submissionId:intake.submissionId,checkpointId:checkpoint.checkpointId}});
    assert.equal(hashDocument(await readWorkflowJob(workspace,old.id).then(r=>r.job)),oldHash);await fs.rm(path.join(work,'source'),{recursive:true});
    await fs.writeFile(stateFile,JSON.stringify({jobId:prepared.id,submissionId:intake.submissionId,oldId:old.id,oldHash,identity:{packageId:report.packageId,resources:report.resources.map(({kind,semanticId,id})=>({kind,semanticId,id})),nodes:report.nodes.map(({componentId,nodeId,sourceObjectId})=>({componentId,nodeId,sourceObjectId}))},preparePid:process.pid}));
  }else if(phase==='submit'){
    const prepared=JSON.parse(await fs.readFile(stateFile,'utf8'));assert.notEqual(prepared.preparePid,process.pid);assert.equal((await localStatus(workspace,prepared.jobId)).status,'PREPARED');
    const rendered=await reconstructLocal(workspace,prepared.jobId,'bundle');assert.equal(rendered.status,'SUCCEEDED');
    const receipt=await submitIntakeBundle(workspace,{designId:fixture.designId,submissionId:prepared.submissionId,documentPath:rendered.bundle.documentPath,manifestPath:rendered.bundle.manifestPath,packageDirectory:rendered.bundle.directory});assert(receipt.published&&receipt.committedRevision===1);
    const exported=await beginExport(workspace,fixture.designId,randomUUID(),1,'FGUI','target_7578822b7f2c63d1');await fs.writeFile(path.join(fixture.runDirectory,'queued.json'),JSON.stringify({job:exported,receipt,reconstruction:{rendererVersion:rendered.reconstruction.rendererVersion,layers:rendered.reconstruction.layers.length,preview:rendered.reconstruction.preview},differentPluginProcess:true}));
  }else if(phase==='verify'){
    const prepared=JSON.parse(await fs.readFile(stateFile,'utf8')),queued=JSON.parse(await fs.readFile(path.join(fixture.runDirectory,'queued.json'),'utf8')),job=await readExport(workspace,fixture.designId,queued.job.jobId);assert.equal(job.state,'SUCCEEDED');
    let validation,zipVerified=false;
    for(const file of job.files){const out=await downloadExport(workspace,fixture.designId,job.jobId,file.index,'download/'+file.name),bytes=await fs.readFile(path.join(work,out.file.localPath));if(file.name==='Validation.json')validation=JSON.parse(bytes.toString());if(file.name==='FGUI_Source.zip'){const zip=unzipSync(bytes),packages=Object.entries(zip).filter(([name])=>name.endsWith('/package.xml'));assert.equal(packages.length,1);assert(Buffer.from(packages[0][1]).toString().includes('id="'+prepared.identity.packageId+'"'));zipVerified=true;}}
    assert.equal(validation.packageId,prepared.identity.packageId);assert.deepEqual(validation.resources.map(({kind,semanticId,id})=>({kind,semanticId,id})),prepared.identity.resources);assert.deepEqual(validation.nodes.map(({componentId,nodeId,sourceObjectId})=>({componentId,nodeId,sourceObjectId})),prepared.identity.nodes);assert(zipVerified);
    const revision=await readStandardRevision(workspace,fixture.designId,1);assert(revision.document.extensions[MIGRATION_EXTENSION]);assert.equal(hashDocument(await readWorkflowJob(workspace,prepared.oldId).then(r=>r.job)),prepared.oldHash);
    // Existing common-field edits retain identity; structure changes are rejected by the target adapter.
    const {migrationToFgui}=await import(pathToFileURL(path.join(fixture.workerDirectory,'dist/migration-adapter.js')).href);
    const doc=structuredClone(revision.document);doc.nodes.find(n=>n.kind==='Text').text.content='按钮';doc.nodes.find(n=>n.kind==='Instance').frame.x+=3;assert.equal(migrationShape(doc),doc.extensions[MIGRATION_EXTENSION].data.shapeHash);
    const m=JSON.parse(await fs.readFile(path.join(work,'bundle/Manifest.json'),'utf8'));const adaptDir=path.join(work,'adapter-edit');await fs.cp(path.join(work,'bundle'),adaptDir,{recursive:true});const adapted=await migrationToFgui(doc,m,m.files.map(f=>f.path),adaptDir);assert(adapted.scene.components.flatMap(c=>c.children).some(n=>n.text==='按钮'));assert.equal(adapted.identity.packageId,prepared.identity.packageId);
    const changed=structuredClone(doc);changed.nodes.find(n=>n.kind==='Text').clip=true;await assert.rejects(migrationToFgui(changed,m,m.files.map(f=>f.path),adaptDir),e=>e.code==='FGUI_MIGRATION_STRUCTURE_CHANGED');
    const disconnected=await disconnectPlatform(workspace);await fs.writeFile(path.join(fixture.runDirectory,'result.json'),JSON.stringify({localPreparationRecovered:true,differentPluginProcess:true,formalPublication:true,revision:1,receipt:queued.receipt,nativeIdentityPreserved:true,sourceJobUnchanged:true,structuralChangeRejected:true,canonicalContentEditApplied:true,downloadedFiles:job.files.length,exportReportHash:job.reportHash,editorImport:job.report.editorImport,runtimeInteraction:job.report.runtimeInteraction,credentialRevoked:disconnected.revoked===true,existingUserDataUsed:false},null,2));
  }else throw Error('Unknown phase');
}catch(e){process.stderr.write(JSON.stringify({code:e?.code??'LOCAL_PROBE_FAILED',message:e?.message,details:e?.details})+'\n');process.exitCode=1;}
