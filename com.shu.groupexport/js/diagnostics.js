'use strict';
// Builds the text a user copies and sends back: environment, panel state and the
// plugin's own run log.

var format = require('./logger').format;

// parts: {version, environment, state, entries, logFile}
exports.bundle = function (parts) {
  var lines = [];
  lines.push('==== 图层组分批导出 诊断信息 ====');
  lines.push('插件版本：' + parts.version + '    生成时间：' + new Date().toLocaleString());
  lines.push('日志文件：' + (parts.logFile || '（未写入文件）'));
  lines.push('');
  lines.push('---- Photoshop 与当前文档 ----');
  lines.push(JSON.stringify(parts.environment || null, null, 2));
  lines.push('');
  lines.push('---- 面板状态 ----');
  lines.push(JSON.stringify(parts.state || null, null, 2));
  lines.push('');
  lines.push('---- 运行日志（最近 ' + parts.entries.length + ' 条） ----');
  parts.entries.forEach(function (e) { lines.push(format(e, true)); });
  return lines.join('\n');
};
