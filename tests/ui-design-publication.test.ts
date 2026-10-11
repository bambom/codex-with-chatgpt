import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { SPEC_DIGEST } from "@magicgamestudio/ui-design-contract/spec";
import { ONLINE_VERSION, ONLINE_DIGEST, onlineProtocol } from "@magicgamestudio/ui-design-contract/online";
import { Workspace } from "../src/workspace/manager.js";
import { pairPlatform, disconnectPlatform } from "../src/ui-design/platform.js";
import { intakeStatus, validateIntake, commitIntake } from "../src/ui-design/intake.js";

it.each([false,true])("accepts only a receipt bound to N and the selected final validation; merged=%s", async (merged) => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"ui-publication-")),prior=process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR=path.join(root,"state");
  const design="D1234567890",sub="S"+"b".repeat(32),uuid="f4816e67-ad1d-4a21-8417-89c126fc1f53",hash="a".repeat(64);
  const comparison={metric:"premultiplied-srgb-rgba-8bit",pixelIdentical:true,differentPixels:0,maximumChannelDifference:0,meanAbsoluteChannelDifference:0,meaning:"Measurement only; does not prove visual or semantic correctness"};
  const report={validationId:uuid,submissionId:sub,designId:design,documentHash:hash,assetManifestHash:hash,bridgeVersion:"ui-design-native-bridge-1",bridgeSha256:hash,
    rendererVersion:"java2d-authoring-1",valid:true,nativeImported:false,published:false,submitted:false,
    checks:{schema:true,semantics:true,completeFileDecode:true,fixedDependencies:true,nativeWireRoundTrip:true,nativeProjection:true,standardRender:true,candidateNativeEditorRun:false,visualReview:"NOT_REVIEWED",targetExport:"NOT_EVALUATED"},
    warnings:["VISUAL_REVIEW_NOT_PERFORMED"],comparisons:{approved:comparison,preview:comparison,overview:comparison},reconstructedPreview:{sha256:hash,byteLength:10,width:640,height:480}};
  const receipt={format:"ui-design-standard-receipt-1",protocolVersion:ONLINE_VERSION,onlineDigest:ONLINE_DIGEST,origin:"PLUGIN_CANDIDATE",sourceSubmissionId:sub,status:"COMMITTED",designId:design,submissionId:sub,draftVersion:1,specVersion:"0.1.0",specDigest:SPEC_DIGEST,
    baseRevision:0,mergeHeadRevision:0,committedRevision:1,bridgeVersion:report.bridgeVersion,bridgeSha256:hash,submittedDocumentHash:hash,committedDocumentHash:hash,submittedAssetManifestHash:hash,committedAssetManifestHash:hash,
    validationId:uuid,nativeSequence:2,nativeCheckpointId:uuid,nativeSha256:hash,createdBy:uuid,committedAt:"2026-10-12T00:00:00Z",nativeImported:true,published:true,submitted:true,
    openPath:"/ui-design/design/"+design+"/test/edit",revisionPath:"/ui-design/api/v1/designs/"+design+"/revisions/1",previewPath:"/ui-design/api/v1/designs/"+design+"/revisions/1/preview.png",checks:report.checks,warnings:report.warnings,comparisons:report.comparisons,reconstructedPreview:report.reconstructedPreview};
  const preparationId="c6f03952-b836-4296-b3d7-ce893a29c3f7",finalHash="d".repeat(64);
  const preparation={protocolVersion:ONLINE_VERSION,onlineDigest:ONLINE_DIGEST,specDigest:SPEC_DIGEST,preparationId,candidateValidationId:uuid,designId:design,submissionId:sub,baseRevision:1,mergeHeadRevision:1,
    mergeNativeCheckpointId:uuid,mergeNativeSequence:1,mergeNativeSha256:hash,submittedDocumentHash:hash,submittedAssetManifestHash:hash,committedDocumentHash:finalHash,committedAssetManifestHash:finalHash,
    mergeStrategy:"FINITE_ASSET_POSITION",resourceSide:"CURRENT",published:false,submitted:false,previewPath:"/ui-design/api/v1/designs/"+design+"/submissions/"+sub+"/preparations/"+preparationId+"/preview.png",
    validation:{...report,validationId:preparationId,documentHash:finalHash,assetManifestHash:finalHash}};
  if(merged)Object.assign(receipt,{validationId:preparationId,preparationId,candidateValidationId:uuid,baseRevision:1,mergeHeadRevision:1,committedRevision:2,
    mergeStrategy:preparation.mergeStrategy,resourceSide:preparation.resourceSide,mergeNativeCheckpointId:uuid,mergeNativeSequence:1,mergeNativeSha256:hash,
    committedDocumentHash:finalHash,committedAssetManifestHash:finalHash,revisionPath:"/ui-design/api/v1/designs/"+design+"/revisions/2",previewPath:"/ui-design/api/v1/designs/"+design+"/revisions/2/preview.png"});
  let fakeSuccess=false,validated=false,committed=false,tamper=false,badPreparation=false,commitCalls=0,prepared=false;
  const server=http.createServer(async(req,res)=>{
    let body="";for await(const chunk of req)body+=chunk;res.setHeader("Content-Type","application/json");let value:unknown;
    if(req.url?.endsWith("/exchange"))value={connectionId:uuid,accessToken:"uid_"+"a".repeat(43),tokenType:"Bearer",expiresAt:new Date(Date.now()+3600000).toISOString(),designIds:[design],scopes:["design.read","design.submit"]};
    else if(req.url?.endsWith("/online-protocol"))value={protocolVersion:ONLINE_VERSION,onlineDigest:ONLINE_DIGEST,data:onlineProtocol(),capabilities:{resumableIntake:true,chunkUpload:true,structuredErrors:true,nativeImport:true,formalSubmission:true,nativeDraftPublication:true,concurrentMerge:merged}};
    else if(req.url?.endsWith("/validate")){validated=true;value=report;}
    else if(req.url?.endsWith("/prepare-commit")){prepared=!badPreparation;value=badPreparation?{...preparation,submittedDocumentHash:finalHash}:preparation;}
    else if(req.url?.includes("/preparations/"))value=preparation;
    else if(req.url?.endsWith("/commit")){commitCalls++;if(merged)expect(JSON.parse(body)).toEqual({validationId:uuid,preparationId});if(!tamper)committed=true;value=tamper?{...receipt,submittedDocumentHash:"c".repeat(64),committedDocumentHash:"c".repeat(64)}:receipt;}
    else if(req.url?.endsWith("/current")){res.statusCode=204;res.end();return;}
    else value={protocolVersion:ONLINE_VERSION,onlineDigest:ONLINE_DIGEST,submissionId:sub,designId:design,checkpointId:uuid,baseRevision:merged?1:0,specDigest:SPEC_DIGEST,
      state:committed?"COMMITTED":"BUNDLE_STORED",documentHash:hash,assetManifestHash:hash,files:[{index:0,path:"test.png",role:"approved",sha256:hash,byteLength:10,stored:true,nextOffset:10,uploadState:"READY",uploadExpiresAt:null}],
      nativeImported:committed||fakeSuccess,published:committed||fakeSuccess,submitted:committed||fakeSuccess,validation:validated?report:null,preparation:prepared?preparation:null,receipt:committed?receipt:null,lastError:null};
    res.end(JSON.stringify(value));
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try {
    const workspace=new Workspace(root);await pairPlatform(workspace,"http://127.0.0.1:"+(server.address() as {port:number}).port,"p".repeat(43));
    fakeSuccess=true;await expect(intakeStatus(workspace,design,sub)).rejects.toMatchObject({code:"PLATFORM_RESPONSE_INVALID"});fakeSuccess=false;
    expect((await validateIntake(workspace,design,sub)).published).toBe(false);
    if(merged){
      badPreparation=true;await expect(commitIntake(workspace,design,sub,uuid)).rejects.toMatchObject({code:"PLATFORM_RESPONSE_INVALID"});expect(commitCalls).toBe(0);badPreparation=false;
      await expect(commitIntake(workspace,design,sub,uuid,uuid)).rejects.toMatchObject({code:"PLATFORM_RESPONSE_INVALID"});expect(commitCalls).toBe(0);
    }
    tamper=true;await expect(commitIntake(workspace,design,sub,uuid)).rejects.toMatchObject({code:"PLATFORM_RESPONSE_INVALID"});tamper=false;
    expect((await commitIntake(workspace,design,sub,uuid)).committedRevision).toBe(merged?2:1);
    expect((await commitIntake(workspace,design,sub,uuid)).committedRevision).toBe(merged?2:1);expect(commitCalls).toBe(2);
    expect((await intakeStatus(workspace,design,sub)).receipt?.validationId).toBe(merged?preparationId:uuid);
    await expect(commitIntake(workspace,design,sub,"c6f03952-b836-4296-b3d7-ce893a29c3f7")).rejects.toMatchObject({code:"VALIDATION_REQUIRED"});
    await disconnectPlatform(workspace);
  }finally{server.close();await once(server,"close");if(prior===undefined)delete process.env.C2C_STATE_DIR;else process.env.C2C_STATE_DIR=prior;await fs.rm(root,{recursive:true,force:true});}
},60000);
