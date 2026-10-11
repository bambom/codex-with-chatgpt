import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { pairPlatform, platformIntakeRequest, disconnectPlatform } from "../src/ui-design/platform.js";

it("preserves bounded actionable diagnostics and refuses unrelated or malformed error identities",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"ui-errors-")),prior=process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR=path.join(root,"state");
  const design="D1234567890",sub="S"+"b".repeat(32),uuid="f4816e67-ad1d-4a21-8417-89c126fc1f53";
  const error={format:"ui-design-error-1",code:"INVALID_ASSET_MANIFEST",severity:"ERROR",httpStatus:400,retryAction:"REPAIR_REQUEST",
    issues:[{code:"MANIFEST_IDENTITY",path:"/manifest/documentHash",rule:"Manifest context mismatch"}],query:{designId:design,submissionId:sub,statusPath:"/ui-design/api/v1/designs/"+design+"/submissions/"+sub}};
  let mode="good";
  const server=http.createServer(async(req,res)=>{
    for await(const _ of req){}res.setHeader("Content-Type","application/json");
    if(req.url?.endsWith("/exchange")){res.end(JSON.stringify({connectionId:uuid,accessToken:"uid_"+"a".repeat(43),tokenType:"Bearer",expiresAt:new Date(Date.now()+3600000).toISOString(),designIds:[design],scopes:["design.read","design.submit"]}));return;}
    if(req.url?.endsWith("/current")){res.statusCode=204;res.end();return;}
    res.statusCode=400;
    res.end(JSON.stringify(mode==="good"?error:mode==="wrong-status"?{...error,httpStatus:409}:mode==="large"?{...error,issues:[{...error.issues[0],rule:"x".repeat(300000)}]}:
      {...error,query:{designId:"D0000000000",submissionId:sub,statusPath:"/ui-design/api/v1/designs/D0000000000/submissions/"+sub}}));
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try {
    const workspace=new Workspace(root);await pairPlatform(workspace,"http://127.0.0.1:"+(server.address() as {port:number}).port,"p".repeat(43));
    const call=()=>platformIntakeRequest(workspace,design,"/submissions/"+sub+"/candidate","PUT",{});
    await expect(call()).rejects.toMatchObject({code:error.code,details:error});
    for(mode of ["wrong-status","wrong-design","large"])await expect(call()).rejects.toMatchObject({code:"PLATFORM_HTTP_400"});
    await disconnectPlatform(workspace);
  }finally{server.close();await once(server,"close");if(prior===undefined)delete process.env.C2C_STATE_DIR;else process.env.C2C_STATE_DIR=prior;await fs.rm(root,{recursive:true,force:true});}
},60000);
