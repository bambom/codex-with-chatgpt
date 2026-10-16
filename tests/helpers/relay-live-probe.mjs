import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Workspace} from '../../dist/workspace/manager.js';
import {pairPlatform,platformRelayRequest} from '../../dist/ui-design/platform.js';
import {runRelay,relayPair,configureRelayClient} from '../../dist/ui-design/relay.js';
import {UNIFIED_CHAT_TOOLS,WEB_CHAT_TOOLS} from '../../dist/ui-design/web-chat.js';
import {appendExecutionRecord} from '../../dist/execution/records.js';
import {saveExecutionOutput} from '../../dist/execution/output.js';
import sharp from 'sharp';
const fixture=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
process.env.C2C_STATE_DIR=path.join(fixture.runDirectory,'state');
const work=path.join(fixture.runDirectory,'workspace');await fs.mkdir(work);
const workspace=new Workspace(work);let abort=new AbortController(),worker,client;
async function request(route,body,form=false){
  const response=await fetch(fixture.server+'/ui-design/relay-oauth/'+route,{method:'POST',redirect:'manual',
    headers:{'Content-Type':form?'application/x-www-form-urlencoded':'application/json'},body:form?new URLSearchParams(body):JSON.stringify(body)});
  if(response.status===303)return new URL(response.headers.get('location'));
  if(!response.ok)throw Error('OAuth '+route+' HTTP '+response.status);return response.json();
}
async function ready(){for(let i=0;i<50;i++){try{return await platformRelayRequest(workspace,'/status');}catch{await new Promise(r=>setTimeout(r,150));}}throw Error('Worker registration timed out');}
try {
  const paired=await pairPlatform(workspace,fixture.server,fixture.pairingCode);
  worker=runRelay(workspace,{signal:abort.signal});worker.catch(()=>{});await ready();
  const pairing=await relayPair(workspace),endpoint=new URL(pairing.mcpUrl).pathname;
  const callback='https://chatgpt.com/connector_platform/oauth_redirect';
  const registered=await request('register',{client_name:'Live SDK probe',redirect_uris:[callback]});
  const verifier='v'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
  const authorized=await request('authorize',{response_type:'code',client_id:registered.client_id,redirect_uri:callback,
    resource:pairing.mcpUrl,scope:'workspace.tools workspace.read workspace.search git.read execution.read workspace.write workspace.execute offline_access',code_challenge:challenge,code_challenge_method:'S256',state:'live',pairing_code:pairing.pairingCode},true);
  const token=await request('token',{grant_type:'authorization_code',client_id:registered.client_id,redirect_uri:callback,
    resource:pairing.mcpUrl,code:authorized.searchParams.get('code'),code_verifier:verifier},true);
  client=new Client({name:'real-http-sdk-probe',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(fixture.server+endpoint),{requestInit:{headers:{Authorization:'Bearer '+token.access_token}}}));
  const catalog=await client.listTools();
  if(catalog.tools.length!==15||JSON.stringify(catalog.tools.map(t=>t.name).sort())!==JSON.stringify([...UNIFIED_CHAT_TOOLS].sort())
      ||!catalog.tools.filter(t=>WEB_CHAT_TOOLS.includes(t.name)).every(t=>t._meta?.['openai/fileParams']?.[0]==='result_file'))throw Error('Unified web Chat catalog missing');
  async function call(name,args={}) {
    const result=await client.callTool({name,arguments:args});
    if(result.isError)throw Error('Tool failed: '+name+' '+JSON.stringify(result.content));return result;
  }
  function data(result){return result.structuredContent??JSON.parse(result.content.find(c=>c.type==='text').text);}
  await fs.writeFile(path.join(work,'source.txt'),'isolated relay input');
  await sharp({create:{width:1,height:1,channels:4,background:'blue'}}).png().toFile(path.join(work,'pixel.png'));
  const output=saveExecutionOutput(workspace.id,{command:'npm test',raw:'1 test passed',exitCode:0,taskId:'isolated-relay',iteration:1});
  appendExecutionRecord(workspace.id,{taskId:'isolated-relay',iteration:1,changedFiles:[],tests:'1 passed',exitStatus:'ok',timestamp:new Date().toISOString(),outputId:output.id,outputAvailable:true});
  const info=data(await call('workspace_info'));if(info.workspaceId!==workspace.id)throw Error('Wrong workspace');
  await call('list_directory',{path:'.',depth:1});await call('search_workspace',{query:'isolated relay input'});
  const image=await call('read_image',{path:'pixel.png'});if(!image.content.some(c=>c.type==='image'))throw Error('Image content missing');
  await call('git_status');await call('git_diff');await call('test_status');await call('execution_summary');
  await call('execution_output',{action:'list'});if(!data(await call('execution_output',{action:'read',id:output.id})).text.includes('1 test passed'))throw Error('Recorded output missing');
  await call('write_file',{path:'probe.txt',content:'before'});
  await call('apply_patch',{path:'probe.txt',edits:[{old_text:'before',new_text:'after'}]});
  if(data(await call('read_file',{path:'probe.txt'})).content!=='after')throw Error('File write/patch/read cycle failed');
  const command=data(await call('run_command',{command:'echo unified-relay-command-ok'}));
  if(command.exitCode!==0||!command.output.includes('unified-relay-command-ok'))throw Error('Command execution failed');
  const context=await client.callTool({name:'ui_design_split_image',arguments:{stage:'spec',design_id:fixture.designId}});
  if(context.isError||!JSON.stringify(context).includes(fixture.designId))throw Error('Platform design did not round trip');
  if(!JSON.stringify(context).includes(workspace.id)||!JSON.stringify(context).includes('CHATGPT_WEB_ONLY'))throw Error('Bounded business spec did not round trip');
  const before=await platformRelayRequest(workspace,'/status');abort.abort();await worker;
  const offlineCatalog=await client.listTools();if(offlineCatalog.tools.length!==catalog.tools.length)throw Error('Offline catalog changed');
  abort=new AbortController();worker=runRelay(new Workspace(work),{signal:abort.signal});worker.catch(()=>{});
  const after=await ready();
  if(before.connectionId!==after.connectionId||before.mcpUrl!==after.mcpUrl)throw Error('Restart changed binding');
  const readAgain=await client.callTool({name:'ui_design_modify_design',arguments:{stage:'spec',design_id:fixture.designId}});if(readAgain.isError)throw Error('Restart did not recover');
  const profile=path.join(fixture.runDirectory,'client-profile');await fs.mkdir(profile);
  const configured=await configureRelayClient(workspace,profile);const config=JSON.parse(await fs.readFile(configured.configFile,'utf8'));
  if(config.stateDirectory!==process.env.C2C_STATE_DIR||config.workspace!==work||config.server!==fixture.server+'/ui-design')throw Error('Client binding mismatch');
  const result={liveHttpMcp:true,oauthPkce:true,platformDesign:true,boundedBusinessSpec:true,offlineCatalog:true,restartedWorker:true,
    stableBinding:true,clientConfiguration:true,allBaseToolsVerified:true,baseToolCount:13,tools:catalog.tools.length,connectionId:paired.connectionId,existingUserDataUsed:false};
  await fs.writeFile(path.join(fixture.runDirectory,'result.json'),JSON.stringify(result,null,2));
} catch(error){process.stderr.write(JSON.stringify({error:error?.code??'PROBE_FAILED',message:error?.message??'Probe failed'})+'\n');process.exitCode=1;}
finally{abort.abort();if(worker)await worker.catch(()=>{});if(client)await client.close();}
