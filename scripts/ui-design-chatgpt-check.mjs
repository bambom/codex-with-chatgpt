#!/usr/bin/env node
// Read-only readiness check for the desktop binding. Never prints a credential
// or treats local authorization as proof that ChatGPT called the plugin.
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {Workspace} from '../dist/workspace/manager.js';
import {platformStatus,platformContext,normalizePlatformServer} from '../dist/ui-design/platform.js';
import {relayStatus} from '../dist/ui-design/relay.js';
import {createWebChatMcpServer,UNIFIED_CHAT_TOOLS} from '../dist/ui-design/web-chat.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

let server,client;
try {
  const {values}=parseArgs({options:{profile:{type:'string'}},strict:true});
  if(!values.profile)throw Object.assign(Error(),{code:'DESKTOP_PROFILE_REQUIRED'});
  const profile=await fs.realpath(values.profile);
  const bytes=await fs.readFile(path.join(profile,'userData','ui-design-relay.json'));
  if(bytes.length>32768)throw Object.assign(Error(),{code:'DESKTOP_BINDING_INVALID'});
  const binding=JSON.parse(bytes.toString('utf8'));
  if(binding.version!==1||typeof binding.workspace!=='string'||!path.isAbsolute(binding.workspace)||
     typeof binding.stateDirectory!=='string'||!path.isAbsolute(binding.stateDirectory))
    throw Object.assign(Error(),{code:'DESKTOP_BINDING_INVALID'});
  const platform=normalizePlatformServer(binding.server);
  process.env.C2C_STATE_DIR=binding.stateDirectory;
  const workspace=new Workspace(binding.workspace),connection=await platformStatus(workspace);
  if(!connection.connected||!('server' in connection)||connection.server!==platform)
    throw Object.assign(Error(),{code:'PLATFORM_BINDING_NOT_READY'});
  if(connection.designIds.length!==1)throw Object.assign(Error(),{code:'CURRENT_DESIGN_GRANT_REQUIRED'});
  const context=await platformContext(workspace,connection.designIds[0]);
  const relay=await relayStatus(workspace);
  server=createWebChatMcpServer(workspace);
  client=new Client({name:'ui-design-readiness',version:'1.0.0'});
  const [local,remote]=InMemoryTransport.createLinkedPair();await server.connect(remote);await client.connect(local);
  const catalog=(await client.listTools()).tools;
  const required=UNIFIED_CHAT_TOOLS;
  const missing=required.filter(name=>!catalog.some(tool=>tool.name===name));
  const probe=await client.callTool({name:'ui_design_split_image',arguments:{stage:'spec',section:'summary'}});
  const probeText=probe.content?.find(item=>item.type==='text')?.text;
  const observed=probeText?JSON.parse(probeText):null;
  if(probe.isError||observed?.workspaceId!==workspace.id||observed?.context?.designId!==context.designId
      ||observed?.context?.nativeSha256!==context.nativeSha256)
    throw Object.assign(Error(),{code:'LOCAL_BUSINESS_TOOL_IDENTITY_MISMATCH'});
  const endpoint=new URL(relay.server.mcpUrl);
  const publicHttps=endpoint.protocol==='https:'&&!['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname);
  console.log(JSON.stringify({ok:missing.length===0,profile,workspace:binding.workspace,workspaceId:workspace.id,
    stateDirectory:binding.stateDirectory,platform,design:context,scopes:connection.scopes,
    workerOnline:relay.server.online===true,clientAutoStart:binding.enabled===true,
    mcpUrl:endpoint.href,publicHttps,localToolCount:catalog.length,requiredTools:required,missingTools:missing,
    localBusinessReadVerified:true,
    chatgptVerified:false,nextStep:missing.length?'repair-local-tools':!relay.server.online?'restore-worker':
      publicHttps?'verify-public-endpoint-and-connect-browser':'configure-stable-private-or-public-connection'}));
  if(missing.length)process.exitCode=1;
}catch(error){
  console.log(JSON.stringify({ok:false,error:/^[A-Z][A-Z0-9_]+$/.test(error.code??'')?error.code:'CONNECTION_CHECK_FAILED',chatgptVerified:false}));
  process.exitCode=1;
}finally{await client?.close();await server?.close();}
