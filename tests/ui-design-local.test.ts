import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { afterEach,it,expect } from "vitest";
import { assertDocument,hashBytes,hashDocument,parseStrict,validateManifest,type AuthoringDocument } from "@magicgamestudio/ui-design-contract";
import { SPEC_DIGEST } from "@magicgamestudio/ui-design-contract/spec";
import { Workspace } from "../src/workspace/manager.js";
import { prepareLocal,rebindLocal,reconstructLocal,localStatus } from "../src/ui-design/local.js";
import { precheckAuthoring } from "../src/ui-design/precheck.js";
import { createJob,importFile,setScene,readWorkflowJob,saveWorkflowJob,inventoryArtifacts } from "../src/ui/workflow.js";
import { exportFgui } from "../src/ui/fgui.js";
import { migrateLegacy,inspectLegacyMigration } from "../src/ui-design/migration.js";
import { MIGRATION_EXTENSION } from "../src/ui-design/migration-core.js";
import type { Scene } from "../src/ui/scene.js";
import type { TargetProfile } from "../src/ui/target.js";
import { makeTmpDir,cleanup } from "./helpers.js";
import { beginMaterial,materialChunk,materialAction,materialStatus } from "../src/ui-design/materials.js";
import { registerUiTools } from "../src/ui/tools.js";
import { registerUiDesignTools } from "../src/ui-design/tools.js";
const packageRoot=path.resolve(path.dirname(createRequire(import.meta.url).resolve("@magicgamestudio/ui-design-contract")),"../.."),fixtures=path.join(packageRoot,"fixtures");
const roots:string[]=[];const prior=process.env.C2C_STATE_DIR;
afterEach(()=>{roots.splice(0).forEach(cleanup);if(prior===undefined)delete process.env.C2C_STATE_DIR;else process.env.C2C_STATE_DIR=prior;});
async function setup(){const root=makeTmpDir("standard-local");roots.push(root);process.env.C2C_STATE_DIR=path.join(root,"state");const work=path.join(root,"workspace");await fs.mkdir(work);const workspace=new Workspace(work);await fs.cp(fixtures,path.join(work,"input"),{recursive:true});return{root,work,workspace};}
async function inputs(work:string,edit=(d:AuthoringDocument)=>{}){const doc=JSON.parse(await fs.readFile(path.join(work,"input/complete.authoring.json"),"utf8")) as AuthoringDocument;edit(doc);assertDocument(doc);await fs.writeFile(path.join(work,"Authoring.json"),JSON.stringify(doc));const m=JSON.parse(await fs.readFile(path.join(work,"input/submission-fixtures.json"),"utf8"));await fs.writeFile(path.join(work,"Resources.json"),JSON.stringify(m.manifest.files.filter((f:{role:string})=>['original','asset','approved','font'].includes(f.role)).map((f:{logicalId:string;version:number;path:string})=>({logicalId:f.logicalId,version:f.version,path:f.path}))));return doc;}
const association={baseRevision:0,submissionId:"S"+"1".repeat(32)};
it("resumes actual material chunks after restart, validates whole bytes and never overwrites a workspace file",async()=>{
  const {root,work,workspace}=await setup(),bytes=Buffer.alloc(700000,35),upload=await beginMaterial(workspace,{destinationPath:"transferred/art.png",byteLength:bytes.length,sha256:hashBytes(bytes)});
  const first=bytes.subarray(0,512*1024);await materialChunk(workspace,upload.uploadId,0,first.toString("base64"));await materialChunk(workspace,upload.uploadId,0,first.toString("base64"));
  await expect(materialChunk(workspace,upload.uploadId,0,Buffer.from("wrong").toString("base64"))).rejects.toMatchObject({code:"MATERIAL_CHUNK_CONFLICT"});
  const input=path.join(root,"transfer.json");await fs.writeFile(input,JSON.stringify({work,id:upload.uploadId,offset:first.length,bytes:bytes.subarray(first.length).toString("base64")}));
  const script=`import fs from 'node:fs/promises';import{Workspace}from'./dist/workspace/manager.js';import{materialStatus,materialChunk,materialAction}from'./dist/ui-design/materials.js';const i=JSON.parse(await fs.readFile(process.argv[1],'utf8')),w=new Workspace(i.work);if((await materialStatus(w,i.id)).nextOffset!==i.offset)throw Error('offset');await materialChunk(w,i.id,i.offset,i.bytes);await materialAction(w,i.id,'finish');`;
  execFileSync(process.execPath,["--input-type=module","-e",script,input],{cwd:path.resolve("."),env:process.env,timeout:30000});expect(await fs.readFile(path.join(work,"transferred/art.png"))).toEqual(bytes);expect((await materialAction(workspace,upload.uploadId,"finish")).state).toBe("COMPLETE");
  await expect(beginMaterial(workspace,{destinationPath:"transferred/art.png",byteLength:1,sha256:hashBytes(Buffer.from("x"))})).rejects.toMatchObject({code:"DESTINATION_EXISTS"});
  const bad=await beginMaterial(workspace,{destinationPath:"transferred/bad.png",byteLength:1,sha256:hashBytes(Buffer.from("x"))});await materialChunk(workspace,bad.uploadId,0,Buffer.from("y").toString("base64"));await expect(materialAction(workspace,bad.uploadId,"finish")).rejects.toMatchObject({code:"FILE_HASH"});await materialAction(workspace,bad.uploadId,"cancel");expect((await materialStatus(workspace,bad.uploadId)).state).toBe("CANCELLED");await expect(fs.stat(path.join(work,"transferred/bad.png"))).rejects.toMatchObject({code:"ENOENT"});
},60000);
it("keeps legacy mutations read-only and enforces write scope on all new local entrypoints",async()=>{
  const {work,workspace}=await setup(),registered=new Map<string,Function>(),server={registerResource(){},registerTool(name:string,_config:unknown,handler:Function){registered.set(name,handler);}},logger={error(){}};
  registerUiTools(server as never,{workspace,logger:logger as never});registerUiDesignTools(server as never,{workspace,logger:logger as never});
  const read={authInfo:{scopes:["workspace.read"]}},write={authInfo:{scopes:["workspace.read","workspace.write","workspace.execute"]}};
  for(const name of ["ui_create_job","ui_import_file","ui_build","ui_validate_native","ui_deliver"]){const r=await registered.get(name)!({},write);expect(JSON.parse(r.content[0].text).error).toBe("LEGACY_READ_ONLY");}
  for(const name of ["ui_design_prepare","ui_design_reconstruct","ui_design_migrate","ui_design_material_begin","ui_design_material_chunk"]){const r=await registered.get(name)!({},read);expect(JSON.parse(r.content[0].text).error).toBe("INSUFFICIENT_SCOPE");}
  const info=await registered.get("ui_workflow_info")!({action:"capabilities"},read);expect(JSON.parse(info.content[0].text).data.readOnly).toBe(true);
  try{execFileSync(process.execPath,["bin/c2c.js","ui","--workspace",work,"--json","create","--name","old"],{cwd:path.resolve("."),encoding:"utf8",env:process.env});throw Error("expected read-only rejection");}catch(e){expect(String((e as {stdout:unknown}).stdout)).toContain("LEGACY_READ_ONLY");}
});
it("reconstructs retained canonical resources in a second process, preserves alpha and creates a complete valid bundle without a target",async()=>{
  const {work,workspace}=await setup(),doc=await inputs(work),job=await prepareLocal(workspace,{documentPath:"Authoring.json",resourcesPath:"Resources.json",packageDirectory:"input",association});
  await fs.rm(path.join(work,"input"),{recursive:true});
  let output;try{output=execFileSync(process.execPath,["bin/c2c.js","ui-design","--workspace",work,"--json","reconstruct",job.id,"--destination","bundle"],{cwd:path.resolve("."),encoding:"utf8",env:process.env,timeout:60000});}catch(e){throw Error(String((e as {stdout:unknown}).stdout));}
  const result=JSON.parse(output.trim());expect(result.ok).toBe(true);expect(result.published).toBe(false);expect(result.receipt).toBeNull();expect(result.reconstruction.layers.some((l:{kind:string})=>l.kind==="Text")).toBe(true);
  const report=await precheckAuthoring(workspace,{documentPath:"bundle/Authoring.json",manifestPath:"bundle/Manifest.json",packageDirectory:"bundle",submissionId:association.submissionId,baseRevision:0,verifyFiles:true});expect(report.valid).toBe(true);
  const meta=await sharp(path.join(work,"bundle/Preview.png")).metadata();expect(meta.width).toBe(doc.canvas.width);expect(meta.height).toBe(doc.canvas.height);expect(meta.channels).toBe(4);
  const preserved=await fs.readFile(path.join(work,"bundle/Manifest.json"));await expect(reconstructLocal(workspace,job.id,"bundle")).rejects.toMatchObject({code:"DESTINATION_EXISTS"});expect(await fs.readFile(path.join(work,"bundle/Manifest.json"))).toEqual(preserved);
  const next=await rebindLocal(workspace,job.id,{baseRevision:1,submissionId:"S"+"2".repeat(32)});expect(next.id).not.toBe(job.id);expect(next.documentHash).toBe(job.documentHash);expect((await localStatus(workspace,job.id)).association).toEqual(association);
},90000);
it("retains node-specific reconstruction failures and rejects changed bytes and escaped resource paths",async()=>{
  const {root,work,workspace}=await setup();await inputs(work,d=>{d.nodes.find(n=>n.kind==="Text")!.text!.stroke.width=1;});
  const job=await prepareLocal(workspace,{documentPath:"Authoring.json",resourcesPath:"Resources.json",packageDirectory:"input",association});
  await expect(reconstructLocal(workspace,job.id,"failed-output")).rejects.toMatchObject({code:"LOCAL_TEXT_STROKE_UNSUPPORTED",details:{nodeId:"title"}});
  const failed=await localStatus(workspace,job.id);expect(failed.status).toBe("FAILED");expect(failed.attempts[0].error?.code).toBe("LOCAL_TEXT_STROKE_UNSUPPORTED");
  const input=path.join(root,"state/ui-design-preparations",workspace.id,job.id,job.resources[0].path);const bytes=await fs.readFile(input);bytes[0]^=1;await fs.writeFile(input,bytes);
  await expect(reconstructLocal(workspace,job.id,"changed-output")).rejects.toMatchObject({code:"LOCAL_INPUT_CHANGED"});expect((await localStatus(workspace,job.id)).attempts).toHaveLength(2);
  const bindings=JSON.parse(await fs.readFile(path.join(work,"Resources.json"),"utf8"));bindings[0].path="../Authoring.json";await fs.writeFile(path.join(work,"Resources.json"),JSON.stringify(bindings));await expect(prepareLocal(workspace,{documentPath:"Authoring.json",resourcesPath:"Resources.json",packageDirectory:"input",association})).rejects.toMatchObject({code:"INVALID_PATH"});
});
it("explicit migration preserves legacy source bytes and native identity while unsupported behavior remains blocked",async()=>{
  const {work,workspace}=await setup();await fs.writeFile(path.join(work,"license.txt"),"OFL-1.1");
  let job=await createJob(workspace,{name:"Legacy fixture",designFile:"input/files/reference.png"});
  for(const [source,file,role] of [["input/files/skin.png","skin.png","asset"],["input/files/fixture-font.ttf","font.ttf","font"],["license.txt","license.txt","license"]] as const)job=await importFile(workspace,job.id,{sourcePath:source,path:file,role});
  const scene:Scene={schemaVersion:1,id:"old_scene",name:"Legacy",canvas:{width:640,height:480},entry:"entry",assets:[{id:"skin",file:"skin.png",width:16,height:12}],fonts:[{id:"font",file:"font.ttf",family:"Magic UI Fixture Regular",licenseFile:"license.txt"}],components:[{id:"entry",name:"Entry",semantic:"Component",width:640,height:480,children:[{id:"item",name:"item",type:"Component",componentId:"item",x:20,y:30,width:100,height:70}]},{id:"item",name:"Item",semantic:"Component",width:100,height:70,children:[{id:"image",name:"image",type:"Image",assetId:"skin",x:0,y:0,width:100,height:70},{id:"text",name:"text",type:"Text",text:"标题中文",x:0,y:0,width:100,height:32,style:{fontId:"font",fontFamily:"Magic UI Fixture Regular",fontSize:20,color:"#112233",singleLine:true}}]}]};
  await setScene(workspace,job.id,{scene,expectedRevision:job.revision});const original=await readWorkflowJob(workspace,job.id);
  // Only a narrow file exporter fixture; actual target research/native validation belongs to the platform probe.
  const profile={schemaVersion:1,id:"target_fixture",status:"ready",adapter:"fairygui-source-5.0-v1",project:{file:"test.fairy",type:"Layabox",version:"5.0"},capabilities:{confirmed:["Component","Image","Text","Font"],unconfirmed:[]},limits:{files:100,totalBytes:10000000,fileBytes:10000000,xmlBytes:1000000,xmlDepth:32,objects:1000},evidence:[],rendering:{percentageRounding:"floor"}} as unknown as TargetProfile;
  const build=path.join(original.root,"builds/migration-fixture");await fs.mkdir(path.join(build,"Reports"),{recursive:true});const report=await exportFgui(scene,profile,path.join(original.root,"inputs"),path.join(build,"FGUI_Source"),job.id);await fs.writeFile(path.join(build,"Reports/fgui_static.json"),JSON.stringify(report));
  original.job.buildDirectory="builds/migration-fixture";original.job.artifacts=await inventoryArtifacts(build);original.job.checks.static="passed";await saveWorkflowJob(original.root,original.job);
  const sourceJob=await fs.readFile(path.join(original.root,"job.json")),sourceScene=await fs.readFile(path.join(original.root,"scene.json"));
  const migrated=await migrateLegacy(workspace,{jobId:job.id,designId:"D1234567890",destinationDirectory:"migration",association}).catch(e=>{throw Error(JSON.stringify({code:e.code,details:e.details}));});expect(migrated.migration.packageId).toBe(report.packageId);expect(migrated.migration.identityEvidence).toBe("verified-exported-source");
  expect(await fs.readFile(path.join(original.root,"job.json"))).toEqual(sourceJob);expect(await fs.readFile(path.join(original.root,"scene.json"))).toEqual(sourceScene);
  const doc=assertDocument(await fs.readFile(path.join(work,"migration/Authoring.json"),"utf8"));expect(doc.components).toHaveLength(1);expect(doc.nodes.some(n=>n.kind==="Instance")).toBe(true);
  expect(doc.extensions[MIGRATION_EXTENSION].data.identity).toEqual({packageId:report.packageId,projectId:report.projectId,packageName:report.packageName,resources:report.resources.map(({semanticId,kind,id})=>({semanticId,kind,id})),nodes:report.nodes.map(({componentId,nodeId,sourceObjectId})=>({componentId,nodeId,sourceObjectId}))});
  const reconstruction=await reconstructLocal(workspace,migrated.id,"migration-bundle");expect(reconstruction.status).toBe("SUCCEEDED");
  const unsupported=structuredClone(scene);unsupported.components[1].controllers=[{name:"state",pages:[{id:"a",name:"a"}],selectedPageId:"a"}];const current=await readWorkflowJob(workspace,job.id);await setScene(workspace,job.id,{scene:unsupported,expectedRevision:current.job.revision});
  expect((await inspectLegacyMigration(workspace,job.id)).issues[0].path).toBe("/components/1");await expect(migrateLegacy(workspace,{jobId:job.id,designId:"D1234567890",destinationDirectory:"blocked",association})).rejects.toMatchObject({code:"LEGACY_MIGRATION_UNSUPPORTED"});
  await expect(fs.stat(path.join(work,"blocked"))).rejects.toMatchObject({code:"ENOENT"});
},60000);
