'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../com.shu.groupexport/host/host.jsx'), 'utf8');

function photoshop(options = {}) {
  const raster = (id, name, visible, bounds) => ({id, name, visible, bounds, typename: 'ArtLayer'});
  const group = (id, name, visible, layers, extra = {}) => Object.assign({id, name, visible, layers, typename: 'LayerSet'}, extra);
  const initial = options.layers || [
    group(1, '父组 A', false, [group(2, 'B', false, [
      group(11, '方案 01', false, [raster(101, '图', true, [20, 30, 220, 180])]),
      group(12, '方案 02', true, [raster(102, '图', true, [40, 50, 260, 200])])
    ])], {mask: [30, 40, 210, 170], effect: 'shadow'}),
    group(3, '父组 C', true, [group(13, '方案 03', true, [raster(103, '图', true, [10, 10, 100, 100])])]),
    raster(4, '公共背景', true, [0, 0, 800, 600])
  ];
  let nextId = 1000, revision = 8, fail = options.fail;
  const events = [], saves = [], files = new Set(), docs = [], merges = [];
  const app = {documents: docs, activeDocument: null, displayDialogs: 'ALL', preferences: {rulerUnits: options.rulerUnits || 'CM'}};
  function flatten(layers) { return layers.flatMap(l => [l, ...(l.layers ? flatten(l.layers) : [])]); }
  function find(id) { return flatten(app.activeDocument.layers).find(l => l.id === id); }
  function bounds(layers) {
    const boxes = layers.filter(l => l.visible).map(l => {
      let b = l.layers ? bounds(l.layers) : l.bounds;
      if (l.mask) b = [Math.max(b[0], l.mask[0]), Math.max(b[1], l.mask[1]), Math.min(b[2], l.mask[2]), Math.min(b[3], l.mask[3])];
      if (l.board && l.background !== 3) b = l.board;
      return b;
    }).filter(b => b && b[2] > b[0] && b[3] > b[1]);
    if (!boxes.length) return [0, 0, 0, 0];
    return [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])), Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))];
  }
  // DOM UnitValues are only correct in pixels when the rulers are set to pixels.
  const unit = value => ({as: u => { assert.equal(u, 'px'); if (app.preferences.rulerUnits !== 'PIXELS') throw new Error('ruler units are not pixels'); return value; }});
  function parentOf(doc, layer) {
    const walk = list => { if (list.includes(layer)) return list; for (const l of list) { if (l.layers) { const r = walk(l.layers); if (r) return r; } } return null; };
    return walk(doc.layers);
  }
  function decorate(doc, layers) {
    for (const layer of layers) {
      layer.remove = function () { const list = parentOf(doc, this); list.splice(list.indexOf(this), 1); };
      if (!layer.layers) continue;
      layer.duplicate = function () {
        if (fail === 'merge') throw new Error('duplicate layer failed');
        const list = parentOf(doc, this), copy = JSON.parse(JSON.stringify(this)); copy.id = nextId++;
        decorate(doc, [copy]); list.splice(list.indexOf(this), 0, copy); return copy;
      };
      layer.merge = function () {
        const own = bounds([Object.assign({}, this, {visible: true})]);
        if (!(own[2] > own[0] && own[3] > own[1])) throw new Error('nothing to merge');
        merges.push(own);
        const list = parentOf(doc, this), merged = raster(nextId++, 'merged group', true, own);
        merged.bounds = own.map(unit); decorate(doc, [merged]); list.splice(list.indexOf(this), 1, merged); return merged;
      };
      decorate(doc, layer.layers);
    }
  }
  function document(name, layers, width = 800, height = 600) {
    const doc = {id: nextId++, name, layers, width: unit(width), height: unit(height), mode: options.mode || 'RGB', bitsPerChannel: options.bits || 16,
      activeHistoryState: {name: 'snapshot'}, activeLayer: layers[0], saved: true, modes: [],
      get historyStates() { return {length: revision}; },
      duplicate(name, merged) {
        if (fail === 'duplicate') throw new Error('duplicate failed');
        events.push({name, merged, layers: JSON.parse(JSON.stringify(this.layers))});
        const copy = merged ? [raster(nextId++, 'merged', true, bounds(this.layers))] : JSON.parse(JSON.stringify(this.layers));
        const d = document(name, copy, this.width.as('px'), this.height.as('px')); d.mode = this.mode; d.bitsPerChannel = this.bitsPerChannel; app.activeDocument = d; return d;
      },
      crop(rect) { this.cropRect = Array.from(rect, v => v.as()); this.width = unit(this.cropRect[2] - this.cropRect[0]); this.height = unit(this.cropRect[3] - this.cropRect[1]); },
      changeMode(mode) { this.modes.push(mode); this.mode = mode; }, convertProfile() {},
      saveAs(file) { if (fail === 'save') throw new Error('save failed'); files.add(file.path); saves.push({doc: this, rect: this.cropRect, mode: this.mode, bits: this.bitsPerChannel, modes: this.modes}); },
      close() { docs.splice(docs.indexOf(this), 1); if (docs.length) app.activeDocument = docs[0]; }
    };
    decorate(doc, layers);
    docs.push(doc); return doc;
  }
  const source = document('示例.psd', initial); source.id = 50; app.activeDocument = source;
  const selected = options.selected || [11, 12, 13];
  function ActionReference() {}
  ActionReference.prototype.putProperty = function (c, p) { this.cls = c; this.property = p; };
  ActionReference.prototype.putIdentifier = function (c, id) { this.id = id; };
  ActionReference.prototype.putEnumerated = function (c) { this.type = c; };
  function ActionDescriptor() { this.data = {}; }
  function executeActionGet(ref) {
    if (ref.property === 'targetLayersIDs') return {hasKey: () => true, getList: () => ({count: selected.length, getReference: i => ({getIdentifier: () => selected[i]})})};
    if (ref.cls === 'historyState' || ref.type === 'historyState') return {hasKey: () => !options.noHistoryID, getInteger: () => revision};
    const layer = find(ref.id);
    if (ref.property === 'layerSection') return {getEnumerationValue: () => layer.layers ? 'layerSectionStart' : 'layerSectionContent'};
    if (ref.property === 'name') return {getString: () => layer.name};
    if (ref.property === 'artboardEnabled') return {hasKey: () => true, getBoolean: () => !!layer.board};
    if (ref.property === 'artboard') return {getObjectValue: () => ({getObjectValue: () => ({getUnitDoubleValue: key => layer.board[{left: 0, top: 1, right: 2, bottom: 3}[key]]})})};
    throw new Error('Unexpected reference: ' + JSON.stringify(ref));
  }
  function File(p) { this.path = p; this.parent = {exists: true}; Object.defineProperty(this, 'exists', {get: () => files.has(p)}); }
  const ctx = vm.createContext({app, stringIDToTypeID: s => s, charIDToTypeID: s => s, ActionReference, ActionDescriptor,
    executeActionGet, executeAction: () => { throw new Error('no ActionManager edits expected'); },
    File, UnitValue: function (v, u) { assert.equal(u, 'px'); this.as = () => v; }, PNGSaveOptions: function () {}, Units: {PIXELS: 'PIXELS'},
    DialogModes: {NO: 'NO'}, SaveOptions: {DONOTSAVECHANGES: 'NO_SAVE'},
    DocumentMode: {RGB: 'RGB', BITMAP: 'BITMAP', GRAYSCALE: 'GRAYSCALE', MULTICHANNEL: 'MULTICHANNEL', CMYK: 'CMYK'},
    ChangeMode: {RGB: 'RGB', GRAYSCALE: 'GRAYSCALE'}, BitsPerChannelType: {EIGHT: 8, SIXTEEN: 16, THIRTYTWO: 32}, Intent: {RELATIVECOLORIMETRIC: 0}, Extension: {LOWERCASE: 0}});
  vm.runInContext(script, ctx);
  const invoke = expression => JSON.parse(vm.runInContext(expression, ctx));
  const capture = mode => invoke('GroupExporter.capture(' + (mode ? JSON.stringify(mode) : '') + ')');
  const render = (capture, id = 11, scope = 'canvas', ids = capture.targets.map(t => t.id)) => {
    files.clear();
    return invoke(`GroupExporter.render(${JSON.stringify(capture.token)},${JSON.stringify(ids)},${id},${JSON.stringify(scope)},"/tmp/out.png")`);
  };
  const release = () => invoke('GroupExporter.release()');
  const scene = name => events.filter(e => e.name === name).pop().layers;
  return {source, app, events, saves, docs, merges, capture, render, release, scene, invoke, edit: () => revision++, fail: value => { fail = value; }};
}

function assertPristine(p, initial) {
  assert.equal(p.release().ok, true);
  assert.equal(p.docs.length, 1); assert.equal(JSON.stringify(p.source), initial);
  assert.equal(p.app.activeDocument, p.source); assert.equal(p.app.displayDialogs, 'ALL'); assert.equal(p.app.preferences.rulerUnits, 'CM');
}

test('captures nested folders across multiple parents with their exact names and full paths', () => {
  const p = photoshop(), c = p.capture(); assert.equal(c.ok, true);
  assert.deepEqual(c.targets.map(t => [t.id, t.name, t.path, t.breadcrumb]), [
    [11, '方案 01', [0, 0, 0], '父组 A / B / 方案 01'],
    [12, '方案 02', [0, 0, 1], '父组 A / B / 方案 02'],
    [13, '方案 03', [1, 0], '父组 C / 方案 03']
  ]);
  assert.deepEqual(c.targets.map(t => t.parent), ['B', 'B', '父组 C']);
  assert.equal(p.app.preferences.rulerUnits, 'CM', 'ruler units are restored after reading');
});

test('children mode turns each selected parent into its direct sub-folders, across parents', () => {
  const p = photoshop({selected: [2, 3]}), c = p.capture('children'); assert.equal(c.ok, true);
  assert.deepEqual(c.targets.map(t => [t.id, t.path, t.breadcrumb]), [
    [11, [0, 0, 0], '父组 A / B / 方案 01'], [12, [0, 0, 1], '父组 A / B / 方案 02'], [13, [1, 0], '父组 C / 方案 03']
  ]);
  assert.equal(p.render(c, 12, 'group').ok, true);
  const scene = p.scene('__groupexport_composite__');
  assert.deepEqual([scene[0].visible, scene[0].layers[0].visible, scene[0].layers[0].layers[0].visible, scene[0].layers[0].layers[1].visible, scene[1].layers[0].visible],
    [true, true, false, true, false]);
  p.release();
});

test('children mode skips plain layers, only takes direct sub-folders, and explains empty or overlapping parents', () => {
  const c = photoshop({selected: [1]}).capture('children');
  assert.deepEqual(c.targets.map(t => t.id), [2], 'only B, not the folders nested inside it');
  assert.match(photoshop({selected: [11]}).capture('children').message, /「方案 01」下面没有子文件夹/);
  assert.match(photoshop({selected: [1, 2]}).capture('children').message, /互相包含/);
  assert.match(photoshop({selected: [4]}).capture('children').message, /普通图层/);
  assert.deepEqual(photoshop({selected: [2]}).capture().targets.map(t => t.id), [2], 'self mode is unchanged');
});

test('canvas export enables every ancestor, hides other selected folders, retains common content and source state', () => {
  const p = photoshop(), initial = JSON.stringify(p.source), c = p.capture(), r = p.render(c);
  assert.equal(r.ok, true); assert.equal(r.width, 800); assert.equal(r.height, 600);
  const scene = p.scene('__groupexport_composite__');
  assert.equal(scene[0].visible, true); assert.equal(scene[0].layers[0].visible, true);
  assert.equal(scene[0].layers[0].layers[0].visible, true); assert.equal(scene[0].layers[0].layers[1].visible, false);
  assert.equal(scene[1].layers[0].visible, false); assert.equal(scene[2].visible, true);
  assert.deepEqual(scene[0].mask, [30, 40, 210, 170]); assert.equal(scene[0].effect, 'shadow');
  assertPristine(p, initial);
});

test('folder crop uses the folder merged on its own (like Export As) and crops the shared-layer composite', () => {
  const p = photoshop(), initial = JSON.stringify(p.source), c = p.capture(), r = p.render(c, 11, 'group');
  assert.equal(r.ok, true); assert.equal(r.width, 200); assert.equal(r.height, 150);
  assert.deepEqual(r.rect, [20, 30, 220, 180]); assert.deepEqual(Object.keys(r.timing), ['duplicate', 'measure', 'composite', 'convert', 'save']);
  assert.deepEqual(p.merges, [[20, 30, 220, 180]], 'only the folder itself is measured, never the common background');
  assert.deepEqual(p.saves[0].rect, [20, 30, 220, 180]);
  assert.equal(p.scene('__groupexport_composite__')[2].visible, true, 'the common background survives in the final composite');
  const working = p.docs.find(d => d.name === '__groupexport_work__');
  assert.equal(working.layers[0].layers[0].layers.length, 2, 'the measuring copy is removed from the working document');
  assertPristine(p, initial);
});

test('one working copy serves the whole batch and its visibility is reset between folders', () => {
  const p = photoshop(), initial = JSON.stringify(p.source), c = p.capture();
  for (const id of [11, 12, 13]) assert.equal(p.render(c, id, 'group').ok, true);
  assert.equal(p.events.filter(e => e.name === '__groupexport_work__').length, 1);
  const third = p.scene('__groupexport_composite__');
  assert.equal(third[0].visible, false, '父组 A is back to hidden after the first two folders');
  assert.equal(third[0].layers[0].layers[0].visible, false); assert.equal(third[0].layers[0].layers[1].visible, false);
  assert.equal(third[1].visible, true); assert.equal(third[1].layers[0].visible, true);
  const working = p.docs.find(d => d.name === '__groupexport_work__');
  assert.deepEqual([working.layers[0].visible, working.layers[0].layers[0].layers[1].visible], [false, true]);
  assertPristine(p, initial);
});

test('a folder removed from the panel list stays hidden in the other exports', () => {
  const p = photoshop(), c = p.capture();
  assert.equal(p.render(c, 13, 'canvas', [13]).ok, true);
  const scene = p.scene('__groupexport_composite__');
  assert.equal(scene[0].layers[0].layers[1].visible, false, '方案 02 was visible in the PSD but is a captured variant');
  p.release();
});

test('nearest artboard supplies its exact viewport; an artboard folder exports the whole artboard', () => {
  const layers = [{id: 1, name: '画板', typename: 'LayerSet', visible: false, board: [-20, 10, 300, 250], background: 1,
    layers: [{id: 11, name: '方案', typename: 'LayerSet', visible: false, layers: [{id: 100, name: '图', typename: 'ArtLayer', visible: true, bounds: [30, 40, 100, 120]}]}]}];
  const p = photoshop({layers, selected: [11]}), c = p.capture(); assert.deepEqual(c.targets[0].rect, [-20, 10, 300, 250]);
  assert.equal(p.render(c).ok, true); assert.deepEqual(p.saves[0].rect, [-20, 10, 300, 250]);
  assert.equal(p.render(c, 11, 'group').ok, true); assert.deepEqual(p.saves[1].rect, [30, 40, 100, 120]);
  assert.equal(p.source.layers[0].background, 1); p.release();
  const q = photoshop({layers: JSON.parse(JSON.stringify(layers)), selected: [1]}), d = q.capture();
  assert.equal(d.targets[0].board, true);
  assert.equal(q.render(d, 1, 'group').ok, true); assert.deepEqual(q.saves[0].rect, [-20, 10, 300, 250]); assert.deepEqual(q.merges, []);
  q.release();
});

test('nested ancestor-and-child selection, ordinary layers and an empty selection are rejected', () => {
  assert.match(photoshop({selected: [1, 11]}).capture().message, /不能同时选择/);
  assert.match(photoshop({selected: [4]}).capture().message, /「公共背景」是普通图层/);
  assert.match(photoshop({selected: []}).capture().message, /至少一个文件夹/);
});

test('source edits and switching documents abort before creating temporary documents', () => {
  const p = photoshop(), c = p.capture(); p.edit(); assert.equal(p.render(c).ok, false); assert.equal(p.events.length, 0);
  const q = photoshop(), d = q.capture(); q.app.activeDocument = {id: -1}; assert.equal(q.render(d).ok, false); assert.equal(q.events.length, 0);
});

test('without history IDs the history fallback accepts an unchanged PSD and still catches edits', () => {
  const p = photoshop({noHistoryID: true}), c = p.capture();
  assert.equal(p.render(c).ok, true); p.release();
  p.edit(); assert.match(p.render(c).message, /已被修改/);
});

test('a renamed or moved target aborts even if the host history ID did not change', () => {
  const p = photoshop(), c = p.capture(); p.source.layers[0].layers[0].layers[0].name = 'renamed';
  assert.match(p.render(c).message, /结构已改变/); assert.equal(p.docs.length, 1);
  const q = photoshop(), d = q.capture(); q.source.layers[0].layers[0].layers.splice(1, 1);
  assert.match(q.render(d, 11).message, /结构已改变/, 'a removed captured folder is detected without a crash');
});

for (const step of ['duplicate', 'merge', 'save']) {
  test(step + ' failure closes all temporary documents and preserves source visibility, rulers and dialogs', () => {
    const p = photoshop(), initial = JSON.stringify(p.source), c = p.capture(); p.fail(step);
    assert.equal(p.render(c, 11, 'group').ok, false);
    assert.ok(p.docs.length <= 2); assertPristine(p, initial);
  });
}

test('transparent folder is an explicit error in group crop mode and the working copy is discarded', () => {
  const p = photoshop(), c = p.capture(); p.source.layers[0].layers[0].layers[0].layers[0].visible = false;
  const r = p.render(c, 11, 'group'); assert.equal(r.ok, false); assert.match(r.message, /没有可见内容/); assert.equal(p.docs.length, 1);
});

test('colour modes: bitmap goes through grayscale, 16-bit becomes 8-bit, 32-bit and multichannel are refused', () => {
  const p = photoshop({mode: 'BITMAP'}), c = p.capture(); assert.equal(p.render(c).ok, true);
  assert.deepEqual(p.saves[0].modes, ['GRAYSCALE', 'RGB']); assert.equal(p.saves[0].bits, 8); p.release();
  for (const [option, pattern] of [[{bits: 32}, /32 位/], [{mode: 'MULTICHANNEL'}, /多通道/]]) {
    const q = photoshop(option), d = q.capture(), r = q.render(d);
    assert.match(r.message, pattern); assert.equal(q.events.length, 0);
  }
});

test('invalid scope, token, unknown target, and duplicate IDs are rejected', () => {
  const p = photoshop(), c = p.capture();
  assert.equal(p.render(c, 11, 'unknown').ok, false);
  assert.equal(p.render({...c, token: 'old'}).ok, false);
  assert.equal(p.render(c, 123).ok, false);
  assert.equal(p.render(c, 11, 'canvas', [11, 11]).ok, false);
  assert.equal(p.docs.length, 1);
});
