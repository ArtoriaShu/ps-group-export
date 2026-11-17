'use strict';

// A name that is safe as a single file or folder name on Windows and macOS.
exports.safeName = function (name) {
  var clean = String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[ .]+$/, '');
  if (!clean) { clean = '未命名'; }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) { clean = '_' + clean; }
  // Leave room for .png and collision numbering on Windows.
  clean = clean.slice(0, 120).replace(/[\ud800-\udbff]$/, '').replace(/[ .]+$/, '');
  return clean || '未命名';
};

exports.fileName = function (name) { return exports.safeName(name) + '.png'; };

// With byParent, each image goes into a folder named after its parent group
// (created when missing). Top-level folders have no parent and stay in the base.
exports.outputDirectory = function (fs, path, base, target, byParent) {
  if (!byParent || !target.parent) { return base; }
  var dir = path.join(base, exports.safeName(target.parent));
  try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') { throw e; } }
  if (!fs.statSync(dir).isDirectory()) { throw new Error('导出目录中已有同名文件「' + path.basename(dir) + '」，无法创建同名子目录。'); }
  return dir;
};

var QUIET = {debug: function () {}, info: function () {}, warn: function () {}, error: function () {}};

exports.pngSize = function (data) {
  var signature = [137, 80, 78, 71, 13, 10, 26, 10], i;
  if (data.length < 45) { throw new Error('Photoshop 生成的 PNG 不完整。'); }
  for (i = 0; i < signature.length; i++) { if (data[i] !== signature[i]) { throw new Error('输出不是 PNG 文件。'); } }
  if (data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') { throw new Error('PNG 文件头无效。'); }
  var width = data.readUInt32BE(16), height = data.readUInt32BE(20), offset = 8, idat = false, ended = false;
  while (offset + 12 <= data.length) {
    var length = data.readUInt32BE(offset), end = offset + length + 12;
    if (end > data.length) { throw new Error('PNG 尚未写完。'); }
    var type = data.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') { idat = true; }
    offset = end;
    if (type === 'IEND') { ended = length === 0; break; }
  }
  if (!width || !height || !idat || !ended || offset !== data.length) { throw new Error('PNG 数据结构不完整。'); }
  return {width: width, height: height};
};

exports.saveExclusive = function (fs, path, directory, name, data) {
  var filename = exports.fileName(name), stem = filename.slice(0, -4);
  for (var n = 1; n <= 100000; n++) {
    var target = path.join(directory, n === 1 ? filename : stem + ' (' + n + ').png'), fd;
    try { fd = fs.openSync(target, 'wx'); }
    catch (e) { if (e.code === 'EEXIST') { continue; } throw e; }
    try { fs.writeFileSync(fd, data); fs.closeSync(fd); }
    catch (writeError) {
      try { fs.closeSync(fd); } catch (ignore) {}
      try { fs.unlinkSync(target); } catch (ignore) {}
      throw writeError;
    }
    return target;
  }
  throw new Error('同名文件过多，请更换导出目录。');
};

function removeTemp(fs, path, directory) {
  fs.readdirSync(directory).forEach(function (name) { fs.unlinkSync(path.join(directory, name)); });
  fs.rmdirSync(directory);
}

// Removes temp folders of abandoned batches. The panel runs it on start-up, when no
// batch of this panel can be running, so only a short grace period is needed.
exports.sweep = function (fs, path, os, maxAge) {
  var root = os.tmpdir(), limit = Date.now() - (maxAge == null ? 86400000 : maxAge), removed = 0;
  fs.readdirSync(root).forEach(function (name) {
    if (!/^ps-groupexport-[a-zA-Z0-9]+$/.test(name)) { return; }
    try {
      var dir = path.join(root, name), stat = fs.lstatSync(dir);
      if (stat.isDirectory() && !stat.isSymbolicLink() && stat.mtimeMs < limit) { removeTemp(fs, path, dir); removed++; }
    } catch (ignore) {}
  });
  return removed;
};

function quote(v) { return JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }

// Each synchronous Photoshop render closes its own composite before responding; the
// shared working copy is closed by release() when the batch ends. Cancellation waits
// for the current render callback and skips the final file write.
// No timeout may start a competing render while Photoshop is still executing.
exports.run = function (o, request, callback) {
  var fs = o.fs, path = o.path, ids = request.targets.map(function (t) { return t.id; }), log = o.log || QUIET, t0 = Date.now(), job = request.job || null;
  var records = [], index = 0, cancelled = false, finished = false, directory = null, rendered = false;
  var state = {phase: 'prepare', completed: 0, total: ids.length, current: '', cancelled: false};
  function progress(phase, target) {
    state.phase = phase; state.current = target ? target.name : ''; state.completed = records.length;
    if (request.onProgress) { request.onProgress(state); }
  }
  function finish(error) {
    if (finished) { return; } finished = true;
    var summary = {saved: records.length, total: ids.length, cancelled: cancelled, ms: Date.now() - t0};
    if (error) { log.error('batch.stop', '批量导出停止：' + error.message, summary, job); }
    else { log.info('batch.end', cancelled ? '已取消' : '完成', summary, job); }
    if (directory) {
      try { removeTemp(fs, path, directory); }
      catch (e) { error = new Error((error ? error.message + '；' : '') + '临时文件清理失败：' + String(e.message || e)); }
    }
    function done() {
      state.phase = 'done'; state.cancelled = cancelled;
      callback(error, {records: records, cancelled: cancelled, total: ids.length});
    }
    // Photoshop keeps one working copy of the PSD for the whole batch; close it
    // before reporting, whatever the outcome. Early failures never opened one.
    if (!rendered) { done(); return; }
    o.host('GroupExporter.release()', function (r) {
      if (!r || !r.ok) { log.error('release', '临时文档未能关闭', {message: r && r.message}, job); }
      if (!r || !r.ok) { error = new Error((error ? error.message + '；' : '') + ((r && r.message) || '临时文档未能关闭，请手动关闭 __groupexport_work__（不要保存）。')); }
      done();
    });
  }
  function next() {
    if (finished) { return; }
    if (cancelled || index === request.targets.length) { finish(null); return; }
    var target = request.targets[index], tempPath = path.join(directory, 'item-' + index + '.png');
    progress('render', target); rendered = true;
    var began = Date.now();
    log.info('render', '开始 ' + (index + 1) + '/' + ids.length + '「' + target.name + '」', {id: target.id, breadcrumb: target.breadcrumb}, job);
    var script = 'GroupExporter.render(' + quote(request.token) + ',' + quote(ids) + ',' + quote(target.id) + ',' + quote(request.scope) + ',' + quote(tempPath) + ')';
    o.host(script, function (result) {
      if (finished) { return; }
      if (result && result.ok) { log.info('render.done', '「' + target.name + '」' + result.width + '×' + result.height + '，用时 ' + (Date.now() - began) + 'ms', {rect: result.rect, timing: result.timing}, job); }
      else { log.error('render.fail', '「' + target.name + '」渲染失败：' + ((result && result.message) || '无返回'), {timing: result && result.timing, line: result && result.line}, job); }
      if (cancelled) { finish(null); return; }
      if (!result || !result.ok) { finish(new Error((result && result.message) || 'Photoshop 没有返回导出结果。')); return; }
      try {
        var data = fs.readFileSync(tempPath), size = exports.pngSize(data);
        if (size.width !== result.width || size.height !== result.height) { throw new Error('PNG 的实际尺寸与 Photoshop 返回结果不一致，未保存。'); }
        var saved = exports.saveExclusive(fs, path, exports.outputDirectory(fs, path, request.directory, target, request.byParent), target.name, data);
        log.info('save', '已保存 ' + saved, {bytes: data.length}, job);
        records.push({name: target.name, file: saved, width: size.width, height: size.height});
        fs.unlinkSync(tempPath);
      } catch (e) { finish(e); return; }
      index++; progress('saved', target);
      o.setTimeout(next, 0);
    });
  }
  try {
    if (!ids.length) { throw new Error('请先读取需要导出的图层。'); }
    if (request.scope !== 'group' && request.scope !== 'canvas') { throw new Error('未知的导出范围。'); }
    if (!fs.statSync(request.directory).isDirectory()) { throw new Error('导出目录不存在。'); }
    directory = fs.mkdtempSync(path.join(o.os.tmpdir(), 'ps-groupexport-'));
    log.info('batch.start', '开始导出 ' + ids.length + ' 个图层', {scope: request.scope, byParent: !!request.byParent, directory: request.directory}, job);
    o.host('GroupExporter.validate(' + quote(request.token) + ',' + quote(ids) + ')', function (r) {
      if (!r || !r.ok) { finish(new Error((r && r.message) || '无法确认原始 PSD。')); return; }
      log.debug('validate', '原始 PSD 未改变', undefined, job);
      o.setTimeout(next, 0);
    });
  } catch (e) { finish(e); }
  return {state: state, cancel: function () { if (!cancelled && !finished) { log.warn('batch.cancel', '用户取消，等待当前渲染结束', {saved: records.length}, job); } cancelled = true; state.cancelled = true; }};
};
