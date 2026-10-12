import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { evaluateLayout, hashBytes, type AuthoringDocument, type AssetRef, type Frame } from "@magicgamestudio/ui-design-contract";
import { Workspace } from "../workspace/manager.js";
import { invariant, UiWorkflowError } from "../ui/storage.js";
import { checkFont, type CheckedFont } from "./fonts.js";

export const LOCAL_RENDERER = "standard-sharp-pango-1";
export const refKey = (ref: Pick<AssetRef, "id" | "version">) => `${ref.id}:${ref.version}`;
export interface LocalResource { logicalId: string; version: number; path: string; sha256: string; byteLength: number; role: "asset" | "approved" | "font" | "original" }
export interface LocalLayer {
  key: string; nodeId: string; instanceId?: string; kind: string; name: string;
  frame: Frame; clip: Frame; visible: boolean; opacity: number;
  x: number; y: number; width: number; height: number; path: string; sha256: string; byteLength: number;
}
const MAX_PIXELS = 32_000_000, MAX_TOTAL = 128_000_000;
const xml = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
const blank = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
function pixelLimit(w: number, h: number) { invariant(w > 0 && h > 0 && w * h <= MAX_PIXELS, "LOCAL_RASTER_LIMIT", "A raster exceeds 32 million pixels."); }
function intersection(a: Frame, b: Frame): Frame {
  const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y);
  return {x,y,width:Math.max(0,Math.min(a.x+a.width,b.x+b.width)-x),height:Math.max(0,Math.min(a.y+a.height,b.y+b.height)-y)};
}
function bounds(f: Frame) { return { x:Math.floor(f.x),y:Math.floor(f.y),width:Math.max(1,Math.ceil(f.x+f.width)-Math.floor(f.x)),height:Math.max(1,Math.ceil(f.y+f.height)-Math.floor(f.y)) }; }
function bitmap(png: Buffer, x: number, y: number, w: number, h: number) {
  return `<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" href="data:image/png;base64,${png.toString("base64")}"/>`;
}
function svg(area: Frame, clip: Frame, opacity: number, body: string) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${area.width}" height="${area.height}" viewBox="${area.x} ${area.y} ${area.width} ${area.height}"><defs><clipPath id="c"><rect x="${clip.x}" y="${clip.y}" width="${clip.width}" height="${clip.height}"/></clipPath></defs><g clip-path="url(#c)" opacity="${opacity}">${body}</g></svg>`);
}

/** Canonical geometry and fixed byte resources; local Pango pixels are explicitly distinct from platform Java2D validation. */
export async function reconstructDocument(doc: AuthoringDocument, resources: LocalResource[], inputDirectory: string, outputDirectory: string) {
  const canvas={x:0,y:0,width:doc.canvas.width,height:doc.canvas.height};pixelLimit(canvas.width,canvas.height);
  const entries=evaluateLayout(doc).filter(e=>e.kind==="Image"||e.kind==="Text");
  invariant(entries.length<=512,"LOCAL_LAYER_LIMIT","At most 512 visible or hidden image/text leaves can be reconstructed.");
  const workspace=new Workspace(inputDirectory),files=new Map(resources.map(r=>[`${r.logicalId}:${r.version}`,r]));
  const images=new Map<string,Buffer>(),fonts=new Map<string,CheckedFont>(),layers:LocalLayer[]=[];
  let pixels=canvas.width*canvas.height, decodedPixels=0;
  await fs.mkdir(path.join(outputDirectory,"layers"),{recursive:true});
  for (const entry of entries) {
    try {
      const f=entry.frame;
      let clip=intersection(canvas,entry.clip),body="",paint=f;
      if(entry.kind==="Image") {
        clip=intersection(clip,f);
        const ref=entry.node.image!.asset,key=refKey(ref),asset=doc.assets.find(a=>refKey(a)===key)!;
        let png=images.get(key);
        if(!png){
          const file=files.get(key)!;png=await fs.readFile(workspace.resolve(file.path).abs);
          invariant(hashBytes(png)===ref.sha256,"LOCAL_INPUT_CHANGED","Image bytes changed after preparation.");
          decodedPixels+=asset.width*asset.height;invariant(decodedPixels<=MAX_PIXELS,"LOCAL_DECODE_LIMIT","Decoded assets exceed 32 million pixels.");images.set(key,png);
        }
        let sx=f.width/asset.sourceWidth,sy=f.height/asset.sourceHeight,dx=0,dy=0;
        if(entry.node.image!.fit==="contain"){sx=sy=Math.min(sx,sy);dx=(f.width-asset.sourceWidth*sx)/2;dy=(f.height-asset.sourceHeight*sy)/2;}
        body=bitmap(png,f.x+dx+asset.trim.x*sx,f.y+dy+asset.trim.y*sy,asset.width*sx,asset.height*sy);
      } else {
        const text=entry.node.text!,key=refKey(text.font),font=doc.fonts.find(r=>refKey(r)===key)!;
        // The current platform validator also rejects stroke. Never silently omit it.
        invariant(text.stroke.width===0,"LOCAL_TEXT_STROKE_UNSUPPORTED","Text stroke requires an implemented standard renderer.");
        let checked=fonts.get(key);
        if(!checked){checked=await checkFont(workspace,{id:font.id,file:files.get(key)!.path,family:font.family});invariant(checked.sha256===font.sha256,"LOCAL_INPUT_CHANGED","Font bytes changed after preparation.");fonts.set(key,checked);}
        const missing=[...new Set(Array.from(text.content).filter(c=>!/[\r\n\t]/u.test(c)&&!checked!.hasGlyph(c.codePointAt(0)!)))];
        invariant(!missing.length,"LOCAL_FONT_GLYPH_MISSING",`Fixed font lacks ${missing.slice(0,16).map(c=>`U+${c.codePointAt(0)!.toString(16)}`).join(", ")}.`);
        invariant(Array.from(text.content).length*Math.max(text.size,text.lineHeight)*Math.max(text.size,text.lineHeight)<=MAX_PIXELS,"LOCAL_TEXT_LIMIT","Text shaping exceeds the raster budget.");
        if(text.content.trim()) {
          // Pango >=1.50 absolute line_height units: https://docs.gtk.org/Pango/pango_markup.html
          invariant(text.lineHeight>=1,"LOCAL_LINE_HEIGHT_UNSUPPORTED","Local Pango requires lineHeight of at least one pixel.");
          const glyph=await sharp({text:{text:`<span font_family="${xml(checked.family)}" font_size="${Math.round(text.size*1024)}" foreground="${text.color}" line_height="${Math.round(text.lineHeight*1024)}" fallback="false" insert_hyphens="false">${xml(text.content)}</span>`,font:`${checked.family} ${checked.face} ${text.size}`,fontfile:checked.renderFile,dpi:72,rgba:true,
            ...(text.wrap==="word"?{width:Math.max(1,Math.round(f.width)),wrap:"word-char" as const}:{}),align:text.align as "left"|"center"|"right"}}).png().toBuffer({resolveWithObject:true});
          pixelLimit(glyph.info.width,glyph.info.height);
          // Sharp crops to ink bounds. Preserve the complete text raster (including overflow) and expose this metric difference.
          const x=f.x+(text.align==="center"?(f.width-glyph.info.width)/2:text.align==="right"?f.width-glyph.info.width:0);
          body=bitmap(glyph.data,x,f.y,glyph.info.width,glyph.info.height);
          paint={x:Math.min(f.x,x),y:f.y,width:Math.max(f.x+f.width,x+glyph.info.width)-Math.min(f.x,x),height:Math.max(f.height,glyph.info.height)};
        }
      }
      clip=intersection(clip,paint);
      const empty=clip.width===0||clip.height===0;
      const area=empty?{x:0,y:0,width:1,height:1}:bounds(clip);
      pixelLimit(area.width,area.height);pixels+=area.width*area.height;
      invariant(pixels<=MAX_TOTAL,"LOCAL_RASTER_LIMIT","Layer rasters exceed 128 million pixels.");
      const png=empty?await blank(1,1).png().toBuffer():await sharp(svg(area,clip,entry.opacity,body),{limitInputPixels:MAX_PIXELS}).ensureAlpha().png().toBuffer();
      const rel=`layers/${String(layers.length).padStart(4,"0")}-${hashBytes(Buffer.from(entry.key)).slice(0,16)}.png`;
      await fs.writeFile(path.join(outputDirectory,rel),png,{flag:"wx",mode:0o600});
      layers.push({key:entry.key,nodeId:entry.nodeId,...(entry.instanceId?{instanceId:entry.instanceId}:{}),kind:entry.kind,name:entry.node.name,frame:f,clip:entry.clip,visible:entry.visible,opacity:entry.opacity,...area,path:rel,sha256:hashBytes(png),byteLength:png.length});
    } catch(error) {
      if(error instanceof UiWorkflowError)throw new UiWorkflowError(error.code,error.message,{nodeId:entry.nodeId,key:entry.key,path:`/nodes/${doc.nodes.findIndex(n=>n.id===entry.nodeId)}`});
      throw new UiWorkflowError("LOCAL_RENDER_FAILED","Rasterization failed for this node.",{nodeId:entry.nodeId,key:entry.key});
    }
  }
  const visible=layers.filter(l=>l.visible), base=blank(canvas.width,canvas.height);
  const overlays=[];for(const l of visible)overlays.push({input:await fs.readFile(path.join(outputDirectory,l.path)),left:l.x,top:l.y});
  const preview=await (overlays.length?base.composite(overlays):base).png().toBuffer();
  await fs.writeFile(path.join(outputDirectory,"Preview.png"),preview,{flag:"wx",mode:0o600});
  const columns=4,cell=180,rows=Math.max(1,Math.ceil(layers.length/columns));
  const tiles=[];
  for(let i=0;i<layers.length;i++){const thumbnail=await sharp(await fs.readFile(path.join(outputDirectory,layers[i].path))).resize(164,144,{fit:"inside",withoutEnlargement:true}).png().toBuffer();tiles.push({input:thumbnail,left:(i%columns)*cell+8,top:Math.floor(i/columns)*cell+8});}
  const overview=await (tiles.length?blank(columns*cell,rows*cell).composite(tiles):blank(columns*cell,rows*cell)).png().toBuffer();
  await fs.writeFile(path.join(outputDirectory,"Overview.png"),overview,{flag:"wx",mode:0o600});
  return {rendererVersion:LOCAL_RENDERER,rendererDependencies:{sharp:sharp.versions.sharp,vips:sharp.versions.vips,pango:sharp.versions.pango,rsvg:sharp.versions.rsvg},layers,preview:{path:"Preview.png",sha256:hashBytes(preview),byteLength:preview.length},overview:{path:"Overview.png",sha256:hashBytes(overview),byteLength:overview.length},
    limitations:["Local Pango glyph metrics, ink origin and line breaking can differ from the platform Java2D renderer. Platform visual comparison and receipt remain required.","Fractional image placement uses librsvg sampling; text wrap width is rounded to the nearest pixel. Hidden layers are retained but excluded from the preview."],visualReview:"not_verified",platformValidation:"not_verified",receipt:null};
}
