import fs from 'node:fs/promises';
import { Workspace } from '../../dist/workspace/manager.js';
import { uploadIntakeBundle } from '../../dist/ui-design/intake.js';
const input=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
process.env.C2C_STATE_DIR=input.state;
try {
  const uploaded=await uploadIntakeBundle(new Workspace(input.work),input.args);
  await fs.writeFile(input.output,JSON.stringify(uploaded));
}catch(error){process.stderr.write(JSON.stringify({error:error?.code??'PROBE_FAILED'})+'\n');process.exitCode=1;}
