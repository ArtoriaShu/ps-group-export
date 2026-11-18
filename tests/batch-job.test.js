'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const job = require('../com.shu.groupexport/js/batch-job');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1cAAAAASUVORK5CYII=', 'base64');
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'groupexport-test-'));
  const output = path.join(root, 'output'); fs.mkdirSync(output);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const renders = [], callbacks = [], releases = [];
  const hostObject = {
    validate(token, ids) { assert.equal(token, 'capture-1'); assert.deepEqual(Array.from(ids), [11, 12]); return {ok: !options.invalid, message: 'PSD changed'}; },
    render(token, ids, id, scope, destination) {
      renders.push({id, scope});
      if (options.renderError) return {ok: false, message: 'render failed'};
      fs.writeFileSync(destination, options.corrupt ? PNG.subarray(0, 40) : PNG);
      return {ok: true, width: options.wrongSize ? 2 : 1, height: 1};
    },
    release() { releases.push(renders.length); return options.releaseError ? {ok: false, message: 'close failed'} : {ok: true}; }
  };
  const dependencies = {fs, path, os: {tmpdir: () => root}, setTimeout,
    host(script, callback) {
      const result = vm.runInNewContext(script, {GroupExporter: hostObject});
      if (options.holdRender && script.includes('.render(')) callbacks.push(() => callback(result));
      else callback(result);
    }};
  const request = {token: 'capture-1', targets: [{id: 11, name: '方案'}, {id: 12, name: '方案'}], directory: output, scope: 'group'};
  return {root, output, dependencies, request, renders, callbacks, releases};
}
function run(o, request) {
  return new Promise(resolve => job.run(o, request, (error, result) => resolve({error, result})));
}

test('names preserve Chinese, handle invalid Windows names, and never escape the output directory', () => {
  assert.equal(job.fileName('方案 A1'), '方案 A1.png');
  assert.equal(job.fileName('../../A:*?"<>|\\'), '.._.._A________.png');
  assert.equal(job.fileName('CON'), '_CON.png');
  assert.equal(job.fileName('com1.txt'), '_com1.txt.png');
  assert.equal(job.fileName('方案.  '), '方案.png');
  assert.equal(job.fileName('...'), '未命名.png');
  assert.ok(job.fileName('a'.repeat(119) + '🙂').endsWith('a.png'));
});

test('exports independently in sequence, collision numbering keeps existing files intact, temp files removed', async t => {
  const s = setup(t); fs.writeFileSync(path.join(s.output, '方案.png'), 'existing');
  const {error, result} = await run(s.dependencies, s.request);
  assert.ifError(error); assert.equal(result.records.length, 2);
  assert.deepEqual(s.renders, [{id: 11, scope: 'group'}, {id: 12, scope: 'group'}]);
  assert.deepEqual(result.records.map(r => path.basename(r.file)), ['方案 (2).png', '方案 (3).png']);
  assert.equal(fs.readFileSync(path.join(s.output, '方案.png'), 'utf8'), 'existing');
  assert.deepEqual(fs.readdirSync(s.root), ['output']);
  assert.deepEqual(s.releases, [2], 'the shared working copy is released once, after the last image');
});

test('byParent saves into a folder named after each parent group, created when missing; top-level folders stay in the base', async t => {
  const s = setup(t); s.request.byParent = true;
  s.request.targets = [{id: 11, name: '方案', parent: 'B:组'}, {id: 12, name: '方案', parent: ''}];
  s.dependencies.host = (script, callback) => callback(vm.runInNewContext(script.replace('[11,12]', '[11,12]'), {GroupExporter: Object.assign({}, {
    validate: () => ({ok: true}), release: () => ({ok: true}),
    render: (token, ids, id, scope, destination) => { fs.writeFileSync(destination, PNG); return {ok: true, width: 1, height: 1}; }})}));
  const {error, result} = await run(s.dependencies, s.request);
  assert.ifError(error);
  assert.deepEqual(result.records.map(r => path.relative(s.output, r.file)), [path.join('B_组', '方案.png'), '方案.png']);
});

test('byParent refuses to replace a file that has the parent folder name', t => {
  const s = setup(t); fs.writeFileSync(path.join(s.output, 'B'), 'file');
  assert.throws(() => job.outputDirectory(fs, path, s.output, {parent: 'B'}, true), /同名文件/);
  assert.equal(job.outputDirectory(fs, path, s.output, {parent: 'B'}, false), s.output);
});

test('the run log records start, each render with its timing, saves and the end', async t => {
  const s = setup(t), entries = [];
  const log = {}; for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (event, message, data) => entries.push({level, event, message, data});
  s.dependencies.log = log;
  const {error} = await run(s.dependencies, s.request); assert.ifError(error);
  assert.deepEqual(entries.filter(e => e.level !== 'debug').map(e => e.event), ['batch.start', 'render', 'render.done', 'save', 'render', 'render.done', 'save', 'batch.end']);
});

test('the file logger writes a daily log in the chosen folder', t => {
  const s = setup(t), logger = require('../com.shu.groupexport/js/logger').create({fs, path, dir: path.join(s.root, 'logs', 'nested')});
  logger.info('panel.start', '面板启动', {a: 1});
  const files = fs.readdirSync(path.join(s.root, 'logs', 'nested'));
  assert.equal(files.length, 1); assert.match(files[0], /^groupexport-\d{4}-\d{2}-\d{2}\.log$/);
  const text = require('../com.shu.groupexport/js/diagnostics').bundle({version: '1.2.0', environment: {ok: true}, state: {}, entries: logger.entries(), logFile: logger.file()});
  assert.match(text, /面板启动/); assert.match(text, /图层组分批导出 诊断信息/);
});

test('canvas mode reaches the host without changing source names', async t => {
  const s = setup(t); s.request.scope = 'canvas';
  const {error, result} = await run(s.dependencies, s.request);
  assert.ifError(error); assert.equal(result.records[0].name, '方案'); assert.equal(s.renders[0].scope, 'canvas');
});

test('changed PSD is rejected before any render or file write', async t => {
  const s = setup(t, {invalid: true}); const {error, result} = await run(s.dependencies, s.request);
  assert.match(error.message, /PSD changed/); assert.equal(s.renders.length, 0); assert.equal(result.records.length, 0);
  assert.deepEqual(s.releases, [], 'nothing was opened, nothing to release');
  assert.deepEqual(fs.readdirSync(s.root), ['output']);
});

for (const [name, options] of [['render failure', {renderError: true}], ['truncated PNG', {corrupt: true}], ['dimension mismatch', {wrongSize: true}]]) {
  test(name + ' stops the batch without saving an invalid file', async t => {
    const s = setup(t, options); const {error, result} = await run(s.dependencies, s.request);
    assert.ok(error); assert.equal(result.records.length, 0); assert.equal(s.renders.length, 1);
    assert.deepEqual(fs.readdirSync(s.output), []); assert.deepEqual(fs.readdirSync(s.root), ['output']);
    assert.deepEqual(s.releases, [1]);
  });
}

test('a working copy that cannot be closed is reported', async t => {
  const s = setup(t, {releaseError: true}); const {error, result} = await run(s.dependencies, s.request);
  assert.match(error.message, /close failed/); assert.equal(result.records.length, 2);
});

test('cancel during Photoshop render waits for callback, drops its PNG and removes temporary files', async t => {
  const s = setup(t, {holdRender: true}); let handle;
  const completion = new Promise(resolve => { handle = job.run(s.dependencies, s.request, (error, result) => resolve({error, result})); });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(s.callbacks.length, 1); handle.cancel();
  assert.equal(fs.readdirSync(s.root).length, 2, 'temp folder stays alive until Photoshop has finished');
  s.callbacks[0](); const {error, result} = await completion;
  assert.ifError(error); assert.equal(result.cancelled, true); assert.equal(result.records.length, 0); assert.deepEqual(s.releases, [1]);
  assert.deepEqual(fs.readdirSync(s.output), []); assert.deepEqual(fs.readdirSync(s.root), ['output']);
});

test('cancel after one saved image preserves it and does not render the next image', async t => {
  const s = setup(t); let handle;
  s.request.onProgress = state => { if (state.phase === 'saved') handle.cancel(); };
  const completion = new Promise(resolve => { handle = job.run(s.dependencies, s.request, (error, result) => resolve({error, result})); });
  const {error, result} = await completion;
  assert.ifError(error); assert.equal(result.cancelled, true); assert.equal(result.records.length, 1); assert.equal(s.renders.length, 1);
  assert.deepEqual(fs.readdirSync(s.output), ['方案.png']);
});

test('disk write failure removes the incomplete output and closes its descriptor', t => {
  const s = setup(t), mock = Object.create(fs); let closed = 0;
  mock.writeFileSync = (fd, data) => { fs.writeSync(fd, data.subarray(0, 10)); throw new Error('disk full'); };
  mock.closeSync = fd => { closed++; fs.closeSync(fd); };
  assert.throws(() => job.saveExclusive(mock, path, s.output, '方案', PNG), /disk full/);
  assert.equal(closed, 1); assert.deepEqual(fs.readdirSync(s.output), []);
});

test('PNG parser rejects missing IEND and accepts a complete PNG', () => {
  assert.deepEqual(job.pngSize(PNG), {width: 1, height: 1});
  assert.throws(() => job.pngSize(PNG.subarray(0, -12)), /不完整/);
});

test('P2: start-up sweep removes abandoned temp folders after a short grace period, never other folders', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'groupexport-sweep-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const old = path.join(root, 'ps-groupexport-abc123'), fresh = path.join(root, 'ps-groupexport-new999'), other = path.join(root, 'something-else');
  for (const dir of [old, fresh, other]) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'item-0.png'), 'x'); }
  const past = new Date(Date.now() - 5 * 60000); fs.utimesSync(old, past, past); fs.utimesSync(other, past, past);
  assert.equal(job.sweep(fs, path, {tmpdir: () => root}, 60000), 1);
  assert.deepEqual(fs.readdirSync(root).sort(), ['ps-groupexport-new999', 'something-else']);
});

