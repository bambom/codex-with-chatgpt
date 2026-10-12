import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { readPsd } from 'ag-psd';
import { Workspace } from '../../dist/workspace/manager.js';
import { pairPlatform,disconnectPlatform } from '../../dist/ui-design/platform.js';
import { exportTargets,beginExport,listExports,readExport,downloadExport } from '../../dist/ui-design/exports.js';
const fixture=JSON.parse(await fs.readFile(process.argv[2],'utf8')),phase=process.argv[3];
process.env.C2C_STATE_DIR=path.join(fixture.runDirectory,'state');
const work=path.join(fixture.runDirectory,'workspace');await fs.mkdir(work,{recursive:true});const workspace=new Workspace(work),design=fixture.designId;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try {
  if(phase==='queue') {
    const paired=await pairPlatform(workspace,fixture.server,fixture.pairingCode);assert.deepEqual(paired.scopes,['design.read']);
    const targets=await exportTargets(workspace,design);assert(targets.targets.length>0);
    const psdRequest=randomUUID(),psd=await beginExport(workspace,design,psdRequest,1,'PSD');
    assert.equal((await beginExport(workspace,design,psdRequest,1,'PSD')).jobId,psd.jobId);
    const fgui=await beginExport(workspace,design,randomUUID(),1,'FGUI',targets.targets[0].id);
    assert.equal((await listExports(workspace,design,1)).jobs.length,2);
    await fs.writeFile(path.join(fixture.runDirectory,'queued.json'),JSON.stringify({jobs:[psd,fgui]}));
  } else if(phase==='download') {
    const queued=JSON.parse(await fs.readFile(path.join(fixture.runDirectory,'queued.json'),'utf8')),reports=[];let psdReadback=false,fguiReadback=false;
    for(const q of queued.jobs) {
      const job=await readExport(workspace,design,q.jobId);assert.equal(job.state,'SUCCEEDED');assert.equal(job.revision,1);assert.equal(job.documentHash,q.documentHash);
      for(const file of job.files) {
        const relative='downloads/'+job.targetFormat+'/'+file.name,result=await downloadExport(workspace,design,job.jobId,file.index,relative);
        const bytes=await fs.readFile(path.join(work,result.file.localPath));assert.equal(bytes.length,file.byteLength);assert.equal(hash(bytes),file.sha256);
        await assert.rejects(downloadExport(workspace,design,job.jobId,file.index,relative),e=>e.code==='EXPORT_DESTINATION_EXISTS');
        if(file.name==='Layered.psd'){const reopened=readPsd(bytes,{skipLayerImageData:true,skipCompositeImageData:true});assert.equal(reopened.width,640);assert(reopened.children.length>0);psdReadback=true;}
        if(file.name==='FGUI_Source.zip'){const zip=unzipSync(bytes);assert(Object.keys(zip).some(p=>p.endsWith('package.xml')));assert(Object.keys(zip).some(p=>p.endsWith('.fairy')));fguiReadback=true;}
        if(file.name==='Standard_Source.zip'){const zip=unzipSync(bytes),bundle=JSON.parse(Buffer.from(zip['bundle.json']).toString());assert.equal(bundle.revision,1);assert(zip['metadata/receipt.json']);}
      }
      await assert.rejects(downloadExport(workspace,design,job.jobId,0,'../outside.bin'),e=>e.code==='PATH_OUTSIDE_WORKSPACE');
      reports.push({jobId:job.jobId,revision:job.revision,targetFormat:job.targetFormat,reportHash:job.reportHash,documentHash:job.documentHash,assetManifestHash:job.assetManifestHash,files:job.files,editorImport:job.report.editorImport,runtimeInteraction:job.report.runtimeInteraction});
    }
    const disconnected=await disconnectPlatform(workspace);
    await fs.writeFile(path.join(fixture.runDirectory,'result.json'),JSON.stringify({allFilesVerified:true,psdReadback,fguiReadback,credentialRevoked:disconnected.revoked===true,reports,existingUserDataUsed:false},null,2));
  } else throw Error('Invalid probe phase');
}catch(error){process.stderr.write(JSON.stringify({error:error?.code??'PROBE_FAILED',message:error?.message??'Probe failed'})+'\n');process.exitCode=1;}
