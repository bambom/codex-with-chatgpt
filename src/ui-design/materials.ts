import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import type { Workspace } from "../workspace/manager.js";
import { atomicJson,containedPath,ensureParent,hashFile,invariant,readJson,safeRelative,UiWorkflowError,withLock } from "../ui/storage.js";

export const MATERIAL_CHUNK_BYTES=512*1024;
const schema=z.object({id:z.string().uuid(),workspaceId:z.string(),destination:z.string(),size:z.number().int().min(1).max(64*1024*1024),sha256:z.string().regex(/^[a-f0-9]{64}$/),nextOffset:z.number().int().nonnegative(),state:z.enum(["UPLOADING","PUBLISHING","COMPLETE","CANCELLED"]),publishingPath:z.string().optional()}).strict();
type Upload=z.infer<typeof schema>;
async function root(workspace:Workspace){const dir=path.join(getStateDir(),"ui-design-materials",workspace.id);await fs.mkdir(dir,{recursive:true,mode:0o700});await containedPath(dir,"check");return dir;}
async function read(workspace:Workspace,id:string){z.string().uuid().parse(id);const dir=await containedPath(await root(workspace),id),upload=schema.parse(await readJson(await containedPath(dir,"upload.json"),4096));invariant(upload.id===id&&upload.workspaceId===workspace.id&&upload.nextOffset<=upload.size,"MATERIAL_STATE_INVALID","Material transfer identity is invalid.");workspace.resolve(safeRelative(upload.destination));return{dir,upload};}
const view=(u:Upload)=>({uploadId:u.id,destinationPath:u.destination,byteLength:u.size,sha256:u.sha256,nextOffset:u.nextOffset,state:u.state,chunkBytes:MATERIAL_CHUNK_BYTES});
export async function beginMaterial(workspace:Workspace,input:{destinationPath:string;byteLength:number;sha256:string}){
  const destination=safeRelative(input.destinationPath);workspace.resolve(destination);const base=await root(workspace);
  return withLock(base,async()=>{
    let pending=0,bytes=0;
    for(const entry of await fs.readdir(base,{withFileTypes:true})){if(!entry.isDirectory()||!z.string().uuid().safeParse(entry.name).success)continue;try{const old=await read(workspace,entry.name);if(["UPLOADING","PUBLISHING"].includes(old.upload.state)){pending++;bytes+=old.upload.size;}}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
    invariant(pending<32&&bytes+input.byteLength<=256*1024*1024,"MATERIAL_TRANSFER_LIMIT","At most 32 pending transfers and 256 MiB are allowed; finish or cancel existing transfers.");
    const id=randomUUID(),upload=schema.parse({id,workspaceId:workspace.id,destination,size:input.byteLength,sha256:input.sha256,nextOffset:0,state:"UPLOADING"});
    try{await fs.lstat(await containedPath(workspace.root,destination));throw new UiWorkflowError("DESTINATION_EXISTS","Choose a new material path.");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    const dir=await containedPath(base,id);await fs.mkdir(dir,{mode:0o700});await fs.writeFile(path.join(dir,"bytes.part"),Buffer.alloc(0),{flag:"wx",mode:0o600});await atomicJson(path.join(dir,"upload.json"),upload);return view(upload);
  });
}
export async function materialStatus(workspace:Workspace,id:string){return view((await read(workspace,id)).upload);}
export async function listMaterials(workspace:Workspace){const items=[];for(const entry of await fs.readdir(await root(workspace),{withFileTypes:true})){if(!entry.isDirectory()||!z.string().uuid().safeParse(entry.name).success)continue;try{items.push(await materialStatus(workspace,entry.name));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}return{items:items.sort((a,b)=>Number(a.state==="COMPLETE")-Number(b.state==="COMPLETE")).slice(0,100)};}
export async function materialChunk(workspace:Workspace,id:string,offset:number,dataBase64:string){
  const initial=await read(workspace,id);
  return withLock(initial.dir,async()=>{
    const {dir,upload}=await read(workspace,id);invariant(upload.state==="UPLOADING","MATERIAL_STATE","Only an unfinished transfer accepts bytes.");
    invariant(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)&&dataBase64.length>0&&dataBase64.length<=Math.ceil(MATERIAL_CHUNK_BYTES/3)*4,"MATERIAL_CHUNK_INVALID","Supply bounded padded base64 bytes.");
    const bytes=Buffer.from(dataBase64,"base64");invariant(bytes.length<=MATERIAL_CHUNK_BYTES&&bytes.length>0&&bytes.toString("base64")===dataBase64&&Number.isSafeInteger(offset)&&offset>=0&&offset+bytes.length<=upload.size,"MATERIAL_RANGE","Chunk is outside the declared file.");
    const file=await containedPath(dir,"bytes.part"),handle=await fs.open(file,"r+");
    try{
      if(offset<upload.nextOffset){invariant(offset+bytes.length<=upload.nextOffset,"MATERIAL_OFFSET","Only a completely retained chunk can be replayed.");const prior=Buffer.alloc(bytes.length),read=await handle.read(prior,0,prior.length,offset);invariant(read.bytesRead===bytes.length&&prior.equals(bytes),"MATERIAL_CHUNK_CONFLICT","Retained bytes differ; use a new transfer.");return view(upload);}
      invariant(offset===upload.nextOffset,"MATERIAL_OFFSET","Continue at the retained nextOffset.");
      // Uncommitted crash-tail bytes are overwritten at the durable offset.
      let written=0;while(written<bytes.length){const part=await handle.write(bytes,written,bytes.length-written,offset+written);invariant(part.bytesWritten>0,"MATERIAL_WRITE_FAILED","Material write made no progress.");written+=part.bytesWritten;}
      await handle.truncate(offset+bytes.length);await handle.sync();upload.nextOffset+=bytes.length;await atomicJson(path.join(dir,"upload.json"),upload);return view(upload);
    }finally{await handle.close();}
  });
}
export async function materialAction(workspace:Workspace,id:string,action:"finish"|"cancel"){
  const initial=await read(workspace,id);
  return withLock(initial.dir,async()=>{
    const {dir,upload}=await read(workspace,id),file=await containedPath(dir,"bytes.part");
    if(action==="cancel"){
      invariant(upload.state!=="COMPLETE","MATERIAL_STATE","A completed material cannot be cancelled.");
      let staging:string|undefined;
      if(upload.publishingPath){invariant(path.posix.dirname(upload.publishingPath)===path.posix.dirname(upload.destination)&&path.posix.basename(upload.publishingPath).startsWith(`.material-${id}-`),"MATERIAL_STATE_INVALID","Publishing path is invalid.");staging=await containedPath(workspace.root,upload.publishingPath);try{const a=await fs.lstat(staging),b=await fs.lstat(await containedPath(workspace.root,upload.destination));invariant(a.ino!==b.ino||a.dev!==b.dev,"MATERIAL_STATE","Material was already published; finish to recover its completion state.");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
      upload.state="CANCELLED";await atomicJson(path.join(dir,"upload.json"),upload);if(staging)await fs.rm(staging,{force:true});await fs.rm(file,{force:true});return view(upload);
    }
    invariant(upload.state!=="CANCELLED"&&upload.nextOffset===upload.size,"MATERIAL_INCOMPLETE","All declared bytes must be retained before finishing.");
    const destination=await ensureParent(workspace.root,upload.destination);
    if(upload.state==="COMPLETE"){const actual=await hashFile(destination);invariant(actual.sizeBytes===upload.size&&actual.sha256===upload.sha256,"MATERIAL_CHANGED","The completed workspace file changed.");return view(upload);}
    const actual=await hashFile(file);invariant(actual.sizeBytes===upload.size&&actual.sha256===upload.sha256,"FILE_HASH","Received bytes differ from the declared length/hash.");
    let staging:string|undefined;
    if(upload.publishingPath){
      const name=path.posix.basename(upload.publishingPath);invariant(path.posix.dirname(upload.publishingPath)===path.posix.dirname(upload.destination)&&name.startsWith(`.material-${id}-`)&&name.endsWith(".tmp"),"MATERIAL_STATE_INVALID","Publishing path is invalid.");
      staging=await containedPath(workspace.root,upload.publishingPath);
      try{const bytes=await hashFile(staging);if(bytes.sha256!==upload.sha256||bytes.sizeBytes!==upload.size){await fs.unlink(staging);staging=undefined;}}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")staging=undefined;else throw e;}
    }
    if(!staging){const parent=path.posix.dirname(upload.destination);upload.publishingPath=(parent==="."?"":parent+"/")+`.material-${id}-${randomUUID()}.tmp`;workspace.resolve(upload.publishingPath);staging=await ensureParent(workspace.root,upload.publishingPath);upload.state="PUBLISHING";await atomicJson(path.join(dir,"upload.json"),upload);await fs.copyFile(file,staging,fs.constants.COPYFILE_EXCL);const copied=await hashFile(staging);invariant(copied.sha256===upload.sha256&&copied.sizeBytes===upload.size,"FILE_HASH","Staged material copy changed.");}
    try{await fs.link(staging,destination);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;const a=await fs.stat(staging),b=await fs.lstat(destination);invariant(!b.isSymbolicLink()&&a.ino===b.ino&&a.dev===b.dev,"DESTINATION_EXISTS","Another file occupies the destination; it was preserved.");}
    upload.state="COMPLETE";await atomicJson(path.join(dir,"upload.json"),upload);await fs.unlink(staging);await fs.rm(file,{force:true});return view(upload);
  });
}
