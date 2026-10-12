import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { assertDocument, canonicalize, hashDocument, hashBytes, type AuthoringDocument, type AuthoringNode, type AssetRef, type Json } from "@magicgamestudio/ui-design-contract";
import { Workspace } from "../workspace/manager.js";
import { parseScene, orderedNodes, type Scene } from "../ui/scene.js";
import { readWorkflowJob } from "../ui/workflow.js";
import type { FguiExportReport } from "../ui/fgui.js";
import { parseNativeXml,asArray } from "../ui/target.js";
import { containedPath, ensureParent, hashJson, readJson, invariant, safeRelative, UiWorkflowError, withLock } from "../ui/storage.js";
import { readBounded } from "./precheck.js";
import { prepareLocal, type LocalAssociation } from "./local.js";
import { MIGRATION_EXTENSION, legacyMigrationIssues, migrationShape, type MigrationData, type MigrationBindings, type PreservedIdentity } from "./migration-core.js";

const stable=(kind:string,key:string)=>`${kind}_${hashBytes(Buffer.from(key)).slice(0,24)}`;
const ref=(a:AssetRef):AssetRef=>({id:a.id,version:a.version,sha256:a.sha256});
const rgba=(c:string)=>c.length===7?`${c}ff`:c;
export async function inspectLegacyMigration(workspace:Workspace,id:string){
  const {root,job}=await readWorkflowJob(workspace,id),scene=parseScene(await readJson(await containedPath(root,"scene.json")));
  invariant(hashJson(scene)===job.sceneHash,"LEGACY_SOURCE_CHANGED","Legacy scene differs from its retained job hash.");
  return {jobId:id,revision:job.revision,sceneHash:job.sceneHash,scene,files:job.files,checks:job.checks,artifacts:job.artifacts,issues:legacyMigrationIssues(scene),readOnly:true,published:false,receipt:null};
}
/** Explicit conversion into a new workspace package and new preparation. The source job and its outputs are never edited. */
export async function migrateLegacy(workspace:Workspace,input:{jobId:string;designId:string;destinationDirectory:string;association:LocalAssociation}){
  invariant(/^D[A-Za-z0-9_-]{10}$/.test(input.designId),"INVALID_DESIGN_ID","Use the platform design ID.");
  const loaded=await readWorkflowJob(workspace,input.jobId);
  return withLock(loaded.root,async()=>{
    const {root,job}=await readWorkflowJob(workspace,input.jobId),scene=parseScene(await readJson(await containedPath(root,"scene.json")));
    invariant(hashJson(scene)===job.sceneHash,"LEGACY_SOURCE_CHANGED","Legacy scene differs from its retained job hash.");
    const issues=legacyMigrationIssues(scene);if(issues.length)throw new UiWorkflowError("LEGACY_MIGRATION_UNSUPPORTED","This legacy scene contains semantics without a lossless standard mapping.",{issues});
    invariant(Boolean(job.designPath)&&job.files.some(f=>f.path===job.designPath),"LEGACY_DESIGN_REQUIRED","The original approved full-canvas design must be retained.");
    const relative=safeRelative(input.destinationDirectory);workspace.resolve(relative);const destination=await ensureParent(workspace.root,relative);
    try{await fs.mkdir(destination,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new UiWorkflowError("DESTINATION_EXISTS","Choose a new migration directory.");throw error;}
    const oldInputs=await containedPath(root,"inputs"),source=new Workspace(oldInputs),bytesByPath=new Map<string,Buffer>();
    let total=0;
    for(const file of job.files){total+=file.sizeBytes;invariant(total<=256*1024*1024,"LOCAL_PACKAGE_LIMIT","Legacy input bytes exceed the migration limit.");const bytes=await readBounded(source,file.path,64*1024*1024,file.sizeBytes);invariant(hashBytes(bytes)===file.sha256,"LEGACY_SOURCE_CHANGED","Legacy file bytes differ from the registered hash.");bytesByPath.set(file.path,bytes);}
    const doc:AuthoringDocument={schemaVersion:"0.1.0",designId:input.designId,title:scene.name,canvas:{...scene.canvas,unit:"px",origin:"top-left",colorSpace:"srgb",orientation:"normalized"},roots:[],nodes:[],components:[],assets:[],fonts:[],materials:[],evidence:null as never,extensions:{}};
    const bindings:MigrationBindings={components:[],nodes:[],assets:[],fonts:[]},resources:{logicalId:string;version:number;path:string}[]=[],inline:MigrationData["preservedInline"]=[];
    const write=async(file:string,bytes:Buffer)=>{const rel=`${relative}/${file}`;workspace.resolve(rel);await fs.writeFile(await ensureParent(workspace.root,rel),bytes,{flag:"wx",mode:0o600});};
    const bind=async(logicalId:string,bytes:Buffer,extension:string)=>{const file=`resources/${logicalId}.${extension}`;await write(file,bytes);resources.push({logicalId,version:1,path:file});return {id:logicalId,version:1,sha256:hashBytes(bytes),byteLength:bytes.length};};
    const handled=new Set<string>();
    const originalBytes=bytesByPath.get(job.designPath!)!,meta=await sharp(originalBytes,{limitInputPixels:32_000_000,failOn:"warning"}).metadata();
    invariant(["png","jpeg","webp"].includes(meta.format??"")&&(meta.pages??1)===1,"LEGACY_DESIGN_INVALID","Original design must be a supported single-frame raster.");
    const original=await bind("legacy_original",originalBytes,meta.format!);handled.add(job.designPath!);
    doc.materials.push({...original,mediaType:meta.format==="jpeg"?"image/jpeg":`image/${meta.format}`,orientation:meta.orientation??1});
    const normalized=await sharp(originalBytes,{limitInputPixels:32_000_000}).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer({resolveWithObject:true});
    invariant(normalized.info.width===scene.canvas.width&&normalized.info.height===scene.canvas.height,"LEGACY_DESIGN_SIZE","Original normalized design and legacy canvas differ.");
    const approved=await bind("legacy_approved",normalized.data,"png");doc.assets.push({...approved,width:scene.canvas.width,height:scene.canvas.height,sourceWidth:scene.canvas.width,sourceHeight:scene.canvas.height,trim:{x:0,y:0},mediaType:"image/png",alpha:"rgba",provenance:"original",master:null,normalizedFrom:ref(original)});
    for(const asset of scene.assets){const bytes=bytesByPath.get(asset.file)!;invariant(bytes,"LEGACY_RESOURCE_MISSING","A legacy asset is missing.");const png=await sharp(bytes,{limitInputPixels:32_000_000,failOn:"warning"}).toColourspace("srgb").ensureAlpha().png().toBuffer({resolveWithObject:true});invariant(png.info.width===asset.width&&png.info.height===asset.height,"LEGACY_RESOURCE_SIZE","Legacy image dimensions differ.");const mapped=await bind(stable("asset",asset.id),png.data,"png");doc.assets.push({...mapped,width:asset.width,height:asset.height,sourceWidth:asset.width,sourceHeight:asset.height,trim:{x:0,y:0},mediaType:"image/png",alpha:"rgba",provenance:"original",master:null,normalizedFrom:null});bindings.assets.push({legacyId:asset.id,canonicalId:mapped.id});/* Raw source bytes are preserved independently below. */}
    for(const font of scene.fonts){const bytes=bytesByPath.get(font.file)!,license=bytesByPath.get(font.licenseFile!)!;invariant(bytes&&license&&license.length<=65536,"LEGACY_FONT_LICENSE","A fixed font and bounded license text are required.");const text=new TextDecoder("utf-8",{fatal:true}).decode(license),mapped=await bind(stable("font",font.id),bytes,bytes.toString("ascii",0,4)==="OTTO"?"otf":"ttf");doc.fonts.push({...mapped,family:font.family,license:text,substitution:null});bindings.fonts.push({legacyId:font.id,canonicalId:mapped.id});handled.add(font.file);}
    // Retain every other registered source byte: images as original materials, bounded text/data verbatim in provenance.
    let inlineSize=0;
    for(const file of job.files){if(handled.has(file.path))continue;const bytes=bytesByPath.get(file.path)!;if(["reference","design","asset"].includes(file.role)){const m=await sharp(bytes,{limitInputPixels:32_000_000}).metadata();invariant(["png","jpeg","webp"].includes(m.format??""),"LEGACY_SOURCE_TYPE","Only declared raster sources can become original materials.");const material=await bind(stable("source",file.path),bytes,m.format!);doc.materials.push({...material,mediaType:m.format==="jpeg"?"image/jpeg":`image/${m.format}`,orientation:m.orientation??1});}else{inlineSize+=bytes.length;invariant(inlineSize<=1024*1024,"LEGACY_INLINE_LIMIT","Non-raster source evidence exceeds 1 MiB; migrate it explicitly before continuing.");inline.push({path:file.path,sha256:file.sha256,base64:bytes.toString("base64")});}}
    const base=(id:string,name:string,width:number,height:number):AuthoringNode=>({id,name,kind:"Container",frame:{x:0,y:0,width,height},visible:true,opacity:1,clip:false,children:[],extensions:{}});
    const componentNodes=new Map<string,string>();for(const c of scene.components)componentNodes.set(c.id,stable("root",c.id));
    for(const c of scene.components){const rootId=componentNodes.get(c.id)!,rootNode=base(rootId,c.name,c.width,c.height);rootNode.clip=c.overflow==="hidden";doc.nodes.push(rootNode);
      const definitionId=c.id===scene.entry?null:stable("component",c.id);bindings.components.push({legacyId:c.id,rootNodeId:rootId,componentId:definitionId});
      if(definitionId)doc.components.push({id:definitionId,rootId,defaultState:"base",states:[{id:"base",overrides:[]}]});else doc.roots.push(rootId);
      for(const n of orderedNodes(c)){const id=stable("node",`${c.id}/${n.id}`),node=base(id,n.name,n.width,n.height);node.frame={x:n.x,y:n.y,width:n.width,height:n.height};node.opacity=n.alpha??1;node.visible=n.visible??true;
        if(n.type==="Component"){node.kind="Instance";node.instance={componentId:stable("component",n.componentId!),stateId:"base",overrides:[]};}
        else if(n.type==="Text"){const t=n.style!,font=doc.fonts.find(f=>f.id===stable("font",t.fontId!))!;node.kind="Text";node.text={content:n.text??"",font:ref(font),size:t.fontSize,lineHeight:t.fontSize+(t.leading??0),color:rgba(t.color),align:t.align??"left",wrap:t.singleLine?"none":"word",autoSize:"fixed",stroke:{width:0,color:"#000000ff"}};}
        else{const asset=doc.assets.find(a=>a.id===stable("asset",n.assetId!))!;node.kind="Image";node.image={asset:ref(asset),fit:n.type==="Loader"&&n.loader?.fill!=="scaleFree"?"contain":"stretch",slot:false};}
        doc.nodes.push(node);rootNode.children.push(id);bindings.nodes.push({componentId:c.id,nodeId:n.id,canonicalId:id});
      }
    }
    doc.evidence={original:ref(original),working:ref(approved),approved:ref(approved),assumptions:[...(scene.assumptions??[]),"Explicit legacy migration preserves source bytes and exported identity. New platform/native validation is required; previous PASS does not transfer."],unknownBindings:[]};
    let identity:PreservedIdentity|null=null;
    if(job.buildDirectory){const descriptor=job.artifacts.find(f=>f.path==="Reports/fgui_static.json");invariant(descriptor&&job.checks.static==="passed","LEGACY_IDENTITY_UNVERIFIED","Built jobs need a registered successful FGUI report before migration.");const build=await containedPath(root,job.buildDirectory),bytes=await readBounded(new Workspace(build),descriptor.path,16*1024*1024,descriptor.sizeBytes);invariant(hashBytes(bytes)===descriptor.sha256,"LEGACY_SOURCE_CHANGED","Legacy FGUI identity report changed.");const report=JSON.parse(bytes.toString("utf8")) as FguiExportReport;invariant(report.jobId===job.id&&report.validation.status==="passed","LEGACY_IDENTITY_UNVERIFIED","Legacy FGUI report does not match the job.");identity={packageId:report.packageId,projectId:report.projectId,packageName:report.packageName,resources:report.resources.map(({semanticId,kind,id})=>({semanticId,kind,id})),nodes:report.nodes.map(({componentId,nodeId,sourceObjectId})=>({componentId,nodeId,sourceObjectId}))};
      // Bind identity to actual immutable source files, not only a producer status string.
      const actualSource=async(file:string)=>{const artifact=job.artifacts.find(f=>f.path===`FGUI_Source/${file}`);invariant(artifact,"LEGACY_IDENTITY_UNVERIFIED","Legacy source file is missing from the inventory.");const sourceBytes=await readBounded(new Workspace(build),artifact.path,64*1024*1024,artifact.sizeBytes);invariant(hashBytes(sourceBytes)===artifact.sha256,"LEGACY_SOURCE_CHANGED","Legacy exported source file changed.");return sourceBytes;};
      const nativePackage=parseNativeXml((await actualSource(`assets/${report.packageName}/package.xml`)).toString("utf8"),"package.xml").packageDescription;
      invariant(nativePackage?.["@_id"]===report.packageId,"LEGACY_IDENTITY_UNVERIFIED","Package ID differs from its source XML.");
      for(const resource of report.resources){const sourceBytes=await actualSource(resource.file),registered=asArray(nativePackage.resources?.[resource.kind]).find((r:any)=>r["@_id"]===resource.id&&r["@_name"]===resource.name&&r["@_path"]===resource.path);invariant(registered,"LEGACY_IDENTITY_UNVERIFIED","Resource ID differs from its source package.");if(resource.kind==="component"){const display=parseNativeXml(sourceBytes.toString("utf8"),resource.name).component?.displayList??{},objects=Object.values(display).flatMap(v=>asArray(v));for(const node of report.nodes.filter(n=>n.componentId===resource.semanticId))invariant(objects.some((o:any)=>o["@_id"]===node.sourceObjectId),"LEGACY_IDENTITY_UNVERIFIED","Object ID differs from its component XML.");}}
    }
    const migration:MigrationData={format:"c2c-scene-migration-1",sourceJobId:job.id,sourceRevision:job.revision,sourceSceneSha256:hashDocument(scene),template:scene,bindings,shapeHash:migrationShape(doc),identity,identityEvidence:identity?"verified-exported-source":"no-built-source",sourceFiles:job.files.map(f=>({path:f.path,sha256:f.sha256,byteLength:f.sizeBytes})),preservedInline:inline};
    doc.extensions[MIGRATION_EXTENSION]={version:1,data:migration as unknown as Record<string,Json>};try{assertDocument(doc);}catch(error){throw new UiWorkflowError("LEGACY_STANDARD_INVALID","Converted candidate did not satisfy the fixed authoring schema.",{code:(error as {code?:string}).code,path:(error as {path?:string}).path});}
    await write("Authoring.json",Buffer.from(canonicalize(doc)));await write("Resources.json",Buffer.from(canonicalize(resources)));
    const prepared=await prepareLocal(workspace,{documentPath:`${relative}/Authoring.json`,resourcesPath:`${relative}/Resources.json`,packageDirectory:relative,association:input.association});
    return {...prepared,migration:{sourceJobId:job.id,sourceRevision:job.revision,sourceSceneSha256:migration.sourceSceneSha256,identityEvidence:migration.identityEvidence,packageId:identity?.packageId??null},sourcePackageDirectory:relative};
  });
}
