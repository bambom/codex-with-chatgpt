#!/usr/bin/env node
/** Trusted local adapter for MagicGameClient's real source-workbench APIs.
 * Register this executable/argument list locally. The final argument is the
 * runner-created request.json. It never accepts a caller-supplied PASS.
 * See ../../docs/native-magicgamestudio.md for setup, pinning and exact scope.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openSource, saveSource, reopenSource, encodeSource, renderSource, exerciseControls } from './magicgamestudio-browser.mjs';

const CONTRACT = 'magicgamestudio-source-api-v1';
const MAX_TRANSFER_BYTES = 128 * 1024 * 1024;
const EXPECTED_TYPES = ['Button', 'InputText', 'Slider', 'ProgressBar', 'List', 'ComboBox', 'ScrollBar'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = value => value.split(path.sep).join('/');
const pluginRequire = createRequire(new URL('../../package.json', import.meta.url));
const usage = `MagicGameStudio native source validator\n\nPin inspected local source (no browser or game/editor process starts):\n  node magicgamestudio.mjs --client <MagicGameClient> --runtime-lock <runtime-lock.json> --write-fingerprint <trusted-pin.json>\n\nFixed trusted runner arguments, followed by its request.json:\n  node magicgamestudio.mjs --client <MagicGameClient> --runtime-lock <runtime-lock.json> --fingerprint <trusted-pin.json> --browser <Chrome executable> [--timeout-ms 180000] [--no-list-fixtures] <request.json>\n\nNever register --write-fingerprint as the remote adapter. Do not repin changed target source without reviewing it.\n`;

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') result.help = true;
    else if (key === '--no-list-fixtures') result.listFixtures = false;
    else if (['--client', '--runtime-lock', '--fingerprint', '--write-fingerprint', '--browser', '--timeout-ms'].includes(key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('MISSING_OPTION_VALUE:' + key);
      result[key.slice(2)] = argv[++i];
    } else if (!key.startsWith('-') && i === argv.length - 1) result.requestFile = key;
    else throw Error('UNKNOWN_ARGUMENT:' + key);
  }
  return result;
}
function boundedRead(file, limit = MAX_TRANSFER_BYTES) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > limit) throw Error('FILE_NOT_REGULAR_OR_TOO_LARGE:' + file);
  const bytes = fs.readFileSync(file); if (bytes.length !== stat.size) throw Error('FILE_CHANGED_DURING_READ:' + file); return bytes;
}
function json(file, limit = 4 * 1024 * 1024) { return JSON.parse(boundedRead(file, limit).toString('utf8')); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomBytes(6).toString('hex') + '.tmp';
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.normalize('NFC') !== value || /[\\\u0000-\u001f:?*<>|"#]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw Error('UNSAFE_RELATIVE_PATH:' + String(value));
  return value;
}
function inside(base, relative) {
  safeRelative(relative); const destination = path.resolve(base, relative);
  if (!destination.startsWith(base + path.sep)) throw Error('PATH_ESCAPE:' + relative);
  return destination;
}
function walk(root, prefix = '') {
  const rows = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name; safeRelative(relative);
    if (entry.isSymbolicLink()) throw Error('SOURCE_SYMLINK_NOT_SUPPORTED:' + relative);
    if (entry.isDirectory()) rows.push(...walk(root, relative));
    else if (entry.isFile()) rows.push(relative);
    else throw Error('SOURCE_SPECIAL_FILE_NOT_SUPPORTED:' + relative);
    if (rows.length > 4096) throw Error('ADAPTER_FILE_BUDGET_EXCEEDED');
  }
  return rows;
}
function inventory(root) {
  let total = 0;
  return walk(root).map(relative => { const bytes = boundedRead(inside(root, relative)); total += bytes.length;
    if (total > MAX_TRANSFER_BYTES) throw Error('ADAPTER_SOURCE_TRANSFER_BUDGET_EXCEEDED');
    return { path: relative, bytes: bytes.length, sha256: sha(bytes) }; });
}
function offeredFiles(root, rows) { return rows.map(row => ({ path: row.path, base64: boundedRead(inside(root, row.path)).toString('base64') })); }
function sameInventory(a, b) { return a.length === b.length && a.every(row => b.some(other => other.path === row.path && other.bytes === row.bytes && other.sha256 === row.sha256)); }

const SOURCE_EXPORTS = `
export {readSourceProjectCatalog,sourceProjectHash} from './src/app/game-ui/fgui/domain/source-project-loader';
export {importSourceComponent} from './src/app/game-ui/fgui/domain/source-project-importer';
export {exportSourceComponent} from './src/app/game-ui/fgui/domain/source-project-export';
export {sourceComponentDocumentId} from './src/app/game-ui/fgui/domain/source-component-identity';
export {sourceRuntimeSceneAssets} from './src/app/game-ui/fgui/domain/source-runtime-scene';
export {encodeSavedPackage} from './src/app/game-ui/publishing/laya/encode-package';
export {DocumentGraph} from './src/app/game-ui/domain/document-graph';
export {SOURCE_PROJECT_LIMITS} from './src/app/game-ui/contracts/source-project';
export {installFixedLayaRuntime,loadFixedSourceFonts,FIXED_LAYA_RUNTIME_VERSION} from './src/app/game-ui/runtime/laya/fixed-runtime-support';
`;

async function prepareEnvironment(options) {
  if (!options.client || !options['runtime-lock']) throw Error('LOCAL_CONFIGURATION_REQUIRED: --client and --runtime-lock');
  const client = fs.realpathSync(path.resolve(options.client)), workspace = fs.realpathSync(path.dirname(client));
  const lockFile = fs.realpathSync(path.resolve(options['runtime-lock'])), lockBytes = boundedRead(lockFile, 4 * 1024 * 1024), lock = JSON.parse(lockBytes.toString('utf8'));
  const require = createRequire(path.join(client, 'tools/game-ui/package.json'));
  const esbuild = require('esbuild'), { chromium } = require('playwright-core');
  if (!Array.isArray(lock.artifacts) || typeof lock.profileId !== 'string' || !lock.sourcePins?.laya || !lock.sourcePins?.fgui) throw Error('UNRECOGNIZED_RUNTIME_LOCK');
  const vendors = [], vendorRoutes = new Map();
  for (const name of ['laya', 'rawinflate', 'fairygui']) {
    const candidates = lock.artifacts.filter(row => typeof row.path === 'string' && row.path.endsWith('/vendor/' + name + '.js'));
    if (candidates.length !== 1) throw Error('RUNTIME_VENDOR_NOT_UNIQUE:' + name);
    const pin = candidates[0], file = inside(workspace, pin.path), bytes = boundedRead(file);
    if (sha(bytes) !== pin.sha256) throw Error('RUNTIME_VENDOR_HASH_MISMATCH:' + pin.path);
    vendors.push({ path: pin.path, bytes: bytes.length, sha256: sha(bytes) }); vendorRoutes.set('vendor/' + name + '.js', bytes);
  }
  const built = await esbuild.build({ absWorkingDir: client, stdin: { contents: SOURCE_EXPORTS, resolveDir: client, sourcefile: 'c2c-native-adapter-entry.ts', loader: 'ts' },
    bundle: true, platform: 'browser', format: 'iife', globalName: 'NativeFGUI', write: false, metafile: true, target: 'es2022', logLevel: 'silent' });
  const sourceInputs = Object.keys(built.metafile.inputs).filter(file => file !== 'c2c-native-adapter-entry.ts' && !file.startsWith('<')).map(file => {
    const absolute = path.resolve(client, file), relative = slash(path.relative(workspace, absolute)); safeRelative(relative);
    const bytes = boundedRead(absolute); return { path: relative, bytes: bytes.length, sha256: sha(bytes) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const api = Buffer.from(built.outputFiles[0].contents);
  const adapterSources = ['magicgamestudio.mjs', 'magicgamestudio-browser.mjs'].map(name => ({ name, sha256: sha(boundedRead(fileURLToPath(new URL(name, import.meta.url)))) }));
  const fingerprint = { schemaVersion: 1, contract: CONTRACT, adapterSources, esbuildVersion: esbuild.version, sourceApiBundleSha256: sha(api), sourceInputs,
    runtimeLockSha256: sha(lockBytes), runtimeProfileId: lock.profileId, runtimePins: lock.sourcePins, vendors };
  return { client, workspace, lockFile, lock, api, chromium, vendorRoutes, fingerprint };
}

function verifySourceZip(sourceDirectory, zipFile, expectedHash) {
  const bytes = boundedRead(zipFile);
  if (sha(bytes) !== expectedHash) throw Error('DELIVERY_ZIP_HASH_MISMATCH');
  const { unzipSync } = pluginRequire('fflate'); let originalBytes = 0; const names = new Set();
  const unzipped = unzipSync(bytes, { filter: file => {
    const name = file.name.replace(/\/$/, ''); safeRelative(name);
    const key = name.toLowerCase(); if (names.has(key)) throw Error('ZIP_DUPLICATE_PATH:' + name); names.add(key);
    originalBytes += file.originalSize;
    if (originalBytes > MAX_TRANSFER_BYTES || names.size > 4096) throw Error('ZIP_INFLATION_BUDGET_EXCEEDED');
    return !file.name.endsWith('/');
  } });
  const zippedRows = Object.entries(unzipped).map(([relative, content]) => ({ path: relative, bytes: content.length, sha256: sha(content) }));
  const directoryRows = inventory(sourceDirectory);
  if (!sameInventory(directoryRows, zippedRows)) throw Error('SOURCE_WORK_COPY_DIFFERS_FROM_DELIVERED_ZIP');
  return directoryRows;
}

function validateRequest(request, requestFile) {
  if (request.schemaVersion !== 1 || typeof request.jobId !== 'string' || !request.jobId || !/^[a-f0-9]{64}$/.test(request.buildInputHash) || !/^[a-f0-9]{64}$/.test(request.sourceZipSha256)) throw Error('INVALID_NATIVE_REQUEST_IDENTITY');
  for (const field of ['workspaceRoot', 'sourceDirectory', 'sourceZip', 'sceneFile', 'outputDirectory', 'reportFile']) if (typeof request[field] !== 'string' || !path.isAbsolute(request[field])) throw Error('NATIVE_REQUEST_REQUIRES_ABSOLUTE_PATH:' + field);
  for (const field of ['workspaceRoot', 'sourceDirectory']) request[field] = fs.realpathSync(request[field]);
  for (const field of ['sourceZip', 'sceneFile']) request[field] = fs.realpathSync(request[field]);
  fs.mkdirSync(request.outputDirectory, { recursive: true }); request.outputDirectory = fs.realpathSync(request.outputDirectory);
  const reportParent = fs.realpathSync(path.dirname(request.reportFile));
  if (reportParent !== request.outputDirectory && !reportParent.startsWith(request.outputDirectory + path.sep)) throw Error('REPORT_OUTSIDE_OUTPUT_DIRECTORY');
  request.reportFile = path.join(reportParent, path.basename(request.reportFile));
  if (path.resolve(request.reportFile) === path.resolve(requestFile)) throw Error('REPORT_MUST_NOT_OVERWRITE_REQUEST');
}

async function run(options) {
  if (!options.requestFile) throw Error('REQUEST_JSON_REQUIRED');
  const requestFile = path.resolve(options.requestFile), request = json(requestFile, 256 * 1024); validateRequest(request, requestFile);
  const work = fs.mkdtempSync(path.join(request.outputDirectory, 'magicgamestudio-'));
  const evidencePath = name => slash(path.relative(request.outputDirectory, path.join(work, name)));
  const report = { schemaVersion: 1, jobId: request.jobId, buildInputHash: request.buildInputHash, sourceZipSha256: request.sourceZipSha256,
    editorImport: { status: 'not_verified', checks: ['open', 'save', 'reopen', 'render'].map(name => ({ name, status: 'not_verified' })),
      note: 'MagicGameClient source-workbench importer/save/reopen and pinned Laya/FairyGUI rendering. This is not official FairyGUI Editor desktop automation.' },
    runtimeInteraction: { status: 'not_verified', checks: [] }, evidence: [], limitations: [
      'Game services and business callbacks are not implemented or invoked by this adapter.',
      'Only enabled, initially reachable native controls are exercised. Hidden states and platform-specific desktop editor behavior remain unverified.',
    ] };
  const details = { contract: CONTRACT, startedUtc: new Date().toISOString(), sourceZipSha256: request.sourceZipSha256,
    phases: [], sourceHashes: [], pageErrors: [], consoleErrors: [], failures: [], networkBlocks: [] };
  // The runner deliberately accepts only its small strict Check schema. Keep
  // raw native results in evidence, without quietly dropping their diagnostics.
  const compactCheck = row => ({
    name: row.name.length <= 160 ? row.name : row.name.slice(0, 145) + ':' + sha(Buffer.from(row.name)).slice(0, 12),
    ...(row.type ? { type: row.type } : {}), status: row.status,
    ...(row.note ? { note: String(row.note).slice(0, 4000) } : row.error ? { note: String(row.error).slice(0, 4000) } : {}),
  });
  const save = () => {
    writeJson(path.join(work, 'adapter-details.json'), { ...details, editorImport: report.editorImport, runtimeInteraction: report.runtimeInteraction });
    writeJson(request.reportFile, { ...report,
      editorImport: { ...report.editorImport, checks: report.editorImport.checks.map(compactCheck) },
      runtimeInteraction: { ...report.runtimeInteraction, checks: report.runtimeInteraction.checks.map(compactCheck) },
    });
  };
  let stage = 'environment', started = Date.now(), timer, heartbeat, browser, server, environment, sourceRows, input, savedInput, encodedRows;
  const phase = name => { const event = { phase: name, utc: new Date().toISOString(), elapsedMs: Date.now() - started }; details.phases.push(event); save(); process.stdout.write(JSON.stringify(event) + '\n'); };
  const check = (name, status, data = {}) => { Object.assign(report.editorImport.checks.find(row => row.name === name), { status, ...data }); save(); };
  const recompute = () => {
    const values = report.editorImport.checks.map(row => row.status);
    report.editorImport.status = values.includes('failed') ? 'failed' : values.every(value => value === 'passed') ? 'passed' : 'not_verified';
    const interactions = report.runtimeInteraction.checks;
    report.runtimeInteraction.status = interactions.some(row => row.status === 'failed') ? 'failed' : interactions.length && interactions.every(row => row.status === 'passed') ? 'passed' : 'not_verified';
  };
  try {
    phase('verify-delivery-identity');
    sourceRows = verifySourceZip(request.sourceDirectory, request.sourceZip, request.sourceZipSha256);
    writeJson(path.join(work, 'source-inventory.json'), { sourceZipSha256: request.sourceZipSha256, files: sourceRows });
    const value = json(request.sceneFile), scene = value.scene ?? value;
    if (scene.schemaVersion !== 1 || typeof scene.entry !== 'string' || !Array.isArray(scene.components) || !scene.components.some(component => component.id === scene.entry)) throw Error('UNSUPPORTED_SCENE_ENTRY_CONTRACT');
    const canvas = scene.canvas;
    if (!canvas || ![canvas.width, canvas.height].every(number => Number.isInteger(number) && number > 0 && number <= 16384) || canvas.width * canvas.height > 32 * 1024 * 1024) throw Error('UNSUPPORTED_NATIVE_CANVAS');
    const types = request.expectedInteractions ?? [...new Set(scene.components.flatMap(component => [component.semantic, ...component.children.map(node => node.type)]).filter(type => EXPECTED_TYPES.includes(type)))];
    if (!Array.isArray(types) || types.some(type => !EXPECTED_TYPES.includes(type))) throw Error('UNSUPPORTED_EXPECTED_INTERACTION_TYPE');
    details.expectedInteractions = [...new Set(types)];
    const projects = sourceRows.filter(row => row.path.endsWith('.fairy'));
    if (projects.length !== 1 || projects[0].path.includes('/')) throw Error('NATIVE_PROJECT_ROOT_REQUIRES_ONE_FAIRY_FILE');
    // Deterministic UI-production v1 IDs, verified against the real source catalog.
    // No component is selected by an example/demo name or "first exported" guess.
    const entryResourceId = 'c' + sha(Buffer.from('component/' + scene.entry)).slice(0, 12);
    details.entrySelection = { semanticId: scene.entry, entryResourceId, basis: 'UI production schema v1 deterministic component resource ID; must match exactly one imported resource' };
    phase('verify-target-source-fingerprint');
    environment = await prepareEnvironment(options);
    if (environment.workspace !== request.workspaceRoot) throw Error('CONFIGURED_CLIENT_BELONGS_TO_ANOTHER_WORKSPACE');
    if (!options.fingerprint) throw Error('TRUSTED_SOURCE_FINGERPRINT_REQUIRED');
    const trusted = json(path.resolve(options.fingerprint), 8 * 1024 * 1024);
    if (JSON.stringify(trusted) !== JSON.stringify(environment.fingerprint)) throw Error('TARGET_FINGERPRINT_CHANGED: review and explicitly repin the actual source/runtime before using this adapter');
    details.targetFingerprint = environment.fingerprint; details.nativeBundleSha256 = sha(environment.api);
    details.sourceHashes = environment.fingerprint.sourceInputs;
    details.harness = ['magicgamestudio.mjs', 'magicgamestudio-browser.mjs'].map(name => ({ name, sha256: sha(boundedRead(fileURLToPath(new URL(name, import.meta.url)))) }));
    writeJson(path.join(work, 'source-fingerprint.json'), environment.fingerprint);
    fs.writeFileSync(path.join(work, 'native-api.js'), environment.api, { flag: 'wx' });
    const executable = options.browser ? path.resolve(options.browser) : environment.chromium.executablePath();
    if (!fs.existsSync(executable)) throw Error('BROWSER_EXECUTABLE_UNAVAILABLE: configure --browser locally; this adapter does not download browsers');
    const timeoutMs = Number(options['timeout-ms'] ?? 180000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 15000 || timeoutMs > 600000) throw Error('INVALID_LOCAL_TIMEOUT');
    const prefix = '/' + randomBytes(18).toString('hex') + '/', routes = new Map(environment.vendorRoutes), encoded = new Map();
    routes.set('native-api.js', environment.api);
    input = { projectPath: projects[0].path, files: offeredFiles(request.sourceDirectory, sourceRows), directories: [], entryResourceId, canvas };
    const writeFiles = (base, files) => {
      if (!Array.isArray(files) || files.length > 4096) throw Error('INVALID_NATIVE_OUTPUT_FILES');
      fs.mkdirSync(base, { recursive: true }); const names = new Set(), rows = []; let total = 0;
      for (const row of files) {
        const relative = safeRelative(row.path), folded = relative.toLowerCase();
        if (names.has(folded) || typeof row.base64 !== 'string' || row.base64.length > Math.ceil(MAX_TRANSFER_BYTES / 3) * 4) throw Error('INVALID_NATIVE_OUTPUT_FILE');
        names.add(folded); const bytes = Buffer.from(row.base64, 'base64'); total += bytes.length;
        if (bytes.toString('base64') !== row.base64 || total > MAX_TRANSFER_BYTES) throw Error('INVALID_NATIVE_OUTPUT_BYTES');
        const target = inside(base, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: 'wx' });
        rows.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
      }
      return rows;
    };
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (!url.pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
        const route = decodeURIComponent(url.pathname.slice(prefix.length));
        if (req.method === 'POST' && ['saved', 'encoded'].includes(route)) {
          const chunks = []; let length = 0;
          for await (const chunk of req) { length += chunk.length; if (length > Math.ceil(MAX_TRANSFER_BYTES * 1.4)) throw Error('NATIVE_POST_BUDGET_EXCEEDED'); chunks.push(chunk); }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (route === 'saved') {
            if (savedInput) throw Error('DUPLICATE_SOURCE_SAVE');
            const rows = writeFiles(path.join(work, 'saved-source'), body.files);
            savedInput = { projectPath: safeRelative(body.projectPath), directories: Array.isArray(body.directories) ? body.directories.map(safeRelative) : [], rows };
            writeJson(path.join(work, 'roundtrip-inventory.json'), rows);
          } else {
            if (encodedRows) throw Error('DUPLICATE_NATIVE_ENCODING');
            encodedRows = writeFiles(path.join(work, 'encoded'), body);
            for (const row of encodedRows) encoded.set('encoded/' + row.path, boundedRead(inside(path.join(work, 'encoded'), row.path)));
            writeJson(path.join(work, 'encoded-inventory.json'), encodedRows);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"saved":true}'); return;
        }
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
        let body, type = 'application/octet-stream';
        if (!route) { body = Buffer.from('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Native source validation</title><style>html,body{margin:0;padding:0;overflow:hidden;background:white}</style>'); type = 'text/html; charset=utf-8'; }
        else if (route === 'input.json') { body = Buffer.from(JSON.stringify(input)); type = 'application/json'; }
        else if (route === 'saved-input.json' && savedInput) { body = Buffer.from(JSON.stringify({ projectPath: savedInput.projectPath, directories: savedInput.directories, files: offeredFiles(path.join(work, 'saved-source'), inventory(path.join(work, 'saved-source'))) })); type = 'application/json'; }
        else if (routes.has(route)) { body = routes.get(route); type = 'text/javascript'; }
        else if (encoded.has(route)) { body = encoded.get(route); type = route.endsWith('.png') ? 'image/png' : route.endsWith('.ttf') ? 'font/ttf' : route.endsWith('.otf') ? 'font/otf' : type; }
        else if (route === 'favicon.ico') { res.writeHead(204); res.end(); return; }
        else { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body);
      } catch (error) { details.failures.push({ stage: 'loopback-file-service', error: String(error) }); res.writeHead(500); res.end(String(error)); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, baseUrl = origin + prefix; input.baseUrl = baseUrl;
    browser = await environment.chromium.launch({ executablePath: executable, headless: true, args: ['--no-first-run', '--disable-background-networking', '--disable-component-update'] });
    details.browser = { executable, version: browser.version() };
    const context = await browser.newContext({ viewport: canvas, deviceScaleFactor: 1, acceptDownloads: false });
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(baseUrl) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      details.networkBlocks.push(url); return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    page.on('pageerror', error => details.pageErrors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') details.consoleErrors.push(message.text());
      if (message.text().startsWith('NATIVE_ADAPTER_PHASE:')) phase(message.text().slice('NATIVE_ADAPTER_PHASE:'.length)); });
    timer = setTimeout(() => {
      details.failures.push({ stage, error: 'NATIVE_VALIDATION_DEADLINE' });
      if (['open', 'save', 'reopen', 'render'].includes(stage)) check(stage, 'failed', { error: 'NATIVE_VALIDATION_DEADLINE' });
      else if (stage === 'interaction') report.runtimeInteraction.checks.push(...details.expectedInteractions.map(type => ({ name: 'Validation deadline:' + type, type, status: 'failed', note: 'Native interaction deadline expired.' })));
      recompute(); save(); void browser.close().catch(() => undefined);
    }, timeoutMs);
    heartbeat = setInterval(() => process.stdout.write(JSON.stringify({ phase: 'heartbeat', stage, elapsedMs: Date.now() - started }) + '\n'), 15000);
    await page.goto(baseUrl); await page.addScriptTag({ url: baseUrl + 'native-api.js' });
    stage = 'open'; phase(stage); const opened = await page.evaluate(openSource); check('open', opened.status, opened); details.open = opened;
    if (opened.status !== 'passed') throw Error('NATIVE_OPEN_FAILED:' + opened.error);
    details.actualSourceProject = opened.project;
    stage = 'save'; phase(stage); const saved = await page.evaluate(saveSource); check('save', saved.status, { files: saved.files.length, unchangedFilesByteExact: saved.unchangedFilesByteExact }); details.save = saved;
    stage = 'reopen'; phase(stage); const reopened = await page.evaluate(reopenSource); check('reopen', reopened.status, { components: reopened.components?.length, error: reopened.error }); details.reopen = reopened;
    if (reopened.status !== 'passed') throw Error('NATIVE_REOPEN_FAILED:' + reopened.error);
    if (!sameInventory(saved.files, reopened.reopenedFileHashes)) throw Error('SAVED_FILES_NOT_REOPENED_EXACTLY');
    stage = 'render'; phase(stage); details.nativeEncoding = await page.evaluate(encodeSource);
    for (const name of ['laya', 'rawinflate', 'fairygui']) await page.addScriptTag({ url: baseUrl + 'vendor/' + name + '.js' });
    const rendered = await page.evaluate(renderSource); details.nativeRender = { ...rendered, controls: undefined };
    writeJson(path.join(work, 'native-controls.json'), rendered.controls);
    await page.mouse.move(-10, -10); await page.evaluate(() => window.S.restore());
    await page.screenshot({ path: path.join(work, 'native-preview.png'), animations: 'disabled' });
    if (details.pageErrors.length || details.consoleErrors.length) throw Error('NATIVE_RENDER_BROWSER_ERRORS');
    check('render', 'passed', { width: rendered.width, height: rendered.height, nativeControls: rendered.controls.length,
      preview: 'native-preview.png', runtimeVersion: rendered.runtimeVersion, sourcePlatform: opened.project.type });
    if (opened.project.type !== 'Layabox') {
      report.runtimeInteraction.checks = details.expectedInteractions.map(type => ({ name: 'Runtime platform:' + type, type, status: 'not_verified', note: `Source project type is ${opened.project.type}. This adapter runs pinned Laya/FairyGUI and does not establish that platform's native interaction behavior.` }));
      report.limitations.push(`Actual source project type ${opened.project.type}/${opened.project.version} was read from .fairy. The source-workbench rendered it through Laya; its platform runtime was not substituted or claimed.`);
    } else {
      stage = 'interaction'; phase(stage);
      await exerciseControls(page, rendered.controls, details.expectedInteractions, row => { report.runtimeInteraction.checks.push(row); recompute(); save(); }, phase, { listFixtures: options.listFixtures !== false });
      await page.screenshot({ path: path.join(work, 'native-restored.png'), animations: 'disabled' });
      const sharp = pluginRequire('sharp');
      const [initial, restored] = await Promise.all(['native-preview.png', 'native-restored.png'].map(name => sharp(path.join(work, name)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
      let changedPixels = 0, maximumChannelDifference = 0;
      if (initial.info.width === restored.info.width && initial.info.height === restored.info.height) for (let i = 0; i < initial.data.length; i += 4) {
        let changed = false; for (let c = 0; c < 4; c++) { const difference = Math.abs(initial.data[i + c] - restored.data[i + c]); maximumChannelDifference = Math.max(maximumChannelDifference, difference); changed ||= difference !== 0; } if (changed) changedPixels++;
      } else changedPixels = Math.max(initial.info.width * initial.info.height, restored.info.width * restored.info.height);
      details.canvasRestoration = { status: changedPixels === 0 ? 'passed' : 'failed', changedPixels, maximumChannelDifference,
        initialSha256: sha(boundedRead(path.join(work, 'native-preview.png'))), restoredSha256: sha(boundedRead(path.join(work, 'native-restored.png'))) };
      if (changedPixels) for (const type of details.expectedInteractions) report.runtimeInteraction.checks.push({ name: 'Canvas restoration:' + type, type, status: 'failed', note: 'Runtime did not restore the initial native pixels after the interaction probes.' });
      writeJson(path.join(work, 'runtime-interactions.json'), { checks: report.runtimeInteraction.checks, restoration: details.canvasRestoration });
    }
    phase('verify-source-remained-unchanged');
    if (sha(boundedRead(request.sourceZip)) !== request.sourceZipSha256 || !sameInventory(sourceRows, inventory(request.sourceDirectory))) throw Error('SOURCE_OR_DELIVERY_ZIP_CHANGED_DURING_VALIDATION');
    // Recheck every exact source file actually compiled, not a project/demo label.
    for (const row of environment.fingerprint.sourceInputs) if (sha(boundedRead(inside(environment.workspace, row.path))) !== row.sha256) throw Error('TARGET_SOURCE_CHANGED_DURING_VALIDATION:' + row.path);
    for (const row of environment.fingerprint.vendors) if (sha(boundedRead(inside(environment.workspace, row.path))) !== row.sha256) throw Error('TARGET_RUNTIME_CHANGED_DURING_VALIDATION:' + row.path);
    if (sha(boundedRead(environment.lockFile)) !== environment.fingerprint.runtimeLockSha256) throw Error('RUNTIME_LOCK_CHANGED_DURING_VALIDATION');
    details.originalSourceUnchanged = true;
  } catch (error) {
    details.failures.push({ stage, error: String(error), stack: error.stack });
    if (['open', 'save', 'reopen', 'render'].includes(stage)) check(stage, 'failed', { error: String(error) });
    else if (stage === 'interaction') {
      const types = details.expectedInteractions ?? [];
      for (const type of types) report.runtimeInteraction.checks.push({ name: 'Native interaction failure:' + type, type, status: 'failed', note: String(error) });
      if (/SOURCE|TARGET|ZIP|LOCK/.test(String(error))) check('render', 'failed', { error: String(error) });
    } else report.limitations.push('Native environment precondition was not met: ' + String(error));
  } finally {
    clearTimeout(timer); clearInterval(heartbeat);
    await browser?.close().catch(() => undefined);
    if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
    if (details.pageErrors.length || details.consoleErrors.length) {
      if (report.editorImport.checks.find(row => row.name === 'render').status === 'passed') check('render', 'failed', { pageErrors: details.pageErrors, consoleErrors: details.consoleErrors });
    }
    if (!report.runtimeInteraction.checks.length) for (const type of details.expectedInteractions ?? []) report.runtimeInteraction.checks.push({ name: 'Not executed:' + type, type, status: 'not_verified', note: 'The native render prerequisites did not complete, or no interactive controls were authored.' });
    recompute(); details.completedUtc = new Date().toISOString(); details.elapsedMs = Date.now() - started;
    const evidenceNames = ['source-inventory.json', 'source-fingerprint.json', 'roundtrip-inventory.json', 'encoded-inventory.json', 'native-controls.json', 'native-restored.png', 'runtime-interactions.json', 'adapter-details.json'];
    report.evidence = evidenceNames.filter(name => fs.existsSync(path.join(work, name)) || name === 'adapter-details.json').map(evidencePath);
    if (fs.existsSync(path.join(work, 'native-preview.png'))) {
      // The trusted runner recognizes this exact root-relative evidence name.
      fs.copyFileSync(path.join(work, 'native-preview.png'), path.join(request.outputDirectory, 'native-preview.png'), fs.constants.COPYFILE_EXCL);
      report.evidence.push('native-preview.png');
    }
    save(); process.stdout.write(JSON.stringify({ jobId: report.jobId, sourceZipSha256: report.sourceZipSha256, editorImport: report.editorImport.status,
      runtimeInteraction: report.runtimeInteraction.status, reportFile: request.reportFile, elapsedMs: details.elapsedMs }) + '\n');
  }
  // Exit zero means a complete, bound report was written. Verification failure
  // remains explicit in that report so the runner can preserve its evidence.
  return 0;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) process.stdout.write(usage);
  else if (options['write-fingerprint']) {
    if (options.requestFile) throw Error('PINNING_IS_LOCAL_SETUP_ONLY_AND_CANNOT_ACCEPT_A_RUNNER_REQUEST');
    const environment = await prepareEnvironment(options), file = path.resolve(options['write-fingerprint']);
    if (fs.existsSync(file)) throw Error('FINGERPRINT_ALREADY_EXISTS: write a newly reviewed version instead of silently replacing trust');
    writeJson(file, environment.fingerprint);
    process.stdout.write(JSON.stringify({ fingerprintFile: file, sourceInputs: environment.fingerprint.sourceInputs.length,
      sourceApiBundleSha256: environment.fingerprint.sourceApiBundleSha256, runtimeProfileId: environment.fingerprint.runtimeProfileId }) + '\n');
  } else process.exitCode = await run(options);
} catch (error) { process.stderr.write(JSON.stringify({ error: String(error), note: 'No native verification PASS was created.' }) + '\n'); process.exitCode = 1; }
