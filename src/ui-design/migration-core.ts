import { hashDocument, type AuthoringDocument, type Issue } from "@magicgamestudio/ui-design-contract";
import type { Scene } from "../ui/scene.js";

export const MIGRATION_EXTENSION="magicgamestudio/legacy-scene";
export interface MigrationBindings {
  components:{legacyId:string;rootNodeId:string;componentId:string|null}[];
  nodes:{componentId:string;nodeId:string;canonicalId:string}[];
  assets:{legacyId:string;canonicalId:string}[];
  fonts:{legacyId:string;canonicalId:string}[];
}
export interface PreservedIdentity {
  packageId:string;projectId:string;packageName:string;
  resources:{semanticId:string;kind:"image"|"font"|"component";id:string}[];
  nodes:{componentId:string;nodeId:string;sourceObjectId:string}[];
}
export interface MigrationData {
  format:"c2c-scene-migration-1";sourceJobId:string;sourceRevision:number;sourceSceneSha256:string;
  template:Scene;bindings:MigrationBindings;shapeHash:string;identity:PreservedIdentity|null;
  identityEvidence:"verified-exported-source"|"no-built-source";
  sourceFiles:{path:string;sha256:string;byteLength:number}[];
  preservedInline:{path:string;sha256:string;base64:string}[];
}
/** Structural changes need a new explicit identity migration. Content and fixed geometry can keep existing IDs. */
export function migrationShape(doc:AuthoringDocument):string {
  return hashDocument({roots:doc.roots,nodes:doc.nodes.map(n=>({id:n.id,kind:n.kind,children:n.children,clip:n.clip,instance:n.instance??null})),components:doc.components,
    assets:doc.assets.map(a=>a.id),fonts:doc.fonts.map(f=>f.id),materials:doc.materials.map(m=>m.id)});
}
/** A deliberately explicit common subset; do not resolve controller state and flatten unsupported behavior. */
export function legacyMigrationIssues(scene:Scene):Issue[] {
  const issues:Issue[]=[],add=(path:string,message:string)=>{if(issues.length<100)issues.push({code:"LEGACY_MIGRATION_UNSUPPORTED",path,message});};
  for(const [i,a] of scene.assets.entries())if(a.scale9grid||a.fgui||a.cropOffset||a.originalWidth||a.originalHeight)add(`/assets/${i}`,"Native nine-slice, trim and export variants require a dedicated semantic migration.");
  for(const [i,f] of scene.fonts.entries())if(f.fgui||!f.licenseFile)add(`/fonts/${i}`,"Migration requires one fixed font with its license; native font variants are not converted.");
  for(const [i,c] of scene.components.entries()){
    const at=`/components/${i}`;
    if(c.semantic!=="Component"||c.extension||c.controllers?.length||c.overflow==="scroll"||c.margin||c.verticalScrollBar||c.horizontalScrollBar||c.opaque)add(at,"Controllers, native controls, scrolling, margins and opaque input surfaces require a dedicated semantic migration.");
    for(const [j,n] of c.children.entries()){
      const p=`${at}/children/${j}`;
      if(!["Image","Loader","Text","Component"].includes(n.type))add(p,`Native ${n.type} is outside the current lossless migration intersection.`);
      if(n.gears?.length||n.relations?.length||n.groupId||n.input||n.list||n.ubb||n.referenceAssetId||n.bindings?.length||n.touchable!==undefined||n.instance&&Object.keys(n.instance).length)add(p,"Gears, relations, grouping, bindings, input flags, reference text and instance overrides must not be silently discarded.");
      if(n.type==="Component"&&(c.id!==scene.entry||n.componentId===scene.entry))add(p,"The standard currently allows reusable component instances only in the scene.");
      if(n.type==="Loader"&&(!n.assetId||n.loader?.shrinkOnly||n.loader?.align&&n.loader.align!=="center"||n.loader?.vAlign&&n.loader.vAlign!=="middle"||!['scale','scaleFree'].includes(n.loader?.fill??'none')))add(p,"Loader migration supports an explicit fixed image with centered contain or stretch geometry.");
      if(n.type==="Text"){
        const t=n.style;
        if(!t?.fontId||t.fontFamily&&scene.fonts.find(f=>f.id===t.fontId)?.family!==t.fontFamily||t?.vAlign&&t.vAlign!=="top"||t?.autoSize&&t.autoSize!=="none"||t?.letterSpacing||t?.bold||t?.italic||t?.underline||t?.strike||t?.strokeSize||t?.shadowColor||t?.shadowOffset)add(p,"Text migration requires fixed bounds, top alignment, one fixed font and no synthetic styles, stroke or shadow.");
        if(t&&(t.fontSize+(t.leading??0)<1))add(p,"Line height must be at least one pixel.");
      }
    }
  }
  return issues;
}
