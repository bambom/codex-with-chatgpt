#!/usr/bin/env node
/** Developer integration fixture. Uses explicit synthetic verification data;
 * this is not an image-analysis or art-generation substitute. Build first.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Workspace } from '../../dist/workspace/manager.js';
import { parseScene, resolveScene, sceneInputFiles } from '../../dist/ui/scene.js';
import { renderScene } from '../../dist/ui/render.js';
import { createJob, importLocalFile, inspectTarget, setScene, buildJob, getJob, deliverJob } from '../../dist/ui/workflow.js';
import { addDestination } from '../../dist/ui/destinations.js';
import { runNativeValidation } from '../../dist/ui/native.js';

const { values } = parseArgs({ options: {
  workspace: { type: 'string' }, target: { type: 'string' },
  output: { type: 'string' }, 'native-adapter': { type: 'string' },
  report: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  process.stdout.write('node examples/ui-production/verify-local.mjs --workspace <actual project root> --target <workspace-relative .fairy> --report <new result.json> [--output <chosen absolute directory>] [--native-adapter <locally registered ID>]\n');
  process.exit(0);
}
if (!values.workspace || !values.target || !values.report) throw Error('Required: --workspace, --target and --report');
const workspace = new Workspace(path.resolve(values.workspace));
const repository = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRoot = path.join(repository, 'tests', 'fixtures', 'ui');
const scene = parseScene(JSON.parse(await fs.readFile(path.join(fixtureRoot, 'inventory-all-controls.scene.json'), 'utf8')));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'c2c-ui-native-fixture-'));
const reportFile = path.resolve(values.report);
await fs.mkdir(path.dirname(reportFile), { recursive: true });
const guard = await fs.open(reportFile, 'wx', 0o600);
await guard.close();
const report = { schemaVersion: 1, purpose: 'Synthetic integration fixture; no production design or game services',
  startedAt: new Date().toISOString(), workspaceId: workspace.id, target: values.target, phases: [] };
let job;
async function phase(name) {
  report.phases.push({ name, at: new Date().toISOString() });
  if (job) report.job = { id: job.id, revision: job.revision, status: job.status, checks: job.checks };
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ phase: name, jobId: job?.id }) + '\n');
}
try {
  job = await createJob(workspace, { name: 'UI Workflow Native Verification', targetProject: values.target });
  await phase('inspect-actual-target');
  const research = await inspectTarget(workspace, job.id);
  job = research.job;
  report.targetProfile = { id: research.profile.id, status: research.profile.status, project: research.profile.project,
    limits: research.profile.limits, evidenceCount: research.profile.evidence.length, rendering: research.profile.rendering };
  if (research.profile.status !== 'ready') throw Error('Select an explicitly supported actual .fairy target before this fixture can run.');
  await phase('render-synthetic-reference');
  const rendered = await renderScene(scene, resolveScene(scene, research.profile.rendering), path.join(fixtureRoot, 'inputs'), path.join(temporary, 'reference'));
  job = await importLocalFile(workspace, job.id, { sourcePath: rendered.composite, path: 'design/master.png', role: 'design' });
  for (const file of sceneInputFiles(scene)) {
    const role = /\.(?:otf|ttf)$/i.test(file) ? 'font' : /\.png$/i.test(file) ? 'asset' : 'license';
    job = await importLocalFile(workspace, job.id, { sourcePath: path.join(fixtureRoot, 'inputs', file), path: file, role });
  }
  job = (await setScene(workspace, job.id, { scene, expectedRevision: job.revision })).job;
  await phase('build-psd-png-fgui');
  job = await buildJob(workspace, job.id, { expectedRevision: job.revision });
  if (values['native-adapter']) {
    await phase('native-open-save-reopen-render-interaction');
    const native = await runNativeValidation(workspace, job.id, { adapterId: values['native-adapter'] });
    job = native.job;
    report.native = native.report;
  }
  let destinationId = 'workspace';
  if (values.output) {
    if (!path.isAbsolute(values.output)) throw Error('--output must be an absolute directory selected locally.');
    destinationId = `fixture-${job.id.slice(-12)}`;
    await addDestination(workspace, { id: destinationId, path: values.output });
  }
  await phase('deliver-verified-artifacts');
  report.delivery = await deliverJob(workspace, job.id, { destinationId });
  job = await getJob(workspace, job.id);
  report.finishedAt = new Date().toISOString();
  report.status = values['native-adapter'] && (job.checks.editorImport !== 'passed' || job.checks.runtimeInteraction !== 'passed') ? 'native_not_fully_verified' : 'completed';
  await phase('finished');
  if (report.status !== 'completed') process.exitCode = 2;
} catch (error) {
  if (job) job = await getJob(workspace, job.id);
  report.status = 'failed';
  report.error = { code: error?.code ?? 'INTEGRATION_FAILED', message: String(error?.message ?? error) };
  report.finishedAt = new Date().toISOString();
  await phase('failed');
  process.exitCode = 1;
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
