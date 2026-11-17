(function () {
  'use strict';
  var bridge = window.__adobe_cep__, nodes = {}, batch = null, loaded = null, busy = false, reading = false;
  var directory = '', job = null, lastDirectory = '', started = 0, timer = null, cancelling = false;
  var VERSION = '1.1.0', logger = null, diagnostics = null, jobCount = 0, lastResult = null;
  ['pickSelf', 'pickChildren', 'pickHint', 'readSelection', 'clearTargets', 'targetCount', 'documentName', 'targetList', 'scopeGroup', 'scopeCanvas', 'scopeHint',
    'chooseDirectory', 'directoryPath', 'byParent', 'export', 'cancel', 'openDirectory', 'status', 'statusTitle', 'statusDetail', 'progress',
    'copyDiagnostics', 'openLogs', 'diagnosticText'].forEach(function (id) { nodes[id] = document.getElementById(id); });
  function quote(v) { return JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
  // In-memory stand-in until (or unless) the file logger loads, e.g. in the browser preview.
  function memoryLogger() {
    var entries = [];
    function log(level, event, message, data, job) { var e = {time: Date.now(), level: level, event: event, message: String(message || ''), data: data, job: job || null}; entries.push(e); if (entries.length > 1000) { entries.shift(); } return e; }
    return {log: log, debug: function (a, b, c, d) { return log('debug', a, b, c, d); }, info: function (a, b, c, d) { return log('info', a, b, c, d); },
      warn: function (a, b, c, d) { return log('warn', a, b, c, d); }, error: function (a, b, c, d) { return log('error', a, b, c, d); },
      entries: function () { return entries.slice(); }, file: function () { return null; }, dir: null, writeError: function () { return null; }};
  }
  logger = memoryLogger();
  function status(kind, title, detail) {
    if (kind === 'error') { logger.warn('status', title + (detail ? '：' + detail : '')); }
    nodes.status.setAttribute('data-kind', kind); nodes.statusTitle.textContent = title; nodes.statusDetail.textContent = detail || '';
  }
  function host(script, callback) {
    if (!bridge) { callback({ok: false, message: '请在 Photoshop 中打开此插件。'}); return; }
    var delivered = false;
    function deliver(raw) {
      if (delivered) { return; } delivered = true;
      var result;
      try { result = JSON.parse(raw); } catch (e) { result = {ok: false, message: '宿主脚本连接失败。请重新安装插件，并重启 Photoshop。'}; }
      callback(result);
    }
    try { bridge.evalScript(script, deliver); }
    catch (e) { deliver(JSON.stringify({ok: false, message: String(e.message || e)})); }
  }
  var PICK_HINT = {
    self: '在图层面板里直接多选方案文件夹，每个方案导出一张。可跨父级、任意层级。',
    children: '在图层面板里选方案的上一级（可多选），它下面的每个方案各导出一张。'
  };
  var SCOPE_HINT = {
    canvas: '保留位置和留白；在画板内时按所属画板尺寸。',
    group: '按文件夹自身像素裁切（同原生“导出为”），上层蒙版、效果和公共图层照常合成。'
  };
  function pickMode() { return nodes.pickChildren.checked ? 'children' : 'self'; }
  function persist() {
    try { window.localStorage.setItem('groupexport-settings-v1', JSON.stringify({directory: directory, scope: nodes.scopeCanvas.checked ? 'canvas' : 'group', pick: pickMode(), byParent: nodes.byParent.checked})); } catch (ignore) {}
  }
  function render() {
    var targets = loaded ? loaded.targets : [], blocked = busy || reading;
    nodes.targetCount.textContent = targets.length + ' 个';
    nodes.readSelection.disabled = blocked; nodes.pickSelf.disabled = blocked; nodes.pickChildren.disabled = blocked;
    nodes.pickHint.textContent = PICK_HINT[pickMode()];
    nodes.readSelection.textContent = pickMode() === 'children' ? '读取父级下的方案' : '读取选中的方案'; nodes.clearTargets.disabled = blocked || !targets.length;
    nodes.chooseDirectory.disabled = blocked; nodes.directoryPath.disabled = blocked; nodes.byParent.disabled = blocked;
    nodes.openLogs.hidden = !logger.dir;
    nodes.scopeGroup.disabled = blocked; nodes.scopeCanvas.disabled = blocked;
    nodes.scopeHint.textContent = SCOPE_HINT[nodes.scopeCanvas.checked ? 'canvas' : 'group'];
    nodes.chooseDirectory.textContent = directory ? '更改' : '选择';
    nodes.export.disabled = blocked || !batch || !targets.length || !directory;
    nodes.export.hidden = busy; nodes.cancel.hidden = !busy; nodes.cancel.disabled = cancelling;
    nodes.cancel.textContent = cancelling ? '正在停止…' : '取消';
    nodes.directoryPath.textContent = directory || '尚未选择目录'; nodes.directoryPath.title = directory || '点击选择导出目录';
    nodes.documentName.textContent = loaded ? loaded.documentName : '尚未读取'; nodes.documentName.title = loaded ? loaded.documentName : '';
    nodes.openDirectory.hidden = !lastDirectory || busy || reading;
    var buttons = nodes.targetList.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) { buttons[i].disabled = blocked; }
    nodes.export.textContent = targets.length ? '导出 ' + targets.length + ' 个文件夹' : '开始批量导出';
  }
  function targetList() {
    while (nodes.targetList.firstChild) { nodes.targetList.removeChild(nodes.targetList.firstChild); }
    var targets = loaded ? loaded.targets : [];
    if (!targets.length) {
      var empty = document.createElement('li'); empty.className = 'empty'; empty.textContent = '还没有文件夹，请先读取 Photoshop 中的选择。'; nodes.targetList.appendChild(empty);
    }
    targets.forEach(function (t) {
      var row = document.createElement('li'), icon = document.createElement('span'), main = document.createElement('div');
      var name = document.createElement('strong'), path = document.createElement('small'), remove = document.createElement('button');
      row.className = 'target'; icon.className = 'target-symbol'; icon.textContent = '▱'; icon.setAttribute('aria-hidden', 'true'); main.className = 'target-main';
      name.textContent = t.name; name.title = t.name; path.textContent = t.breadcrumb; path.title = t.breadcrumb;
      var folder = nodes.byParent.checked && t.parent && batch && batch.safeName ? batch.safeName(t.parent) + '/' : '';
      if (batch && (folder || batch.fileName(t.name) !== t.name + '.png')) { path.textContent += ' → ' + folder + batch.fileName(t.name); }
      main.appendChild(name); main.appendChild(path); remove.className = 'remove'; remove.textContent = '×';
      remove.title = '从导出清单移除'; remove.setAttribute('aria-label', '移除 ' + t.name);
      remove.addEventListener('click', function () {
        if (busy || reading) { return; }
        loaded.targets = loaded.targets.filter(function (candidate) { return candidate.id !== t.id; }); targetList(); render();
      });
      row.appendChild(icon); row.appendChild(main); row.appendChild(remove); nodes.targetList.appendChild(row);
    });
    render();
  }
  function readSelection() {
    if (busy || reading) { return; }
    reading = true; render(); status('working', pickMode() === 'children' ? '正在读取父级下的方案…' : '正在读取选中的方案…', '请稍候。');
    host('GroupExporter.capture(' + quote(pickMode()) + ')', function (r) {
      reading = false;
      if (r.ok) { logger.info('capture', '读取 ' + r.targets.length + ' 个文件夹（' + (pickMode() === 'children' ? '选父级' : '直接选方案') + '）', {document: r.documentName, token: r.token, targets: r.targets.map(function (t) { return t.breadcrumb; })}); }
      if (r.ok) { loaded = r; status('idle', '已读取 ' + r.targets.length + ' 个文件夹', '确认清单、导出范围和保存目录后开始导出。'); targetList(); }
      else { status('error', '读取失败', r.message); }
      render();
    });
  }
  function chooseDirectory() {
    if (busy || reading) { return; }
    reading = true; render();
    host('GroupExporter.chooseDirectory(' + quote(directory) + ')', function (r) {
      reading = false;
      if (r.ok) { directory = r.path; persist(); logger.info('directory', '保存目录 ' + directory); }
      else if (!r.cancelled) { status('error', '无法选择目录', r.message); }
      render();
    });
  }
  function progress(state) {
    nodes.progress.value = state.completed;
    var elapsed = Math.floor((Date.now() - started) / 1000);
    status('working', cancelling ? '正在停止导出…' : '正在导出 ' + Math.min(state.completed + 1, state.total) + ' / ' + state.total + '：' + state.current,
      '已保存 ' + state.completed + ' 张 · 已用 ' + elapsed + ' 秒' + (cancelling ? ' · 等待 Photoshop 完成当前渲染，当前图片不会保存。' : ' · 大 PSD 渲染期间请稍候。'));
  }
  function exportBatch() {
    if (busy || reading || !batch || !loaded || !loaded.targets.length || !directory) { return; }
    busy = true; cancelling = false; started = Date.now(); lastDirectory = ''; render();
    var exportDirectory = directory, targets = loaded.targets.slice(), id = ++jobCount, live = {completed: 0, total: targets.length, current: targets[0].name};
    nodes.progress.max = targets.length; nodes.progress.value = 0; nodes.progress.hidden = false; progress(live);
    timer = window.setInterval(function () { progress(live); }, 500);
    var handle = batch.run({fs: batch.fs, path: batch.path, os: batch.os, host: host, setTimeout: window.setTimeout.bind(window), log: logger},
      {token: loaded.token, targets: targets, directory: exportDirectory, scope: nodes.scopeCanvas.checked ? 'canvas' : 'group', byParent: nodes.byParent.checked, job: id,
        onProgress: function (s) { live = s; progress(s); }}, function (error, result) {
        busy = false; job = null; window.clearInterval(timer); timer = null; nodes.progress.value = result.records.length;
        nodes.progress.hidden = !result.records.length;
        if (result.records.length) { lastDirectory = exportDirectory; }
        var count = result.records.length, detail = '已保存 ' + count + ' / ' + result.total + ' 张。';
        lastResult = {job: id, saved: count, total: result.total, cancelled: result.cancelled, error: error ? error.message : null, seconds: Math.round((Date.now() - started) / 100) / 10};
        if (error) { status('error', '批量导出已停止', detail + ' ' + error.message + ' 如需反馈，请点右下角“复制诊断信息”。'); }
        else if (result.cancelled) { status('idle', '已取消导出', detail + ' 已保存的文件保留，原 PSD 保持不变。'); }
        else { status('ok', '已导出 ' + count + ' 张 PNG', '文件名与文件夹一致，原 PSD 保持不变。'); }
        render();
      });
    // The runner may fail synchronously (e.g. a deleted output directory).
    if (busy) { job = handle; }
  }
  nodes.readSelection.addEventListener('click', readSelection);
  nodes.clearTargets.addEventListener('click', function () { if (busy || reading) { return; } loaded = null; targetList(); status('idle', '清单已清空', '在 Photoshop 中选择文件夹后重新读取。'); });
  nodes.chooseDirectory.addEventListener('click', chooseDirectory); nodes.directoryPath.addEventListener('click', chooseDirectory);
  function panelState() {
    return {version: VERSION, pick: pickMode(), scope: nodes.scopeCanvas.checked ? 'canvas' : 'group', byParent: nodes.byParent.checked, directory: directory,
      busy: busy, reading: reading, cancelling: cancelling, lastResult: lastResult,
      loaded: loaded ? {token: loaded.token, document: loaded.documentName, targets: loaded.targets.map(function (t) { return {id: t.id, breadcrumb: t.breadcrumb, parent: t.parent, rect: t.rect, board: t.board}; })} : null,
      status: {kind: nodes.status.getAttribute('data-kind'), title: nodes.statusTitle.textContent, detail: nodes.statusDetail.textContent}};
  }
  function copyText(text) {
    var area = document.createElement('textarea'); area.value = text; area.setAttribute('readonly', '');
    area.style.position = 'fixed'; area.style.left = '-9999px'; document.body.appendChild(area); area.select();
    var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(area); return ok;
  }
  function copyDiagnostics() {
    nodes.copyDiagnostics.disabled = true; nodes.copyDiagnostics.textContent = '正在收集…';
    host('GroupExporter.environment()', function (environment) {
      var parts = {version: VERSION, environment: environment, state: panelState(), entries: logger.entries('debug').slice(-600), logFile: logger.file()}, text;
      try { text = diagnostics ? diagnostics.bundle(parts) : JSON.stringify(parts, null, 2); } catch (e) { text = '诊断信息生成失败：' + String(e.message || e); }
      nodes.copyDiagnostics.disabled = false;
      if (copyText(text)) { nodes.copyDiagnostics.textContent = '已复制 ✓'; nodes.diagnosticText.hidden = true; logger.info('diagnostics', '诊断信息已复制（' + text.length + ' 字符）'); }
      else { nodes.copyDiagnostics.textContent = '复制诊断信息'; nodes.diagnosticText.hidden = false; nodes.diagnosticText.value = text; nodes.diagnosticText.focus(); nodes.diagnosticText.select(); status('idle', '无法自动复制', '诊断信息已显示在下方文本框中，已全选，请按 Ctrl+C 复制。'); }
      window.setTimeout(function () { nodes.copyDiagnostics.textContent = '复制诊断信息'; }, 2500);
    });
  }
  nodes.copyDiagnostics.addEventListener('click', copyDiagnostics);
  nodes.openLogs.addEventListener('click', function () { if (logger.dir) { host('GroupExporter.openDirectory(' + quote(logger.dir) + ')', function (r) { if (!r.ok) { status('error', '无法打开日志目录', r.message); } }); } });
  nodes.byParent.addEventListener('change', function () { persist(); logger.info('setting', '按父文件夹分目录 ' + (nodes.byParent.checked ? '开启' : '关闭')); targetList(); });
  window.addEventListener('error', function (e) { logger.error('script', '面板脚本错误：' + (e && e.message), {file: e && e.filename, line: e && e.lineno}); });
  nodes.pickSelf.addEventListener('change', function () { persist(); render(); });
  nodes.pickChildren.addEventListener('change', function () { persist(); render(); });
  nodes.scopeGroup.addEventListener('change', function () { persist(); render(); });
  nodes.scopeCanvas.addEventListener('change', function () { persist(); render(); });
  nodes.export.addEventListener('click', exportBatch);
  nodes.cancel.addEventListener('click', function () { if (job) { cancelling = true; job.cancel(); render(); } });
  nodes.openDirectory.addEventListener('click', function () { if (busy || reading) { return; } host('GroupExporter.openDirectory(' + quote(lastDirectory) + ')', function (r) { if (!r.ok) { status('error', '无法打开目录', r.message); } }); });
  window.addEventListener('beforeunload', function () { if (job) { job.cancel(); } });
  try {
    var rq = window.cep_node && window.cep_node.require ? window.cep_node.require : window.require;
    if (!rq && typeof require === 'function') { rq = require; }
    if (window.GroupExportPreview) { batch = window.GroupExportPreview; }
    else if (bridge && rq) {
      var path = rq('path'), base = decodeURI(bridge.getSystemPath('extension')).replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1');
      batch = rq(path.join(base, 'js', 'batch-job.js')); batch.fs = rq('fs'); batch.path = path; batch.os = rq('os');
      try {
        var env = rq('process').env, memory = logger;
        var logDir = env.APPDATA ? path.join(env.APPDATA, 'GroupExport', 'logs') : path.join(batch.os.homedir(), 'Library', 'Logs', 'GroupExport');
        logger = rq(path.join(base, 'js', 'logger.js')).create({fs: batch.fs, path: path, dir: logDir, keepDays: 7});
        memory.entries().forEach(function (e) { logger.log(e.level, e.event, e.message, e.data, e.job); });
        diagnostics = rq(path.join(base, 'js', 'diagnostics.js'));
      } catch (logError) { logger.warn('logger', '日志文件不可用，仅保存在内存中：' + String(logError.message || logError)); }
      var hostEnv = null; try { hostEnv = JSON.parse(bridge.getHostEnvironment()); } catch (ignore2) {}
      logger.info('panel.start', '面板启动 v' + VERSION, {app: hostEnv && hostEnv.appVersion, os: batch.os.platform() + ' ' + batch.os.release(), logWriteError: logger.writeError()});
      try { batch.sweep(batch.fs, path, batch.os); } catch (ignore) {}
    } else { status('error', '请在 Photoshop 中打开插件', '安装后，在“窗口 → 扩展功能（旧版）”打开“图层组分批导出”。'); }
    var settings = null;
    try { settings = JSON.parse(window.localStorage.getItem('groupexport-settings-v1') || 'null'); } catch (ignore) {}
    if (settings) {
      directory = typeof settings.directory === 'string' ? settings.directory : '';
      if (settings.scope === 'canvas' || settings.scope === 'group') { nodes.scopeCanvas.checked = settings.scope === 'canvas'; nodes.scopeGroup.checked = !nodes.scopeCanvas.checked; }
      nodes.pickChildren.checked = settings.pick === 'children'; nodes.pickSelf.checked = !nodes.pickChildren.checked;
      nodes.byParent.checked = settings.byParent === true;
    }
  } catch (e) { status('error', '插件文件加载失败', String(e.message || e)); }
  render();
}());
