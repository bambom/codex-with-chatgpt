import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { it,expect } from "vitest";
import { hashDocument } from "@magicgamestudio/ui-design-contract";
import { Workspace } from "../src/workspace/manager.js";
import { pairPlatform,platformExportRequest } from "../src/ui-design/platform.js";
import { downloadExport } from "../src/ui-design/exports.js";

it("reads exports with design.read, rejects unexpected routes and retains no unverified or overwritten local file",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"ui-export-")),prior=process.env.C2C_STATE_DIR;process.env.C2C_STATE_DIR=path.join(root,"state");
  const design="D1234567890",id="6c0a574b-6652-44b1-87f2-ff393293463d",attempt="7c0a574b-6652-44b1-87f2-ff393293463d",hash="a".repeat(64),date=new Date().toISOString(),bytes=Buffer.from("fixed PSD test bytes"),sha=createHash("sha256").update(bytes).digest("hex");
  let corrupted=true,revoked=false,requests=0;
  const file={name:"Layered.psd",mediaType:"image/vnd.adobe.photoshop",sha256:sha,byteLength:bytes.length};
  const report={format:"ui-design-export-report-1",jobId:id,attemptId:attempt,designId:design,revision:1,targetFormat:"PSD",documentHash:hash,assetManifestHash:hash,exporterVersion:"standard-export-1",exporterSha256:hash,targetSha256:null,rendererVersion:"java2d-authoring-1",fileValidation:"passed",editorImport:"not_verified",runtimeInteraction:"not_verified",files:[file],limitations:[]};
  const job={format:"ui-design-export-job-1",jobId:id,designId:design,revision:1,targetFormat:"PSD",state:"SUCCEEDED",documentHash:hash,assetManifestHash:hash,exporterVersion:"standard-export-1",exporterSha256:hash,attemptNumber:1,createdBy:id,createdAt:date,updatedAt:date,targetId:null,targetSha256:null,lastError:null,diagnostics:null,activeAttemptId:attempt,reportHash:hashDocument(report),report,files:[{...file,index:0,path:`/ui-design/api/v1/designs/${design}/exports/${id}/files/0`}],attempts:[{id:attempt,number:1,state:"SUCCEEDED",errorCode:null,diagnostics:null,startedAt:date,finishedAt:date}]};
  const server=http.createServer((req,res)=>{
    requests++;res.setHeader("Content-Type","application/json");
    if(req.url!.endsWith("/exchange")){res.end(JSON.stringify({connectionId:id,accessToken:"uid_"+"a".repeat(43),tokenType:"Bearer",expiresAt:new Date(Date.now()+3600000).toISOString(),designIds:[design],scopes:["design.read"]}));return;}
    if(revoked){res.statusCode=401;res.end("{}");return;}
    if(req.url!.endsWith("/files/0")){res.setHeader("Content-Type",file.mediaType);res.setHeader("X-Content-SHA256",sha);const body=Buffer.from(bytes);if(corrupted)body[0]^=1;res.end(body);return;}
    res.end(JSON.stringify(job));
  });server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    const workspace=new Workspace(root);await pairPlatform(workspace,"http://127.0.0.1:"+(server.address() as {port:number}).port,"p".repeat(43));
    const count=requests;await expect(platformExportRequest(workspace,design,"/exports/targets","POST",{})).rejects.toMatchObject({code:"INVALID_EXPORT_ROUTE"});expect(requests).toBe(count);
    await expect(downloadExport(workspace,design,id,0,"out/test.psd")).rejects.toMatchObject({code:"EXPORT_FILE_CHANGED"});expect(await fs.readdir(path.join(root,"out"))).toEqual([]);
    corrupted=false;await downloadExport(workspace,design,id,0,"out/test.psd");expect(await fs.readFile(path.join(root,"out/test.psd"))).toEqual(bytes);
    await expect(downloadExport(workspace,design,id,0,"out/test.psd")).rejects.toMatchObject({code:"EXPORT_DESTINATION_EXISTS"});expect(await fs.readdir(path.join(root,"out"))).toEqual(["test.psd"]);
    await expect(downloadExport(workspace,design,id,0,"../escaped.psd")).rejects.toMatchObject({code:"PATH_OUTSIDE_WORKSPACE"});
    revoked=true;await expect(downloadExport(workspace,design,id,0,"out/revoked.psd")).rejects.toMatchObject({code:"PLATFORM_HTTP_401"});expect(await fs.readdir(path.join(root,"out"))).toEqual(["test.psd"]);
  }finally{server.close();await once(server,"close");if(prior===undefined)delete process.env.C2C_STATE_DIR;else process.env.C2C_STATE_DIR=prior;await fs.rm(root,{recursive:true,force:true});}
},60000);
