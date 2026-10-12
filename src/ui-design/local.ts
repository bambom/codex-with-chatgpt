import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { assertDocument, canonicalize, hashDocument, hashBytes, parseStrict, validateManifest, type AuthoringDocument, type AssetManifest } from "@magicgamestudio/ui-design-contract";
import { SPEC_DIGEST } from "@magicgamestudio/ui-design-contract/spec";
import { getStateDir } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";
import { atomicJson, containedPath, ensureParent, invariant, readJson, safeRelative, UiWorkflowError, withLock } from "../ui/storage.js";
import { readBounded } from "./precheck.js";
import { LOCAL_RENDERER, reconstructDocument, refKey, type LocalResource } from "./reconstruct.js";

const UUID=z.string().uuid(), FILE_LIMIT=64*1024*1024, TOTAL_LIMIT=256*1024*1024;
const bindingsSchema=z.array(z.object({logicalId:z.string().min(1).max(80),version:z.number().int().positive(),path:z.string().min(1).max(480)}).strict()).max(2048);
const associationSchema=z.object({submissionId:z.string().regex(/^S[a-f0-9]{32}$/).optional(),baseRevision:z.number().int().min(0).max(1e9),checkpointId:UUID.optional()}).strict();
export type LocalAssociation=z.infer<typeof associationSchema>;
type Attempt={id:string;status:"RUNNING"|"SUCCEEDED"|"FAILED"|"INTERRUPTED";startedAt:string;finishedAt?:string;error?:{code:string;details?:unknown};bundle?:{directory:string;documentPath:string;manifestPath:string;assetManifestHash:string}};
interface PreparedJob {
  schemaVersion:1;id:string;workspaceId:string;designId:string;documentHash:string;specDigest:string;resources:LocalResource[];inputHash:string;
  association:LocalAssociation;createdAt:string;attempts:Attempt[];
  checks:{authoring:"PASS";resources:"PASS";platformAuthorization:"NOT_CHECKED"};
}
async function root(workspace:Workspace) {
  const dir=path.join(getStateDir(),"ui-design-preparations",workspace.id);await fs.mkdir(dir,{recursive:true,mode:0o700});
  await containedPath(dir,"check");return dir;
}
async function readJob(workspace:Workspace,id:string) {
  UUID.parse(id);const dir=await containedPath(await root(workspace),id),job=await readJson<PreparedJob>(await containedPath(dir,"job.json"),8*1024*1024);
  invariant(job.schemaVersion===1&&job.id===id&&job.workspaceId===workspace.id&&job.specDigest===SPEC_DIGEST,"LOCAL_JOB_INVALID","Preparation does not match this workspace and specification.");
  invariant(hashDocument({documentHash:job.documentHash,resources:job.resources,association:job.association})===job.inputHash,"LOCAL_JOB_CHANGED","Preparation identity changed.");return {dir,job};
}
const summary=(job:PreparedJob)=>({...job,status:job.attempts.at(-1)?.status??"PREPARED",savedLocally:true,published:false,receipt:null});
export async function localStatus(workspace:Workspace,id:string){return summary((await readJob(workspace,id)).job);}
/** A new association is a new immutable preparation; retained bytes survive deletion of the original workspace inputs. */
export async function rebindLocal(workspace:Workspace,id:string,association:LocalAssociation){
  const {dir,job}=await readJob(workspace,id),source=new Workspace(dir),newId=randomUUID(),target=await containedPath(await root(workspace),newId);
  const nextAssociation=associationSchema.parse(association);await fs.mkdir(target,{mode:0o700});
  const doc=assertDocument(new TextDecoder("utf-8",{fatal:true}).decode(await readBounded(source,"Authoring.json",8*1024*1024)));invariant(hashDocument(doc)===job.documentHash,"LOCAL_INPUT_CHANGED","Prepared authoring changed.");
  for(const resource of job.resources){const bytes=await readBounded(source,resource.path,FILE_LIMIT,resource.byteLength);invariant(hashBytes(bytes)===resource.sha256,"LOCAL_INPUT_CHANGED","Prepared resource changed.");await fs.writeFile(await ensureParent(target,resource.path),bytes,{flag:"wx",mode:0o600});}
  await fs.writeFile(path.join(target,"Authoring.json"),canonicalize(doc),{flag:"wx",mode:0o600});
  const next:PreparedJob={...job,id:newId,association:nextAssociation,inputHash:hashDocument({documentHash:job.documentHash,resources:job.resources,association:nextAssociation}),createdAt:new Date().toISOString(),attempts:[]};
  await atomicJson(path.join(target,"job.json"),next);return {...summary(next),sourcePreparationId:id};
}
export async function listLocalPreparations(workspace:Workspace){
  const items=[];for(const entry of await fs.readdir(await root(workspace),{withFileTypes:true})){if(!entry.isDirectory()||!UUID.safeParse(entry.name).success)continue;try{const {job}=await readJob(workspace,entry.name);items.push({id:job.id,designId:job.designId,documentHash:job.documentHash,association:job.association,createdAt:job.createdAt,status:job.attempts.at(-1)?.status??"PREPARED"});}catch{/* Incomplete prepare directories are never advertised as prepared. */}}
  return {items:items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,100),published:false,receipt:null};
}
/** Snapshot the entire dependency closure before registering an immutable, recoverable local job. */
export async function prepareLocal(workspace:Workspace,input:{documentPath:string;resourcesPath:string;packageDirectory:string;association:LocalAssociation}) {
  const document=assertDocument(new TextDecoder("utf-8",{fatal:true}).decode(await readBounded(workspace,input.documentPath,8*1024*1024)));
  const bindings=bindingsSchema.parse(parseStrict(new TextDecoder("utf-8",{fatal:true}).decode(await readBounded(workspace,input.resourcesPath,1024*1024))));
  const association=associationSchema.parse(input.association),directory=input.packageDirectory==="."?"":safeRelative(input.packageDirectory);
  const refs=[...document.materials,...document.assets,...document.fonts],required=new Map(refs.map(ref=>[refKey(ref),ref]));
  invariant(bindings.length===required.size&&new Set(bindings.map(b=>`${b.logicalId}:${b.version}`)).size===bindings.length&&bindings.every(b=>required.has(`${b.logicalId}:${b.version}`)),"LOCAL_RESOURCE_CLOSURE","Resource bindings must name exactly every material, asset and font version, once.");
  invariant(refs.reduce((total,ref)=>total+ref.byteLength,0)<=TOTAL_LIMIT,"LOCAL_PACKAGE_LIMIT","The preparation resource limit is 256 MiB.");
  const id=randomUUID(),dir=await containedPath(await root(workspace),id);await fs.mkdir(dir,{mode:0o700});await fs.mkdir(path.join(dir,"inputs"),{mode:0o700});
  const resources:LocalResource[]=[];
  for(const binding of bindings){
    const key=`${binding.logicalId}:${binding.version}`,ref=required.get(key)!;
    const bytes=await readBounded(workspace,directory?`${directory}/${safeRelative(binding.path)}`:binding.path,FILE_LIMIT,ref.byteLength);
    invariant(hashBytes(bytes)===ref.sha256,"FILE_HASH","Resource bytes differ from the authoring reference.");
    const asset=document.assets.find(r=>refKey(r)===key),font=document.fonts.find(r=>refKey(r)===key);
    if(asset){const image=sharp(bytes,{limitInputPixels:32_000_000,failOn:"warning"}),meta=await image.metadata();invariant(meta.format==="png"&&meta.channels===4&&meta.hasAlpha&&(meta.pages??1)===1&&meta.width===asset.width&&meta.height===asset.height,"LOCAL_IMAGE_INVALID","Assets must be exact-size single-frame RGBA PNGs.");await image.stats();}
    const role:LocalResource["role"]=font?"font":asset?(refKey(document.evidence.approved)===key?"approved":"asset"):"original";
    const ext=font?(bytes.toString("ascii",0,4)==="OTTO"?"otf":"ttf"):asset?"png":"bin";
    const file=`inputs/${String(resources.length).padStart(4,"0")}-${ref.sha256.slice(0,16)}.${ext}`;
    await fs.writeFile(path.join(dir,file),bytes,{flag:"wx",mode:0o600});
    resources.push({logicalId:ref.id,version:ref.version,path:file,role,sha256:ref.sha256,byteLength:ref.byteLength});
  }
  await fs.writeFile(path.join(dir,"Authoring.json"),canonicalize(document),{flag:"wx",mode:0o600});
  const documentHash=hashDocument(document),job:PreparedJob={schemaVersion:1,id,workspaceId:workspace.id,designId:document.designId,documentHash,specDigest:SPEC_DIGEST,resources,inputHash:hashDocument({documentHash,resources,association}),association,createdAt:new Date().toISOString(),attempts:[],checks:{authoring:"PASS",resources:"PASS",platformAuthorization:"NOT_CHECKED"}};
  await atomicJson(path.join(dir,"job.json"),job);return summary(job);
}

/** Register the completed output only after every exact input and generated manifest was validated. */
export async function reconstructLocal(workspace:Workspace,id:string,destinationDirectory:string) {
  const loaded=await readJob(workspace,id);
  return withLock(loaded.dir,async()=>{
    const {dir,job}=await readJob(workspace,id);
    invariant(job.attempts.length<20,"LOCAL_ATTEMPT_LIMIT","Create a new preparation after 20 attempts.");
    for(const old of job.attempts)if(old.status==="RUNNING"){old.status="INTERRUPTED";old.finishedAt=new Date().toISOString();}
    const relative=safeRelative(destinationDirectory);workspace.resolve(relative);
    // mkdir is exclusive, unlike rename on a replaced directory. A failed attempt can leave an explicitly incomplete new directory, never an old destination overwritten.
    const output=await ensureParent(workspace.root,relative);
    try{await fs.mkdir(output,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new UiWorkflowError("DESTINATION_EXISTS","Choose a new directory; existing output is preserved.");throw error;}
    await containedPath(workspace.root,`${relative}/Authoring.json`);
    const attempt:Attempt={id:randomUUID(),status:"RUNNING",startedAt:new Date().toISOString()};job.attempts.push(attempt);await atomicJson(path.join(dir,"job.json"),job);
    const attemptDir=await ensureParent(dir,`attempts/${attempt.id}/marker`);await fs.mkdir(path.dirname(attemptDir),{recursive:true,mode:0o700});
    const stage=path.dirname(attemptDir),packageRoot=path.join(stage,"package");await fs.mkdir(packageRoot,{mode:0o700});
    try {
      const stateWorkspace=new Workspace(dir),doc=assertDocument(new TextDecoder("utf-8",{fatal:true}).decode(await readBounded(stateWorkspace,"Authoring.json",8*1024*1024)));
      invariant(hashDocument(doc)===job.documentHash,"LOCAL_INPUT_CHANGED","Prepared authoring changed.");
      for(const resource of job.resources){const bytes=await readBounded(stateWorkspace,resource.path,FILE_LIMIT,resource.byteLength);invariant(hashBytes(bytes)===resource.sha256,"LOCAL_INPUT_CHANGED","Prepared resource changed.");const out=await ensureParent(packageRoot,resource.path);await fs.writeFile(out,bytes,{flag:"wx",mode:0o600});}
      const render=await reconstructDocument(doc,job.resources,packageRoot,packageRoot);
      const provenance={schemaVersion:1,preparationId:job.id,attemptId:attempt.id,inputHash:job.inputHash,documentHash:job.documentHash,rendererVersion:LOCAL_RENDERER,association:job.association,originalEvidence:doc.evidence,resourcePins:job.resources,localRender:render,sourceExtensions:doc.extensions};
      const provenanceBytes=Buffer.from(canonicalize(provenance)),provenanceFile={path:"Provenance.json",role:"provenance" as const,logicalId:"local_provenance",version:1,sha256:hashBytes(provenanceBytes),byteLength:provenanceBytes.length};
      const manifest:AssetManifest={schemaVersion:"0.1.0",designId:job.designId,submissionId:job.association.submissionId??`Local_${job.id.replaceAll("-","")}`,baseRevision:job.association.baseRevision,specDigest:SPEC_DIGEST,documentHash:job.documentHash,files:[...job.resources,{...render.preview,role:"preview",logicalId:"local_preview",version:1},{...render.overview,role:"overview",logicalId:"local_overview",version:1},provenanceFile]};
      const checked=validateManifest(doc,manifest,{submissionId:manifest.submissionId,baseRevision:manifest.baseRevision,specDigest:SPEC_DIGEST});invariant(checked.valid,"LOCAL_MANIFEST_INVALID","Generated bundle failed the shared manifest contract.");
      await fs.writeFile(path.join(packageRoot,"Authoring.json"),canonicalize(doc),{flag:"wx",mode:0o600});await fs.writeFile(path.join(packageRoot,"Manifest.json"),canonicalize(manifest),{flag:"wx",mode:0o600});await fs.writeFile(path.join(packageRoot,"Provenance.json"),provenanceBytes,{flag:"wx",mode:0o600});
      await atomicJson(path.join(stage,"report.json"),{...render,documentHash:job.documentHash,assetManifestHash:checked.assetManifestHash});
      // Bounded known-file copy, with new exclusive leaves and workspace policy rechecked for each file.
      for(const file of [...manifest.files,...render.layers,{path:"Authoring.json"},{path:"Manifest.json"}]){
        const outRel=`${relative}/${file.path}`;workspace.resolve(outRel);const target=await ensureParent(workspace.root,outRel);await fs.copyFile(await containedPath(packageRoot,file.path),target,fs.constants.COPYFILE_EXCL);
      }
      attempt.status="SUCCEEDED";attempt.finishedAt=new Date().toISOString();attempt.bundle={directory:relative,documentPath:`${relative}/Authoring.json`,manifestPath:`${relative}/Manifest.json`,assetManifestHash:checked.assetManifestHash!};await atomicJson(path.join(dir,"job.json"),job);
      return {...summary(job),bundle:attempt.bundle,submissionReady:Boolean(job.association.submissionId),reconstruction:render};
    }catch(error){attempt.status="FAILED";attempt.finishedAt=new Date().toISOString();attempt.error=error instanceof UiWorkflowError?{code:error.code,details:error.details}:{code:"LOCAL_RECONSTRUCTION_FAILED"};await atomicJson(path.join(dir,"job.json"),job);throw error;}
  });
}
