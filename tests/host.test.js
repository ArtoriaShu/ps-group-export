'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../com.shu.groupexport/host/host.jsx'), 'utf8');

const R = (id, name, visible = true, bounds = [0, 0, 10, 10]) => ({id, name, visible, bounds, typename: 'ArtLayer'});
const G = (id, name, layers, visible = true, extra = {}) => Object.assign({id, name, visible, layers, typename: 'LayerSet'}, extra);
const clone = v => JSON.parse(JSON.stringify(v));
const visibleIds = layers => layers.flatMap(l => l.visible ? [l.id, ...(l.layers ? visibleIds(l.layers) : [])] : []);
const allVisibility = layers => layers.flatMap(l => [[l.id, l.visible], ...(l.layers ? allVisibility(l.layers) : [])]);

// A mock Photoshop. The original document is a layer tree; ActionManager reads go
// through a flat, bottom-up index list like Photoshop's (group start, children, end
// marker). Layer visibility is not part of history (Photoshop's default), so going back
// in history restores structure and the marquee but not visibility.
function photoshop(options = {}) {
  const initial = options.layers || [
    G(1, '父组 A', [G(2, 'B', [
      G(11, '方案 01', [R(101, '图', true, [20, 30, 220, 180])], false),
      G(12, '方案 02', [R(102, '图', true, [40, 50, 260, 200])], true)
    ], false)], false, {mask: [30, 40, 210, 170], effect: 'shadow'}),
    G(3, '父组 C', [G(13, '方案 03', [R(103, '图', true, [10, 10, 100, 100])])]),
    R(4, '公共背景', true, [0, 0, 800, 600])
  ];
  let nextId = 1000, fail = options.fail, domReads = 0, clipboard = null, nextState = 9;
  const events = [], saves = [], files = new Set(), docs = [], merges = [], executed = [];
  const selected = (options.selected || [11, 12, 13]).slice();
  const customOptions = {};
  const app = {documents: docs, activeDocument: null, displayDialogs: 'ALL', preferences: {rulerUnits: options.rulerUnits || 'CM'}, customOptions,
    putCustomOptions(key, d) { customOptions[key] = d; },
    getCustomOptions(key) { if (!customOptions[key]) throw new Error('no options'); return customOptions[key]; },
    eraseCustomOptions(key) { delete customOptions[key]; }};
  const unit = value => ({as: u => { assert.equal(u, 'px'); if (app.preferences.rulerUnits !== 'PIXELS') throw new Error('ruler units are not pixels'); return value; }});
  const tree = doc => doc.__tree;
  function flatten(layers) { return layers.flatMap(l => [l, ...(l.layers ? flatten(l.layers) : [])]); }
  function bounds(layers) {
    const boxes = layers.filter(l => l.visible).map(l => {
      let b = l.layers ? bounds(l.layers) : (l.bounds && typeof l.bounds[0] === 'number' ? l.bounds : null);
      if (b && l.mask) b = [Math.max(b[0], l.mask[0]), Math.max(b[1], l.mask[1]), Math.min(b[2], l.mask[2]), Math.min(b[3], l.mask[3])];
      if (l.board && l.background !== 3) b = l.board;
      return b;
    }).filter(b => b && b[2] > b[0] && b[3] > b[1]);
    if (!boxes.length) return [0, 0, 0, 0];
    return [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])), Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))];
  }
  function parentOf(doc, layer) {
    const walk = list => { if (list.includes(layer)) return list; for (const l of list) { if (l.layers) { const r = walk(l.layers); if (r) return r; } } return null; };
    return walk(tree(doc));
  }
  function decorate(doc, layers) {
    for (const layer of layers) {
      Object.defineProperty(layer, 'remove', {configurable: true, value() { const list = parentOf(doc, this); list.splice(list.indexOf(this), 1); }});
      Object.defineProperty(layer, 'duplicate', {configurable: true, value() {
        if (layer.layers && fail === 'merge') throw new Error('duplicate layer failed');
        const list = parentOf(doc, this), copy = clone(this); copy.id = nextId++; if (!copy.layers) copy.visible = true;
        decorate(doc, [copy]); list.splice(list.indexOf(this), 0, copy); selected.splice(0, selected.length, copy.id); return copy;
      }});
      if (!layer.layers) {
        Object.defineProperty(layer, 'rasterize', {configurable: true, value() { merges.push(this.bounds); this.bounds = this.bounds.map(unit); }});
        continue;
      }
      Object.defineProperty(layer, 'merge', {configurable: true, value() {
        const own = bounds([Object.assign({}, this, {visible: true})]);
        if (!(own[2] > own[0] && own[3] > own[1])) throw new Error('nothing to merge');
        merges.push(own);
        const list = parentOf(doc, this), merged = R(nextId++, 'merged group', true, own);
        merged.bounds = own.map(unit); decorate(doc, [merged]); list.splice(list.indexOf(this), 1, merged); return merged;
      }});
      decorate(doc, layer.layers);
    }
  }
  function document(name, layers, width = 800, height = 600) {
    const doc = {id: nextId++, name, width: unit(width), height: unit(height), mode: options.mode || 'RGB', bitsPerChannel: options.bits || 16,
      resolution: 72, saved: true, modes: []};
    let marquee = null, history = [{id: nextState++, snapshot: null}], current = 0;
    Object.defineProperty(doc, '__tree', {value: layers, writable: true});
    Object.defineProperty(doc, 'layers', {enumerable: true, get() { domReads++; return doc.__tree; }});
    Object.defineProperty(doc, '__history', {get: () => ({id: history[current].id, length: history.length})});
    Object.defineProperty(doc, '__edit', {value() { history = history.slice(0, current + 1); history.push({id: nextState++}); current++; }});
    Object.defineProperty(doc, 'activeLayer', {get: () => doc.__active || tree(doc)[0], set(v) { doc.__active = v; }});
    Object.defineProperty(doc, '__active', {writable: true, value: null});
    Object.defineProperty(doc, 'marquee', {get: () => marquee});
    Object.defineProperty(doc, 'activeHistoryState', {
      get: () => ({index: current}),
      set(state) {
        // Back in history: structure and marquee return, visibility does not.
        const target = history[state.index + 1];
        if (state.index < current && target && target.snapshot) {
          const live = new Map(allVisibility(tree(doc)));
          const restored = clone(target.snapshot.layers);
          const apply = list => list.forEach(l => { if (live.has(l.id)) l.visible = live.get(l.id); if (l.layers) apply(l.layers); });
          apply(restored); doc.__tree = restored; decorate(doc, restored); marquee = target.snapshot.marquee;
        }
        current = state.index;
      }});
    Object.defineProperty(doc, 'selection', {value: {
      select(region) { marquee = [region[0][0], region[0][1], region[2][0], region[2][1]]; },
      deselect() { marquee = null; },
      copy(merged) {
        assert.equal(merged, true);
        const all = bounds(tree(doc)), b = [Math.max(all[0], marquee[0]), Math.max(all[1], marquee[1]), Math.min(all[2], marquee[2]), Math.min(all[3], marquee[3])];
        events.push({name: 'copy', marquee: marquee.slice(), layers: clone(tree(doc))});
        if (!(b[2] > b[0] && b[3] > b[1])) throw new Error('No pixels were selected.');
        clipboard = {bounds: b};
      }}});
    Object.defineProperty(doc, 'suspendHistory', {value(title, code) {
      history = history.slice(0, current + 1);
      history.push({id: nextState++, snapshot: {layers: clone(tree(doc)), marquee}}); current++;
      vm.runInContext(code, ctx);
    }});
    Object.assign(doc, {
      crop(rect) { this.cropRect = Array.from(rect, v => v.as()); this.width = unit(this.cropRect[2] - this.cropRect[0]); this.height = unit(this.cropRect[3] - this.cropRect[1]); },
      changeMode(mode) { this.modes.push(mode); this.mode = mode; }, convertProfile() {},
      saveAs(file) { if (fail === 'save') throw new Error('save failed'); files.add(file.path); saves.push({doc: this, rect: this.cropRect, mode: this.mode, bits: this.bitsPerChannel, modes: this.modes, layers: tree(this).map(l => l.raw || l.bounds)}); },
      close() { docs.splice(docs.indexOf(this), 1); if (docs.length) app.activeDocument = docs[0]; }
    });
    decorate(doc, layers);
    docs.push(doc); return doc;
  }
  docs.add = function (w, h, resolution, name, mode, fill, ratio, bits) {
    if (fail === 'add') throw new Error('new document failed');
    const d = document(name, [R(nextId++, '图层 1', true, [0, 0, 0, 0])], w.as(), h.as());
    d.mode = mode; d.bitsPerChannel = bits; d.created = {mode, bits}; app.activeDocument = d; return d;
  };
  const source = document('示例.psd', initial); source.id = 50; app.activeDocument = source;
  if (options.colorProfile !== false) source.colorProfileName = 'Adobe RGB (1998)';
  const docOf = () => app.activeDocument;
  // Bottom-up flat list: index 1 is the bottom; a group is [end, ...children, start].
  function flat(layers) {
    const out = [];
    for (const l of layers.slice().reverse()) {
      if (l.layers) { out.push({section: 'layerSectionEnd', layer: {id: -l.id, name: '</Layer group>'}}); out.push(...flat(l.layers)); out.push({section: 'layerSectionStart', layer: l}); }
      else out.push({section: 'layerSectionContent', layer: l});
    }
    return out;
  }
  let indexReads = 0;
  function ActionReference() {}
  ActionReference.prototype.putProperty = function (c, p) { this.cls = c; this.property = p; };
  ActionReference.prototype.putIdentifier = function (c, id) { this.id = id; };
  ActionReference.prototype.putIndex = function (c, i) { this.index = i; };
  ActionReference.prototype.putEnumerated = function (c) { this.type = c; };
  function ActionDescriptor() { this.data = {}; }
  for (const m of ['putString', 'putBoolean', 'putList', 'putReference', 'putInteger']) ActionDescriptor.prototype[m] = function (k, v) { this.data[k] = v; };
  ActionDescriptor.prototype.putEnumerated = function (k, t, v) { this.data[k] = v; };
  ActionDescriptor.prototype.getString = function (k) { return this.data[k]; };
  function ActionList() { this.items = []; }
  ActionList.prototype.putReference = function (r) { this.items.push(r); };
  function layerDescriptor(entry, property) {
    const layer = entry.layer;
    if (property === 'layerSection') return {getEnumerationValue: () => entry.section};
    if (property === 'layerID') return {getInteger: () => layer.id};
    if (property === 'name') return {getString: () => layer.name};
    if (property === 'visible') return {getBoolean: () => layer.visible};
    if (property === 'artboardEnabled') return {hasKey: () => true, getBoolean: () => !!layer.board};
    if (property === 'artboard') return {getObjectValue: () => ({getObjectValue: () => ({getUnitDoubleValue: key => layer.board[{left: 0, top: 1, right: 2, bottom: 3}[key]]})})};
    throw new Error('Unexpected layer property ' + property);
  }
  function executeActionGet(ref) {
    const doc = docOf();
    if (ref.property === 'targetLayersIDs') {
      if (options.noTargetIDs) return {hasKey: () => false};
      return {hasKey: () => true, getList: () => ({count: selected.length, getReference: i => ({getIdentifier: () => selected[i]})})};
    }
    if (ref.property === 'targetLayers') {
      const list = flat(tree(doc)), indexes = selected.map(id => list.findIndex(e => e.layer.id === id)); // 0-based from the bottom
      return {hasKey: () => true, getList: () => ({count: indexes.length, getReference: i => ({getIndex: () => indexes[i]})})};
    }
    if (ref.cls === 'historyState' || ref.type === 'historyState') return {hasKey: () => !options.noHistoryID, getInteger: () => doc.__history.id};
    if (ref.type === 'document') {
      if (ref.property === 'numberOfLayers') return {getInteger: () => flat(tree(doc)).length};
      if (ref.property === 'hasBackgroundLayer') return {getBoolean: () => false};
      throw new Error('Unexpected document property ' + ref.property);
    }
    if (ref.index !== undefined) {
      indexReads++;
      const list = flat(tree(doc)), entry = list[ref.index - 1];
      if (!entry) throw new Error('No layer at index ' + ref.index);
      return layerDescriptor(entry, ref.property);
    }
    const layer = flatten(tree(doc)).find(l => l.id === ref.id);
    if (!layer) throw new Error('No such layer ' + ref.id);
    return layerDescriptor({layer, section: layer.layers ? 'layerSectionStart' : 'layerSectionContent'}, ref.property);
  }
  function executeAction(id, desc) {
    const doc = docOf();
    executed.push(id);
    if (id === 'hide' || id === 'show') {
      for (const r of desc.data.null.items) { const l = flatten(tree(doc)).find(x => x.id === r.id); if (!l) throw new Error('no layer'); l.visible = id === 'show'; }
      return;
    }
    if (id === 'paste') {
      if (fail === 'paste') throw new Error('paste failed');
      const b = desc.data.inPlace ? clipboard.bounds : [0, 0, clipboard.bounds[2] - clipboard.bounds[0], clipboard.bounds[3] - clipboard.bounds[1]];
      const layer = R(nextId++, '图层 2', true, b.map(unit)); Object.defineProperty(layer, 'raw', {value: b}); tree(doc).unshift(layer); decorate(doc, [layer]); doc.activeLayer = layer; return;
    }
    if (id === 'select') { if (!desc.data.selectionModifier) selected.length = 0; selected.push(desc.data.null.id); return; }
    if (id === 'selectNoLayers') { selected.length = 0; return; }
    throw new Error('Unexpected action ' + id);
  }
  function File(p) { this.path = p; this.parent = {exists: true}; Object.defineProperty(this, 'exists', {get: () => files.has(p)}); }
  const globals = () => ({app, stringIDToTypeID: s => s, charIDToTypeID: s => s, ActionReference, ActionDescriptor, ActionList,
    executeActionGet, executeAction, File, UnitValue: function (v, u) { assert.equal(u, 'px'); this.as = () => v; },
    PNGSaveOptions: function () {}, Units: {PIXELS: 'PIXELS'}, RasterizeType: {ENTIRELAYER: 'ENTIRELAYER'},
    DialogModes: {NO: 'NO'}, SaveOptions: {DONOTSAVECHANGES: 'NO_SAVE'}, DocumentFill: {TRANSPARENT: 'TRANSPARENT'},
    DocumentMode: {RGB: 'RGB', BITMAP: 'BITMAP', GRAYSCALE: 'GRAYSCALE', MULTICHANNEL: 'MULTICHANNEL', CMYK: 'CMYK', LAB: 'LAB', INDEXEDCOLOR: 'INDEXEDCOLOR'},
    NewDocumentMode: {RGB: 'RGB', GRAYSCALE: 'GRAYSCALE', CMYK: 'CMYK', LAB: 'LAB'},
    ChangeMode: {RGB: 'RGB', GRAYSCALE: 'GRAYSCALE'}, BitsPerChannelType: {EIGHT: 8, SIXTEEN: 16, THIRTYTWO: 32}, Intent: {RELATIVECOLORIMETRIC: 0}, Extension: {LOWERCASE: 0}});
  let ctx = vm.createContext(globals());
  vm.runInContext(script, ctx);
  // The panel was reloaded: a fresh host-script instance in the same Photoshop session.
  const reload = () => { ctx = vm.createContext(globals()); vm.runInContext(script, ctx); };
  const invoke = expression => JSON.parse(vm.runInContext(expression, ctx));
  const capture = mode => invoke('GroupExporter.capture(' + (mode ? JSON.stringify(mode) : '') + ')');
  const render = (capture, id = 11, scope = 'canvas', ids = capture.targets.map(t => t.id)) => {
    files.clear();
    return invoke(`GroupExporter.render(${JSON.stringify(capture.token)},${JSON.stringify(ids)},${id},${JSON.stringify(scope)},"/tmp/out.png")`);
  };
  const release = () => invoke('GroupExporter.release()');
  const scene = () => events.filter(e => e.name === 'copy').pop().layers;
  return {reload, source, app, events, saves, docs, merges, selected, executed, capture, render, release, scene, invoke,
    reads: () => ({dom: domReads, index: indexReads}), edit: () => source.__edit(), fail: value => { fail = value; }};
}

// The original after export: same tree, visibility, layer selection, history position,
// no marquee, rulers and dialogs back, and no temporary documents.
function assertPristine(p, initial, selection = [11, 12, 13], state = null) {
  assert.equal(p.release().ok, true);
  assert.equal(p.docs.length, 1, 'only the original is open'); assert.equal(JSON.stringify(p.source), initial);
  assert.deepEqual(p.selected, selection, 'layer selection restored');
  assert.equal(p.source.marquee, null, 'marquee restored');
  if (state !== null) assert.equal(p.source.__history.id, state, 'history back where it was');
  assert.equal(p.app.activeDocument, p.source); assert.equal(p.app.displayDialogs, 'ALL'); assert.equal(p.app.preferences.rulerUnits, 'CM');
  assert.deepEqual(p.app.customOptions, {}, 'no temporary documents left registered');
}

test('captures nested folders across multiple parents with their exact names and full paths', () => {
  const p = photoshop(), c = p.capture(); assert.equal(c.ok, true);
  assert.deepEqual(c.targets.map(t => [t.id, t.name, t.path, t.breadcrumb]), [
    [11, '方案 01', [0, 0, 0], '父组 A / B / 方案 01'],
    [12, '方案 02', [0, 0, 1], '父组 A / B / 方案 02'],
    [13, '方案 03', [1, 0], '父组 C / 方案 03']
  ]);
  assert.deepEqual(c.targets.map(t => t.parent), ['B', 'B', '父组 C']);
  assert.deepEqual(c.targets.map(t => t.chain), [[1, 2, 11], [1, 2, 12], [3, 13]]);
  assert.equal(p.app.preferences.rulerUnits, 'CM', 'ruler units are restored after reading');
});

test('reading never walks the DOM layer tree, so collapsed groups and big PSDs make no difference', () => {
  for (const mode of [undefined, 'children']) {
    const p = photoshop({selected: mode ? [2, 3] : [11, 12, 13]}), before = p.reads().dom;
    assert.equal(p.capture(mode).ok, true);
    assert.equal(p.reads().dom, before, 'no DOM layer access while reading');
  }
  // The pass stops once every selected layer is found: here after the first group.
  const many = [G(1, '切图', [R(11, 'a'), R(12, 'b')]), ...Array.from({length: 200}, (_, i) => R(100 + i, '其他 ' + i))];
  const q = photoshop({layers: many, selected: [1]}), c = q.capture('children');
  assert.deepEqual(c.targets.map(t => t.id), [11, 12]);
  assert.ok(q.reads().index < 12, 'only the top of a 204-entry layer list is read (' + q.reads().index + ')');
});

test('hosts without targetLayersIDs read the selection from targetLayers indexes', () => {
  const p = photoshop({noTargetIDs: true}), c = p.capture();
  assert.deepEqual(c.targets.map(t => t.id), [11, 12, 13]);
});

test('Shift-selecting expanded folders also selects their inner layers: those are ignored', () => {
  const p = photoshop({selected: [11, 101, 12, 102]}), c = p.capture();
  assert.equal(c.ok, true); assert.deepEqual(c.targets.map(t => t.id), [11, 12]); assert.equal(c.ignored, 2);
  const q = photoshop({selected: [2, 11, 12, 3]}), d = q.capture('children');
  assert.deepEqual(d.targets.map(t => t.id), [11, 12, 13], 'children mode: inner selections under a selected parent are ignored');
  assert.deepEqual(photoshop({selected: [1, 11]}).capture().targets.map(t => t.id), [1], 'a group with a selected inner layer exports the group');
});

test('children mode turns each selected parent into its direct sub-folders, across parents', () => {
  const p = photoshop({selected: [2, 3]}), initial = JSON.stringify(p.source), c = p.capture('children'); assert.equal(c.ok, true);
  assert.deepEqual(c.targets.map(t => [t.id, t.path, t.breadcrumb]), [
    [11, [0, 0, 0], '父组 A / B / 方案 01'], [12, [0, 0, 1], '父组 A / B / 方案 02'], [13, [1, 0], '父组 C / 方案 03']
  ]);
  assert.equal(p.render(c, 12, 'group').ok, true);
  const scene = p.scene();
  assert.deepEqual([scene[0].visible, scene[0].layers[0].visible, scene[0].layers[0].layers[0].visible, scene[0].layers[0].layers[1].visible, scene[1].layers[0].visible],
    [true, true, false, true, false]);
  assertPristine(p, initial, [2, 3]);
});

test('the other folders\' parent groups are hidden whole, shared ancestors and common layers stay', () => {
  const layers = [
    G(1, 'A', [
      G(2, 'B', [G(11, '图层 01', [R(101, '图')]), G(12, '图层 02', [R(102, '图')], false)]),
      G(3, 'C', [R(31, '底图'), G(13, '图层 03', [R(103, '图')], false)])
    ]),
    R(4, '公共背景')
  ];
  const both = photoshop({layers: clone(layers), selected: [2, 3]}).capture('children');
  assert.deepEqual(both.targets.map(t => t.id), [11, 12, 31, 13], 'selecting parents reads their plain layers too (C/底图)');
  const p = photoshop({layers: clone(layers), selected: [11, 12, 13]});
  const initial = JSON.stringify(p.source), c = p.capture();
  assert.equal(p.render(c, 11).ok, true);
  let scene = p.scene();
  assert.deepEqual([scene[0].visible, scene[0].layers[0].visible, scene[0].layers[1].visible, scene[1].visible], [true, true, false, true],
    'exporting B/图层 01: A and B on, C (with its 底图) off, common background on');
  assert.equal(scene[0].layers[0].layers[1].visible, false, 'the sibling in the same parent is hidden, not the parent');
  assert.equal(p.render(c, 13).ok, true);
  scene = p.scene();
  assert.deepEqual([scene[0].visible, scene[0].layers[0].visible, scene[0].layers[1].visible, scene[0].layers[1].layers[0].visible, scene[0].layers[1].layers[1].visible],
    [true, false, true, true, true], 'exporting C/图层 03: B off, C and its 底图 on');
  assertPristine(p, initial);
});

test('plain layers export like folders: others hidden, parent shown, crop by the layer\'s own pixels', () => {
  const layers = [G(2, '切图', [R(21, '按钮', false, [10, 20, 60, 50]), R(22, '图标', true, [100, 100, 132, 132])], false), R(4, '公共背景', true, [0, 0, 800, 600])];
  const p = photoshop({layers, selected: [2]}), initial = JSON.stringify(p.source), c = p.capture('children');
  assert.deepEqual(c.targets.map(t => [t.id, t.kind, t.parent]), [[21, 'layer', '切图'], [22, 'layer', '切图']]);
  const res = p.render(c, 21, 'group'); assert.equal(res.ok, true);
  assert.deepEqual(p.saves[0].rect, [10, 20, 60, 50]); assert.deepEqual([res.width, res.height], [50, 30]);
  const scene = p.scene();
  assert.deepEqual([scene[0].visible, scene[0].layers[0].visible, scene[0].layers[1].visible, scene[1].visible], [true, true, false, true]);
  assert.equal(scene[0].layers.length, 2, 'the measuring copy is gone before copying');
  assert.deepEqual(photoshop({layers: clone(layers), selected: [21, 22]}).capture().targets.map(t => t.id), [21, 22], 'plain layers can be selected directly');
  assertPristine(p, initial, [2]);
});

test('children mode takes direct children only (folders and plain layers) and explains empty or overlapping parents', () => {
  assert.deepEqual(photoshop({selected: [1]}).capture('children').targets.map(t => t.id), [2], 'only B, not the folders nested inside it');
  assert.deepEqual(photoshop({selected: [11]}).capture('children').targets.map(t => [t.id, t.kind]), [[101, 'layer']], 'plain layers under a parent are read too');
  assert.deepEqual(photoshop({selected: [1, 2]}).capture('children').targets.map(t => t.id), [2], 'a parent inside another selected parent is ignored');
  assert.match(photoshop({selected: [4]}).capture('children').message, /下面没有可导出的图层/);
  assert.deepEqual(photoshop({selected: [2]}).capture().targets.map(t => t.id), [2], 'self mode is unchanged');
});

test('canvas export: copies the whole canvas composite with ancestors on and other targets off, original untouched', () => {
  const p = photoshop(), initial = JSON.stringify(p.source), state = p.source.__history.id, c = p.capture(), r = p.render(c);
  assert.equal(r.ok, true); assert.equal(r.width, 800); assert.equal(r.height, 600);
  const copy = p.events.filter(e => e.name === 'copy').pop(), scene = copy.layers;
  assert.deepEqual(copy.marquee, [0, 0, 800, 600]);
  assert.equal(scene[0].visible, true); assert.equal(scene[0].layers[0].visible, true);
  assert.equal(scene[0].layers[0].layers[0].visible, true); assert.equal(scene[0].layers[0].layers[1].visible, false);
  assert.equal(scene[1].layers[0].visible, false); assert.equal(scene[2].visible, true);
  assert.deepEqual(scene[0].mask, [30, 40, 210, 170]); assert.equal(scene[0].effect, 'shadow');
  assert.equal(p.events.filter(e => e.name !== 'copy').length, 0, 'the PSD is never duplicated');
  assert.equal(p.saves[0].bits, 8); assert.deepEqual(p.saves[0].rect, [0, 0, 800, 600]);
  assertPristine(p, initial, [11, 12, 13], state);
});

test('folder crop uses the folder merged on its own (like Export As), then copies only that area', () => {
  const p = photoshop(), initial = JSON.stringify(p.source), c = p.capture(), r = p.render(c, 11, 'group');
  assert.equal(r.ok, true); assert.equal(r.width, 200); assert.equal(r.height, 150);
  assert.deepEqual(r.rect, [20, 30, 220, 180]);
  assert.deepEqual(Object.keys(r.timing), ['check', 'show', 'measure', 'copy', 'restore', 'compose', 'convert', 'save']);
  assert.deepEqual(p.merges, [[20, 30, 220, 180]], 'only the folder itself is measured, never the common background');
  assert.deepEqual(p.events.filter(e => e.name === 'copy').pop().marquee, [20, 30, 220, 180], 'Copy Merged reads only the crop area');
  assert.deepEqual(p.saves[0].rect, [20, 30, 220, 180]);
  assert.equal(p.scene()[2].visible, true, 'the common background is part of the composite');
  assert.equal(p.scene()[0].layers[0].layers[0].layers.length, 1, 'the measuring copy is removed before copying');
  assertPristine(p, initial);
});

test('every image starts from the PSD state: visibility from the previous image never carries over', () => {
  const p = photoshop(), initial = JSON.stringify(p.source), state = p.source.__history.id, c = p.capture();
  for (const id of [11, 12, 13]) assert.equal(p.render(c, id, 'group').ok, true);
  const third = p.scene();
  assert.equal(third[0].visible, false, '父组 A is back to hidden after the first two folders');
  assert.equal(third[0].layers[0].layers[0].visible, false); assert.equal(third[0].layers[0].layers[1].visible, false);
  assert.equal(third[1].visible, true); assert.equal(third[1].layers[0].visible, true);
  assertPristine(p, initial, [11, 12, 13], state);
});

test('a folder removed from the panel list stays hidden in the other exports', () => {
  const p = photoshop(), c = p.capture();
  assert.equal(p.render(c, 13, 'canvas', [13]).ok, true);
  assert.equal(p.scene()[0].layers[0].layers[1].visible, false, '方案 02 was visible in the PSD but is a captured variant');
});

test('nearest artboard supplies its exact viewport; an artboard folder exports the whole artboard', () => {
  const layers = [G(1, '画板', [G(11, '方案', [R(100, '图', true, [30, 40, 100, 120])], false)], false, {board: [-20, 10, 300, 250], background: 1})];
  const p = photoshop({layers, selected: [11]}), c = p.capture(); assert.deepEqual(c.targets[0].rect, [-20, 10, 300, 250]);
  assert.equal(p.render(c).ok, true); assert.deepEqual(p.saves[0].rect, [-20, 10, 300, 250]);
  assert.deepEqual(p.events.filter(e => e.name === 'copy').pop().marquee, [0, 10, 300, 250], 'the copy area is clipped to the canvas');
  assert.deepEqual(p.saves[0].layers[0], [0, 10, 300, 250], 'pasted in place before the crop');
  assert.equal(p.render(c, 11, 'group').ok, true); assert.deepEqual(p.saves[1].rect, [30, 40, 100, 120]);
  assert.equal(p.source.layers[0].background, 1);
  const q = photoshop({layers: clone(layers), selected: [1]}), d = q.capture();
  assert.equal(d.targets[0].board, true);
  assert.equal(q.render(d, 1, 'group').ok, true); assert.deepEqual(q.saves[0].rect, [-20, 10, 300, 250]); assert.deepEqual(q.merges, []);
});

test('pasted pixels keep their position in the temporary document', () => {
  const p = photoshop(), c = p.capture(); assert.equal(p.render(c, 11, 'group').ok, true);
  const pasted = p.saves[0].layers[0];
  assert.deepEqual(pasted, [20, 30, 220, 180], 'the copied area sits at its PSD position before the crop');
  assert.ok(p.executed.includes('paste'));
});

test('an empty canvas area exports a transparent image instead of failing', () => {
  const layers = [G(1, '组', [G(11, '空', [R(101, '图', false)]), G(12, '有', [R(102, '图')])])];
  const p = photoshop({layers, selected: [11, 12]}), c = p.capture(), r = p.render(c, 11);
  assert.equal(r.ok, true); assert.equal(r.empty, true); assert.deepEqual([r.width, r.height], [800, 600]);
  assert.ok(!p.executed.includes('paste'));
});

test('an empty selection is rejected; a plain layer is accepted', () => {
  assert.deepEqual(photoshop({selected: [4]}).capture().targets.map(t => [t.id, t.kind]), [[4, 'layer']], 'a plain layer is a valid target');
  assert.match(photoshop({selected: []}).capture().message, /至少一个图层/);
  assert.match(photoshop({selected: [999]}).capture().message, /选中的图层/);
});

test('source edits and switching documents abort before touching anything', () => {
  const p = photoshop(), c = p.capture(); p.edit(); assert.match(p.render(c).message, /已被修改/); assert.equal(p.events.length, 0);
  const q = photoshop(), d = q.capture(); q.app.activeDocument = {id: -1}; assert.equal(q.render(d).ok, false); assert.equal(q.events.length, 0);
});

test('history IDs: an unchanged PSD exports image after image (our own step is rolled back each time)', () => {
  const p = photoshop(), c = p.capture();
  assert.equal(p.render(c, 11).ok, true); assert.equal(p.render(c, 12).ok, true); assert.equal(p.render(c, 13).ok, true);
});

test('without history IDs every image reads the live PSD, and renamed or removed targets are caught', () => {
  const p = photoshop({noHistoryID: true}), c = p.capture();
  assert.equal(p.render(c, 11, 'group').ok, true);
  p.source.__tree[0].layers[0].layers[1].layers[0].bounds = [50, 60, 150, 160]; // pixels change
  const r = p.render(c, 12, 'group'); assert.equal(r.ok, true);
  assert.deepEqual(r.rect, [50, 60, 150, 160], 'the edited content is what gets exported');
  p.source.__tree[0].layers[0].layers[0].name = 'renamed';
  assert.match(p.render(c, 12).message, /结构已改变/);
  const q = photoshop({noHistoryID: true}), d = q.capture(); q.source.__tree[0].layers[0].layers.splice(1, 1);
  assert.match(q.render(d, 11).message, /结构已改变/, 'a removed captured folder is detected without a crash');
});

for (const step of ['merge', 'add', 'paste', 'save']) {
  test(step + ' failure closes the temporary document and restores the PSD: visibility, structure, selection, history', () => {
    const p = photoshop(), initial = JSON.stringify(p.source), state = p.source.__history.id, c = p.capture(); p.fail(step);
    assert.equal(p.render(c, 11, 'group').ok, false);
    assertPristine(p, initial, [11, 12, 13], state);
  });
}

test('transparent folder is an explicit error in group crop mode and the PSD is restored', () => {
  const p = photoshop(), c = p.capture(); p.source.__tree[0].layers[0].layers[0].layers[0].visible = false;
  const initial = JSON.stringify(p.source);
  const r = p.render(c, 11, 'group'); assert.equal(r.ok, false); assert.match(r.message, /没有可见内容/);
  assertPristine(p, initial);
});

test('colour modes: same-mode temporary document, bitmap via grayscale, 16-bit becomes 8-bit, 32-bit and multichannel are refused', () => {
  const p = photoshop(), c = p.capture(); assert.equal(p.render(c).ok, true);
  assert.deepEqual(p.saves[0].doc.created, {mode: 'RGB', bits: 16}); assert.equal(p.saves[0].bits, 8);
  const b = photoshop({mode: 'BITMAP'}), d = b.capture(); assert.equal(b.render(d).ok, true);
  assert.deepEqual(b.saves[0].doc.created, {mode: 'GRAYSCALE', bits: 8}); assert.deepEqual(b.saves[0].modes, ['RGB']);
  const k = photoshop({mode: 'CMYK', bits: 8}), e = k.capture(); assert.equal(k.render(e).ok, true);
  assert.deepEqual(k.saves[0].doc.created, {mode: 'CMYK', bits: 8}); assert.deepEqual(k.saves[0].modes, ['RGB']);
  for (const [option, pattern] of [[{bits: 32}, /32 位/], [{mode: 'MULTICHANNEL'}, /多通道/]]) {
    const q = photoshop(option), f = q.capture(), r = q.render(f);
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

// ---- Review findings (CODE_REVIEW.md, 2026-11-17) ----

test('P1: another target nested under a different root hides that whole root, not just its parent', () => {
  const layers = [G(1, 'A', [G(2, 'B', [G(11, '图层 1', [R(101, '图')])]), R(5, 'A 专属底图')]), G(3, 'C', [G(4, 'D', [G(12, '图层 2', [R(102, '图')])])]), R(9, '公共背景')];
  const p = photoshop({layers, selected: [11, 12]}), initial = JSON.stringify(p.source), c = p.capture();
  assert.equal(p.render(c, 12).ok, true);
  let shown = visibleIds(p.scene());
  assert.ok(!shown.includes(1) && !shown.includes(5), 'A and its own background are hidden while exporting 图层 2');
  assert.ok(shown.includes(3) && shown.includes(4) && shown.includes(12) && shown.includes(9));
  assert.equal(p.render(c, 11).ok, true);
  shown = visibleIds(p.scene());
  assert.ok(shown.includes(5) && !shown.includes(3), 'exporting 图层 1 keeps A 专属底图 and hides C');
  assertPristine(p, initial, [11, 12]);
});

test('P1: two branches under one shared ancestor hide each other but keep the shared logo', () => {
  const layers = [G(1, 'A', [R(7, '公共 Logo'), G(2, 'B', [R(21, 'B 装饰'), G(11, '图层 1', [R(101, '图')])]), G(3, 'C', [R(31, 'C 装饰'), G(12, '图层 2', [R(102, '图')])])])];
  const p = photoshop({layers, selected: [11, 12]}), initial = JSON.stringify(p.source), c = p.capture();
  assert.equal(p.render(c, 11).ok, true);
  const first = visibleIds(p.scene());
  assert.deepEqual([first.includes(7), first.includes(21), first.includes(31)], [true, true, false]);
  assert.equal(p.render(c, 12).ok, true);
  const second = visibleIds(p.scene());
  assert.deepEqual([second.includes(7), second.includes(21), second.includes(31), second.includes(11)], [true, false, true, false], 'nothing carries over from the previous image');
  assertPristine(p, initial, [11, 12]);
});

test('P2: after a panel reload, a temporary document this plugin registered is closed', () => {
  const p = photoshop(), c = p.capture(); p.fail('save');
  // Simulate a crash mid-export: the temporary document is created and registered, then the panel dies.
  p.app.preferences.rulerUnits = 'PIXELS';
  const left = p.docs.add({as: () => 10}, {as: () => 10}, 72, '__groupexport_composite__', 'RGB', 'TRANSPARENT', 1, 8);
  p.app.preferences.rulerUnits = 'CM'; p.app.activeDocument = p.source;
  const d = new (function () { this.data = {}; this.getString = k => this.data[k]; })(); d.data.documentIDs = String(left.id);
  p.app.customOptions['com.shu.groupexport.temporaryDocuments'] = d;
  p.reload();
  assert.equal(p.release().ok, true, 'start-up recovery');
  assert.deepEqual(p.docs.map(x => x.name), ['示例.psd']); assert.equal(p.app.activeDocument, p.source);
  assert.deepEqual(p.app.customOptions, {}, 'registry emptied'); assert.ok(c.ok);
});

test('P2 follow-up: a user document that only shares the reserved name is never closed', () => {
  for (const name of ['__groupexport_work__', '__groupexport_composite__']) {
    const p = photoshop();
    p.app.preferences.rulerUnits = 'PIXELS'; const user = p.docs.add({as: () => 10}, {as: () => 10}, 72, name, 'RGB', 'TRANSPARENT', 1, 8); p.app.preferences.rulerUnits = 'CM';
    user.saved = false; p.app.activeDocument = p.source;
    assert.equal(p.release().ok, true); assert.ok(p.docs.includes(user), name + ' kept on release');
    assert.equal(p.capture().ok, true); assert.ok(p.docs.includes(user), name + ' kept on read');
    p.reload(); assert.equal(p.release().ok, true); assert.ok(p.docs.includes(user), name + ' kept after reload');
  }
});

test('P2 follow-up: a source PSD named like a temporary document is never closed, even if once registered', () => {
  const p = photoshop(); p.source.name = '__groupexport_composite__';
  const c = p.capture(); assert.equal(c.ok, true);
  assert.equal(p.render(c, 11).ok, true); p.release();
  assert.ok(p.docs.includes(p.source));
  const d = new (function () { this.data = {}; this.getString = k => this.data[k]; })(); d.data.documentIDs = String(p.source.id);
  p.app.customOptions['com.shu.groupexport.temporaryDocuments'] = d;
  p.reload(); assert.equal(p.release().ok, true); assert.ok(p.docs.includes(p.source), 'the active document is never closed');
  assert.equal(p.capture().ok, true); assert.ok(p.docs.includes(p.source));
});
