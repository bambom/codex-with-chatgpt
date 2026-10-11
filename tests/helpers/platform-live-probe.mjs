import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Workspace } from '../../dist/workspace/manager.js';
import { pairPlatform, platformStatus, platformSpecification, platformContext, platformCheckpoint, platformValidate, disconnectPlatform } from '../../dist/ui-design/platform.js';
const fixture=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
process.env.C2C_STATE_DIR=path.join(fixture.runDirectory,'state');
const work=path.join(fixture.runDirectory,'workspace');await fs.mkdir(work);
const workspace=new Workspace(work);
try {
  const pair=await pairPlatform(workspace,fixture.server,fixture.pairingCode);
  if(!pair.connected||'accessToken' in pair||'secret' in pair)throw Error('Unsafe public connection metadata');
  const summary=await platformSpecification(workspace);
  const example=await platformSpecification(workspace,'example');
  const context=await platformContext(workspace,fixture.designId);
  const checkpoint=await platformCheckpoint(workspace,fixture.designId,context.nativeSequence,context.nativeSha256);
  const validation=await platformValidate(workspace,fixture.designId,checkpoint.checkpointId,JSON.stringify(example.data));
  const stored=JSON.parse(await fs.readFile(path.join(process.env.C2C_STATE_DIR,'ui-workflow',workspace.id,'platform-connection.json'),'utf8'));
  const protectedCredential=process.platform==='win32'?stored.secret.format==='windows-dpapi'&&!stored.secret.value.startsWith('uid_')
    :((await fs.stat(path.join(process.env.C2C_STATE_DIR,'ui-workflow',workspace.id,'platform-connection.json'))).mode&0o077)===0;
  const disconnected=await disconnectPlatform(workspace);
  const status=await platformStatus(workspace);
  const result={liveSpecification:summary.liveServer===true,checkpoint:checkpoint.nativeSequence===context.nativeSequence,
    standardValidation:validation.status==='STANDARD_VALIDATION_PASS'&&validation.published===false&&validation.submitted===false,
    revoked:disconnected.revoked===true&&status.connected===false,credentialProtected:protectedCredential,
    existingUserDataUsed:false,onlineSubmissionImplemented:false};
  if(!Object.entries(result).filter(([key])=>!['existingUserDataUsed','onlineSubmissionImplemented'].includes(key)).every(([,value])=>value===true))throw Error('Live platform assertion failed');
  await fs.writeFile(path.join(fixture.runDirectory,'result.json'),JSON.stringify(result,null,2));
}catch(error){process.stderr.write(JSON.stringify({error:error?.code??'PROBE_FAILED',message:error?.message??'Probe failed'})+'\n');process.exitCode=1;}
