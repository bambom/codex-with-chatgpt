/** Browser callbacks for the trusted MagicGameStudio source-workbench adapter.
 * These functions are serialized by Playwright; they deliberately access only
 * the real source-built NativeFGUI API and the pinned runtime on this page.
 */
export async function openSource() {
  const input = await (await fetch('./input.json')).json(), api = window.NativeFGUI;
  const from64 = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
  const projectId = 'project:' + crypto.randomUUID();
  const open = async offered => {
    const read = await api.readSourceProjectCatalog({ projectPath: offered.projectPath, directories: offered.directories,
      files: offered.files.map(row => ({ path: row.path, bytes: from64(row.base64) })) });
    const rows = read.catalog.packages.flatMap(pkg => pkg.components.map(component => ({ packageId: pkg.sourceId, ...component })));
    if (read.catalog.issues.length || rows.some(row => !row.importable)) {
      const error = new Error('NATIVE_SOURCE_IMPORT_REJECTED');
      error.details = { issues: read.catalog.issues, components: rows.filter(row => !row.importable) }; throw error;
    }
    const matches = read.catalog.packages.flatMap(pkg => pkg.components.filter(row => row.sourceItemId === input.entryResourceId).map(row => ({ pkg, row })));
    if (matches.length !== 1) throw Error('ENTRY_RESOURCE_NOT_UNIQUE:' + input.entryResourceId);
    const { pkg: selectedPackage, row: selected } = matches[0], owners = new Map(); let root;
    for (const pkg of read.catalog.packages) for (const component of pkg.components) {
      const documentId = await api.sourceComponentDocumentId(projectId, pkg.sourceId, component.sourceItemId);
      const imported = await api.importSourceComponent({ archive: read.archive, sourcePackageId: pkg.sourceId,
        sourceComponentItemId: component.sourceItemId, target: { projectId, documentId } });
      owners.set(documentId, imported.document);
      if (pkg.sourceId === selectedPackage.sourceId && component.sourceItemId === selected.sourceItemId) root = imported.document;
    }
    if (!root) throw Error('NATIVE_ENTRY_IMPORT_MISSING');
    return { read, rows, owners, root, selectedPackage, selected };
  };
  window.NV = { input, api, open, projectId };
  try {
    Object.assign(window.NV, await open(input));
    return { status: 'passed', limits: api.SOURCE_PROJECT_LIMITS, project: window.NV.read.catalog.project,
      components: window.NV.rows, entry: { packageId: window.NV.selectedPackage.sourceId, componentId: window.NV.selected.sourceItemId, name: window.NV.selected.name } };
  } catch (error) { return { status: 'failed', error: String(error), details: error.details, stack: error.stack }; }
}

export async function saveSource() {
  const state = window.NV, dependencies = new Map(state.owners); dependencies.delete(state.root.id);
  const output = await state.api.exportSourceComponent(state.root, dependencies);
  const to64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); };
  const hashes = await Promise.all(output.files.map(async row => ({ path: row.path, bytes: row.bytes.length, sha256: await state.api.sourceProjectHash(row.bytes) })));
  const original = new Map(state.read.archive.files.map(row => [row.path, row.sha256]));
  const response = await fetch('./saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    projectPath: state.input.projectPath, directories: output.directories ?? [], files: output.files.map(row => ({ path: row.path, base64: to64(row.bytes) })),
  }) });
  if (!response.ok) throw Error('NATIVE_SAVE_TO_DISK_FAILED:' + await response.text());
  return { status: 'passed', files: hashes, unchangedFilesByteExact: hashes.length === original.size && hashes.every(row => original.get(row.path) === row.sha256) };
}

export async function reopenSource() {
  // This endpoint re-reads the files actually saved on disk, not the in-memory
  // export result. Subsequent encoding uses these reopened documents.
  const offered = await (await fetch('./saved-input.json')).json();
  try {
    Object.assign(window.NV, await window.NV.open(offered));
    return { status: 'passed', project: window.NV.read.catalog.project, components: window.NV.rows,
      reopenedFileHashes: window.NV.read.archive.files.map(row => ({ path: row.path, sha256: row.sha256, bytes: row.byteLength })) };
  } catch (error) { return { status: 'failed', error: String(error), details: error.details, stack: error.stack }; }
}

export async function encodeSource() {
  const state = window.NV, api = state.api, dependencies = new Map(state.owners); dependencies.delete(state.root.id);
  const phase = name => console.info('NATIVE_ADAPTER_PHASE:' + name);
  phase('source-assets');
  const assets = await api.sourceRuntimeSceneAssets(state.root, dependencies);
  phase('source-assets-complete');
  const serialized = new api.DocumentGraph(state.root).serialize();
  const record = { projectId: state.root.projectId, documentId: state.root.id, revision: state.root.revision, recordVersion: 1, serialized,
    sha256: await api.sourceProjectHash(new TextEncoder().encode(serialized)) };
  phase('native-encoding');
  const encoded = await api.encodeSavedPackage(record, assets, dependencies, 'fixed-laya-source');
  phase('native-encoding-complete');
  const to64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); };
  const response = await fetch('./encoded', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(encoded.files.map(row => ({ path: row.name, base64: to64(row.bytes) }))) });
  if (!response.ok) throw Error('NATIVE_ENCODED_FILES_SAVE_FAILED:' + await response.text());
  state.encoded = encoded;
  return { packageId: encoded.packageId, componentId: encoded.componentId, source: encoded.source,
    files: await Promise.all(encoded.files.map(async row => ({ path: row.name, bytes: row.bytes.length, sha256: await api.sourceProjectHash(row.bytes) }))),
    runtimeFonts: (encoded.runtimeFonts ?? []).map(({ bytes, ...row }) => row), dependencyPackages: encoded.dependencyPackages ?? [], quantization: encoded.quantization };
}

export async function renderSource() {
  const state = window.NV, { input, encoded, api } = state, Laya = window.Laya, fgui = window.fgui;
  const phase = name => console.info('NATIVE_ADAPTER_PHASE:' + name);
  phase('runtime-init');
  Laya.Config.useRetinalCanvas = false; await Laya.init(input.canvas.width, input.canvas.height);
  Laya.stage.scaleMode = Laya.Stage.SCALE_NOSCALE; Laya.stage.alignH = Laya.Stage.ALIGN_LEFT; Laya.stage.alignV = Laya.Stage.ALIGN_TOP;
  Laya.stage.bgColor = '#ffffff'; Laya.stage.addChild(fgui.GRoot.inst.displayObject);
  state.runtimeLease = api.installFixedLayaRuntime();
  phase('native-fonts'); state.fontLease = await api.loadFixedSourceFonts(encoded.runtimeFonts ?? []); phase('native-fonts-complete');
  const packageNames = [...(encoded.dependencyPackages ?? []).map(row => row.binaryName), 'ui.fui'];
  for (const name of packageNames) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('NATIVE_PACKAGE_LOAD_TIMEOUT:' + name)), 15000);
    fgui.UIPackage.loadPackage(input.baseUrl + 'encoded/' + name.slice(0, -4), packages => { clearTimeout(timer); packages?.length ? resolve() : reject(Error('NATIVE_PACKAGE_LOAD_EMPTY:' + name)); });
  });
  const root = fgui.UIPackage.createObjectFromURL('ui://' + state.selectedPackage.sourceId + state.selected.sourceItemId);
  if (!(root instanceof fgui.GComponent) || root.width !== input.canvas.width || root.height !== input.canvas.height) throw Error('NATIVE_CANVAS_OR_ROOT_TYPE_MISMATCH');
  root.setXY(0, 0); fgui.GRoot.inst.addChild(root); state.runtimeRoot = root;
  const kind = object => ['GButton', 'GComboBox', 'GSlider', 'GProgressBar', 'GScrollBar', 'GList', 'GTextInput', 'GRichTextField', 'GTextField', 'GLoader', 'GImage', 'GGroup', 'GComponent']
    .find(name => fgui[name] && object instanceof fgui[name]) ?? object.constructor.name;
  const objects = [], seen = new Set();
  const walk = (object, prefix, forcedName) => {
    if (seen.has(object)) return; seen.add(object);
    const name = forcedName ?? `${object.name || 'object'}#${object.id}`, location = prefix ? prefix + '/' + name : 'Root';
    objects.push({ object, path: location });
    if (object instanceof fgui.GComponent) for (let i = 0; i < object.numChildren; i++) walk(object.getChildAt(i), location);
    const pane = object.scrollPane;
    if (pane?._vtScrollBar) walk(pane._vtScrollBar, location, '@verticalScrollBar');
    if (pane?._hzScrollBar) walk(pane._hzScrollBar, location, '@horizontalScrollBar');
  };
  walk(root, '');
  const visible = object => { for (let current = object; current; current = current.parent) if (!current.visible || current.internalVisible === false || current.internalVisible2 === false) return false; return !!object.displayObject?.parent; };
  const point = (object, fractionX = 0.5, fractionY = 0.5) => {
    const p = object.localToGlobal(object.width * fractionX, object.height * fractionY), rect = document.querySelector('canvas').getBoundingClientRect();
    for (let ancestor = object.parent; ancestor; ancestor = ancestor.parent) {
      const pane = ancestor.scrollPane;
      if (pane) {
        const local = ancestor.globalToLocal(p.x, p.y), mask = pane._maskContainer;
        if (!mask || local.x < mask.x || local.y < mask.y || local.x >= mask.x + pane.viewWidth || local.y >= mask.y + pane.viewHeight) return null;
      }
    }
    const x = rect.left + p.x * rect.width / Laya.stage.width, y = rect.top + p.y * rect.height / Laya.stage.height;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    return { x, y };
  };
  const frames = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => requestAnimationFrame(resolve)); };
  const controllers = objects.flatMap(({ object }) => (object._controllers ?? []).map(controller => ({ controller, index: controller.selectedIndex })));
  const snapshots = objects.map(({ object }) => ({ object, kind: kind(object), selected: object.selected, selectedIndex: object.selectedIndex,
    text: object instanceof fgui.GTextInput ? object.text : undefined, value: object.value, scrollX: object.scrollPane?.posX, scrollY: object.scrollPane?.posY,
    selection: object instanceof fgui.GList && typeof object.getSelection === 'function' ? object.getSelection() : undefined }));
  const cleanups = [];
  const restore = async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    fgui.GRoot.inst.hidePopup(); document.activeElement?.blur?.();
    for (const row of snapshots) {
      if (row.kind === 'GButton') row.object.selected = row.selected;
      if (row.kind === 'GComboBox') row.object.selectedIndex = row.selectedIndex;
      if (row.kind === 'GTextInput') { row.object.text = row.text; if ('focus' in row.object.displayObject) row.object.displayObject.focus = false; }
      if (row.kind === 'GSlider' || row.kind === 'GProgressBar') row.object.value = row.value;
      if (row.object.scrollPane) { row.object.scrollPane.cancelDragging?.(); row.object.ensureBoundsCorrect(); row.object.scrollPane.setPosX(row.scrollX, false); row.object.scrollPane.setPosY(row.scrollY, false); }
      if (row.selection) { row.object.clearSelection(); for (const index of row.selection) row.object.addSelection(index, false); }
    }
    for (const row of controllers) row.controller.selectedIndex = row.index;
    await frames();
  };
  const buttonState = object => {
    const controller = object.getController('button');
    return { mode: object.mode, selected: object.selected, page: controller?.selectedPage, index: controller?.selectedIndex,
      feedbackConfigured: (controller?.pageCount ?? 0) > 1 || (object._downEffect ?? 0) !== 0,
      scaleX: object.scaleX, scaleY: object.scaleY, colors: Array.from({ length: object.numChildren }, (_, i) => object.getChildAt(i)).filter(row => typeof row.color === 'string').map(row => ({ name: row.name, color: row.color })) };
  };
  window.S = { root, objects, visible, point, frames, restore, buttonState, cleanups, kind,
    locate: name => objects.find(row => row.path === name)?.object };
  await document.fonts.ready; await frames();
  const controls = objects.map(({ object, path }) => {
    const global = object.localToGlobal(0, 0);
    return { path, id: object.id, name: object.name, kind: kind(object), x: object.x, y: object.y, globalX: global.x, globalY: global.y,
      width: object.width, height: object.height, visible: visible(object), touchable: object.touchable, enabled: object.enabled !== false,
      internalVisible: object.internalVisible, internalVisible2: object.internalVisible2,
      text: typeof object.text === 'string' ? object.text : undefined, font: object instanceof fgui.GTextField ? object.font : undefined, fontSize: object instanceof fgui.GTextField ? object.fontSize : undefined };
  });
  return { status: 'passed', width: root.width, height: root.height, runtimeVersion: api.FIXED_LAYA_RUNTIME_VERSION,
    fonts: [...document.fonts].map(face => ({ family: face.family, status: face.status })), controls };
}

/** Generic probes use real Playwright pointer/keyboard events. No SDK patch,
 * artificial range changes, business callback implementation or service call.
 */
export async function exerciseControls(page, controls, expectedTypes, saveCheck, phase, options = {}) {
  const checks = [], typeMap = { GButton: 'Button', GTextInput: 'InputText', GSlider: 'Slider', GProgressBar: 'ProgressBar', GList: 'List', GComboBox: 'ComboBox', GScrollBar: 'ScrollBar' };
  const add = async row => { checks.push(row); await saveCheck(row); };
  const neutral = async () => { await page.mouse.move(-10, -10); await page.evaluate(() => window.S.restore()); };
  const targets = controls.filter(row => row.visible && row.enabled && (row.touchable !== false || row.kind === 'GProgressBar') && row.width > 0 && row.height > 0 && typeMap[row.kind] && expectedTypes.includes(typeMap[row.kind]));
  for (const target of targets.slice(0, 128)) {
    const type = typeMap[target.kind], row = { name: `${type}:${target.path}`, type, path: target.path, status: 'failed' };
    phase('interaction:' + type);
    try {
      await neutral();
      if (type === 'Button') {
        row.before = await page.evaluate(path => {
          const object = window.S.locate(path), state = window.S.buttonState(object), point = window.S.point(object);
          if (!point || !window.S.visible(object)) return null;
          window.S.clicks = 0; const handler = () => window.S.clicks++; object.onClick(null, handler); window.S.cleanups.push(() => object.offClick(null, handler));
          return { point, state };
        }, target.path);
        if (!row.before) { row.status = 'not_verified'; row.note = 'The control center is outside the initial viewport or hidden by its state.'; }
        else {
          await page.mouse.move(row.before.point.x, row.before.point.y); await page.evaluate(() => window.S.frames());
          row.hover = await page.evaluate(path => window.S.buttonState(window.S.locate(path)), target.path);
          await page.mouse.down(); await page.evaluate(() => window.S.frames()); row.pressed = await page.evaluate(path => window.S.buttonState(window.S.locate(path)), target.path);
          await page.mouse.up(); await page.mouse.move(-10, -10); await page.evaluate(() => window.S.frames());
          row.after = await page.evaluate(path => ({ clicks: window.S.clicks, state: window.S.buttonState(window.S.locate(path)) }), target.path);
          const selection = row.before.state.mode === 1 ? row.after.state.selected !== row.before.state.selected : row.before.state.mode === 2 ? row.after.state.selected === true : true;
          // The pinned GButton changes to DOWN on mouse-down only in Common
          // mode. Check/Radio change their selected state during the click.
          const press = row.before.state.mode !== 0 || !row.before.state.feedbackConfigured || JSON.stringify(row.pressed) !== JSON.stringify(row.hover);
          const released = row.before.state.mode !== 0 || JSON.stringify(row.after.state) === JSON.stringify(row.before.state);
          row.assertions = { oneClick: row.after.clicks === 1, selection, commonPressFeedback: press, release: released };
          row.status = row.after.clicks === 1 && selection && press && released ? 'passed' : 'failed';
          if (!row.before.state.feedbackConfigured) row.note = 'No visual feedback was authored; native click/selection behavior was tested without inventing a state.';
        }
      } else if (type === 'ComboBox') {
        row.before = await page.evaluate(path => { const o = window.S.locate(path); return { point: window.S.point(o), selectedIndex: o.selectedIndex }; }, target.path);
        if (!row.before.point) throw Error('COMBO_OUTSIDE_VIEWPORT');
        await page.mouse.click(row.before.point.x, row.before.point.y); await page.evaluate(() => window.S.frames());
        row.popup = await page.evaluate(path => {
          const o = window.S.locate(path), list = o.dropdown?.getChild('list'), count = list?.numChildren ?? 0;
          const index = count > 1 ? (o.selectedIndex + 1) % count : 0;
          if (count) { list.scrollToView?.(index, false); list.ensureBoundsCorrect(); }
          return { open: !!o.dropdown?.parent, count, index, point: count ? window.S.point(list.getChildAt(index)) : null, nativeList: list instanceof window.fgui.GList };
        }, target.path);
        if (!row.popup.open) throw Error('NATIVE_COMBO_POPUP_NOT_OPEN');
        if (!row.popup.count) { row.status = 'not_verified'; row.note = 'Authored option list is empty; no option was fabricated.'; }
        else {
          if (!row.popup.point) throw Error('COMBO_ITEM_OUTSIDE_VIEWPORT');
          await page.mouse.click(row.popup.point.x, row.popup.point.y);
          await page.waitForFunction(path => !window.S.locate(path).dropdown?.parent, target.path, { timeout: 3500 });
          row.after = await page.evaluate(path => { const o = window.S.locate(path); return { selectedIndex: o.selectedIndex, value: o.value, closed: !o.dropdown?.parent }; }, target.path);
          row.status = row.after.selectedIndex === row.popup.index && row.after.closed ? 'passed' : 'failed';
          row.note = 'Waited for actual popup closure after the runtime callLater callback.';
          if (row.popup.nativeList && expectedTypes.includes('List')) await add({ name: 'ComboBox popup native List selection:' + target.path, type: 'List', status: row.status, scope: 'Selection in the real ComboBox popup list; this does not claim overflow scrolling.' });
        }
      } else if (type === 'InputText') {
        row.before = await page.evaluate(path => { const o = window.S.locate(path); return { point: window.S.point(o), text: o.text, restrict: o.restrict ?? '', maxLength: o.maxLength ?? 0, password: !!o.password }; }, target.path);
        const restriction = row.before.restrict;
        let text = !restriction ? 'Test7' : /^(?:0-9|\\d|\[0-9\])$/.test(restriction) ? '73' : null;
        if (text === null) { row.status = 'not_verified'; row.note = 'Unrecognized authored input restriction; adapter did not guess valid business input.'; }
        else {
          if (row.before.maxLength > 0) text = text.slice(0, row.before.maxLength);
          if (!row.before.point) throw Error('INPUT_OUTSIDE_VIEWPORT');
          await page.mouse.click(row.before.point.x, row.before.point.y); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.insertText(text);
          await page.evaluate(() => window.S.frames()); row.after = await page.evaluate(path => ({ text: window.S.locate(path).text }), target.path);
          row.status = row.after.text === text ? 'passed' : 'failed'; row.input = text;
        }
      } else if (type === 'Slider') {
        row.before = await page.evaluate(path => { const o = window.S.locate(path), grip = o.getChild('grip'); return { value: o.value, min: o.min, max: o.max, wholeNumbers: o.wholeNumbers,
          reverse: !!o._reverse, vertical: !!o.getChild('bar_v'), span: o.getChild('bar_v') ? o.height : o.width, point: grip ? window.S.point(grip) : null }; }, target.path);
        if (!row.before.point) throw Error('NATIVE_SLIDER_GRIP_NOT_REACHABLE');
        if (!(row.before.max > row.before.min)) { row.status = 'not_verified'; row.note = 'Authored range has no extent; no artificial min/max was substituted.'; }
        else {
          const sign = (row.before.value - row.before.min) / (row.before.max - row.before.min) > 0.5 ? -1 : 1;
          const movement = sign * (row.before.reverse ? -1 : 1) * Math.max(8, row.before.span * 0.3);
          await page.mouse.move(row.before.point.x, row.before.point.y); await page.mouse.down();
          await page.mouse.move(row.before.point.x + (row.before.vertical ? 0 : movement), row.before.point.y + (row.before.vertical ? movement : 0), { steps: 8 });
          await page.mouse.up(); await page.evaluate(() => window.S.frames());
          row.after = await page.evaluate(path => ({ value: window.S.locate(path).value }), target.path);
          row.status = row.after.value !== row.before.value && row.after.value >= row.before.min && row.after.value <= row.before.max && (!row.before.wholeNumbers || Number.isInteger(row.after.value)) ? 'passed' : 'failed';
        }
      } else if (type === 'ProgressBar') {
        row.values = await page.evaluate(path => {
          const o = window.S.locate(path), bar = o.getChild('bar') ?? o.getChild('bar_v'), value = o.value;
          if (!bar) throw Error('NATIVE_PROGRESS_BAR_PART_MISSING');
          const snapshot = () => ({ width: bar.width, height: bar.height, fillAmount: bar.fillAmount });
          try { o.value = o.min; const low = snapshot(); o.value = o.max; return { min: o.min, max: o.max, low, high: snapshot() }; } finally { o.value = value; }
        }, target.path);
        row.status = row.values.max <= row.values.min ? 'not_verified' : JSON.stringify(row.values.low) !== JSON.stringify(row.values.high) ? 'passed' : 'failed';
        row.note = 'Value-driven display was checked with the authored min/max and restored; this is not a game-service update test.';
      } else if (type === 'List' || type === 'ScrollBar') {
        row.before = await page.evaluate(({ path, type }) => {
          const object = window.S.locate(path), pane = type === 'List' ? object.scrollPane : object._target, owner = type === 'List' ? object : pane?.owner;
          if (!pane) return { hasScrollPane: false, count: object.numChildren, selectionMode: object.selectionMode };
          owner.ensureBoundsCorrect();
          return { hasScrollPane: true, count: owner instanceof window.fgui.GList ? owner.numChildren : undefined,
            maxX: Math.max(0, pane.contentWidth - pane.viewWidth), maxY: Math.max(0, pane.contentHeight - pane.viewHeight), posX: pane.posX, posY: pane.posY,
            touchEffect: pane.touchEffect, mouseWheelEnabled: pane.mouseWheelEnabled, listOwner: owner instanceof window.fgui.GList };
        }, { path: target.path, type });
        if (!row.before.hasScrollPane) { row.status = 'not_verified'; row.note = 'No linked native ScrollPane; scrolling cannot be claimed from a list/scrollbar skin.'; }
        else {
          row.fixture = await page.evaluate(async ({ path, type, allow }) => {
            const object = window.S.locate(path), pane = type === 'List' ? object.scrollPane : object._target, owner = pane.owner;
            const added = [], originalCount = owner instanceof window.fgui.GList ? owner.numChildren : undefined;
            window.S.fixture = { owner, pane, added, originalCount, posX: pane.posX, posY: pane.posY };
            const overflow = () => pane.contentHeight > pane.viewHeight + 2 || pane.contentWidth > pane.viewWidth + 2;
            if (allow && owner instanceof window.fgui.GList) {
              const last = owner.numChildren ? owner.getChildAt(owner.numChildren - 1) : null, url = last?.resourceURL || owner.defaultItem;
              if (url) while (!overflow() && added.length < 32) { const item = owner.addItemFromPool(url); added.push(item); owner.ensureBoundsCorrect(); await window.S.frames(); }
            }
            owner.ensureBoundsCorrect(); await window.S.frames();
            const vertical = type === 'ScrollBar' ? object._vertical : pane.contentHeight > pane.viewHeight;
            const grip = type === 'ScrollBar' ? object.getChild('grip') : null;
            return { added: added.length, originalCount, count: owner instanceof window.fgui.GList ? owner.numChildren : undefined,
              overflow: overflow(), vertical, point: window.S.point(grip ?? owner), span: vertical ? owner.height : owner.width,
              pos: vertical ? pane.posY : pane.posX, max: vertical ? Math.max(0, pane.contentHeight - pane.viewHeight) : Math.max(0, pane.contentWidth - pane.viewWidth),
              touchEffect: pane.touchEffect, mouseWheelEnabled: pane.mouseWheelEnabled, gripDragging: object.gripDragging };
          }, { path: target.path, type, allow: options.listFixtures !== false });
          row.initialOverflow = row.before.maxX > 0 || row.before.maxY > 0;
          if (row.fixture.added) row.fixture.note = 'Temporary copies of the existing item template, confined to this runtime instance and removed afterwards; no source or business data was written.';
          if (!row.fixture.overflow) { row.status = 'not_verified'; row.note = 'Authored contents do not overflow; bounded template fixtures could not create a testable extent.'; }
          else if (!row.fixture.point) { row.status = 'not_verified'; row.note = 'Scroll interaction point is outside the visible canvas.'; }
          else if (type === 'ScrollBar' || row.fixture.touchEffect) {
            const sign = row.fixture.pos > row.fixture.max / 2 ? -1 : 1;
            const delta = Math.max(10, Math.min(160, row.fixture.span * 0.3)) * sign * (type === 'ScrollBar' ? 1 : -1), point = row.fixture.point;
            await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.evaluate(() => window.S.frames());
            await page.mouse.move(point.x + (row.fixture.vertical ? 0 : delta), point.y + (row.fixture.vertical ? delta : 0), { steps: 12 });
            await page.mouse.up();
            await page.waitForFunction(({ vertical, before }) => Math.abs((vertical ? window.S.fixture.pane.posY : window.S.fixture.pane.posX) - before) > 0.25,
              { vertical: row.fixture.vertical, before: row.fixture.pos }, { timeout: 3500 });
            row.after = await page.evaluate(() => ({ posX: window.S.fixture.pane.posX, posY: window.S.fixture.pane.posY })); row.status = 'passed'; row.method = type === 'ScrollBar' ? 'native scrollbar grip pointer drag' : 'native ScrollPane pointer drag';
          } else if (row.fixture.mouseWheelEnabled) {
            await page.mouse.move(row.fixture.point.x, row.fixture.point.y); await page.mouse.wheel(0, row.fixture.pos > row.fixture.max / 2 ? -300 : 300);
            await page.waitForFunction(({ vertical, before }) => Math.abs((vertical ? window.S.fixture.pane.posY : window.S.fixture.pane.posX) - before) > 0.25,
              { vertical: row.fixture.vertical, before: row.fixture.pos }, { timeout: 3500 });
            row.status = 'passed'; row.method = 'native mouse wheel';
          } else { row.status = 'not_verified'; row.note = 'The authored configuration disables both touch drag and mouse wheel; neither flag was changed.'; }
          row.wheelEnabled = row.fixture.mouseWheelEnabled;
        }
      }
    } catch (error) { row.status = 'failed'; row.error = String(error); }
    finally {
      try {
        row.restoration = await page.evaluate(async () => {
          const fixture = window.S.fixture;
          if (fixture) {
            fixture.pane.cancelDragging?.();
            for (const item of fixture.added) { const index = fixture.owner.getChildIndex(item); if (index >= 0) fixture.owner.removeChildToPoolAt(index); }
            fixture.owner.ensureBoundsCorrect(); fixture.pane.setPosX(fixture.posX, false); fixture.pane.setPosY(fixture.posY, false); await window.S.frames();
            const restored = { count: fixture.owner instanceof window.fgui.GList ? fixture.owner.numChildren : undefined, originalCount: fixture.originalCount, posX: fixture.pane.posX, posY: fixture.pane.posY };
            delete window.S.fixture; await window.S.restore(); return restored;
          }
          await window.S.restore(); return { restored: true };
        });
        if (row.restoration.originalCount !== undefined && row.restoration.originalCount !== row.restoration.count) { row.status = 'failed'; row.restoration.error = 'Temporary list items were not completely removed'; }
      } catch (error) { row.status = 'failed'; row.restoration = { error: String(error) }; }
    }
    await add(row);
  }
  if (targets.length > 128) for (const type of new Set(targets.slice(128).map(row => typeMap[row.kind]))) await add({ name: 'Target budget:' + type, type, status: 'not_verified', note: 'More than 128 initially reachable controls; remaining controls were not exercised.' });
  for (const type of expectedTypes) if (!checks.some(row => row.type === type)) await add({ name: 'No reachable target:' + type, type, status: 'not_verified', note: 'No enabled visible control of this expected type was reachable in the initial state; hidden states and business callbacks were not invented.' });
  await neutral();
  return checks;
}
