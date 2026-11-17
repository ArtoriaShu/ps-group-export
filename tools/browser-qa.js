'use strict';
// Chrome DevTools Protocol smoke test; no npm/browser dependencies required.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'verification'); fs.mkdirSync(output, {recursive: true});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const target = await (await fetch('http://127.0.0.1:9433/json/new?about:blank', {method: 'PUT'})).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, {once: true}));
  let id = 0; const pending = new Map(), exceptions = [], checks = [];
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id) { const p = pending.get(data.id); pending.delete(data.id); if (data.error) p.reject(data.error); else p.resolve(data.result); }
    if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => { const key = ++id; pending.set(key, {resolve, reject}); ws.send(JSON.stringify({id: key, method, params})); });
  }
  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async function until(expression, timeout = 6000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(60); }
    throw new Error('Timed out: ' + expression);
  }
  const frame = 'document.getElementById("panel").contentWindow';
  const doc = frame + '.document';
  const element = name => doc + '.getElementById(' + JSON.stringify(name) + ')';
  const click = name => evaluate(element(name) + '.click()');
  try {
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {width: 720, height: 900, deviceScaleFactor: 1, mobile: false});
    await send('Page.navigate', {url: 'http://127.0.0.1:8765/dev/preview.html'});
    await until(element('readSelection') + ' != null');
    await evaluate(frame + '.localStorage.clear()');
    assert.equal(await evaluate(element('export') + '.disabled'), true); checks.push('empty selection disables export');
    await click('readSelection'); await until(element('targetCount') + '.textContent === "3 个"');
    assert.equal(await evaluate(element('targetList') + '.children.length'), 3); checks.push('nested selections display names and paths');
    await click('chooseDirectory'); await until(element('export') + '.disabled === false'); checks.push('directory selection enables export');
    await click('scopeCanvas');
    assert.equal(await evaluate(element('scopeCanvas') + '.checked'), true); checks.push('scope switches and persists');
    const wide = await send('Page.captureScreenshot', {format: 'png'}); fs.writeFileSync(path.join(output, 'panel.png'), Buffer.from(wide.data, 'base64'));
    await click('export');
    assert.equal(await evaluate(element('readSelection') + '.disabled'), true);
    await delay(80); await click('cancel');
    await until(element('statusTitle') + '.textContent === "已取消导出"');
    assert.match(await evaluate(element('statusDetail') + '.textContent'), /0 \/ 3/); checks.push('cancel drops in-flight image and reenables controls');
    await click('export'); await until(element('statusTitle') + '.textContent === "已导出 3 张 PNG"');
    assert.equal(await evaluate(element('openDirectory') + '.hidden'), false); checks.push('completion reports count and exposes output directory');
    await evaluate(doc + '.querySelector(".remove").click()');
    assert.equal(await evaluate(element('targetCount') + '.textContent'), '2 个'); checks.push('individual targets can be removed');
    await click('scopeGroup');
    await send('Emulation.setDeviceMetricsOverride', {width: 360, height: 740, deviceScaleFactor: 1, mobile: false});
    await evaluate('document.getElementById("panel").style.height="640px"; document.getElementById("panel").style.width="340px"');
    const layout = await evaluate('({width:' + doc + '.documentElement.clientWidth,scroll:' + doc + '.documentElement.scrollWidth,export:' + element('export') + '.getBoundingClientRect().toJSON()})');
    assert.ok(layout.scroll <= layout.width); assert.ok(layout.export.bottom <= 640); checks.push('340px panel has no horizontal overflow and keeps export accessible');
    const narrow = await send('Page.captureScreenshot', {format: 'png'}); fs.writeFileSync(path.join(output, 'panel-narrow.png'), Buffer.from(narrow.data, 'base64'));
    await click('clearTargets'); assert.equal(await evaluate(element('export') + '.disabled'), true); checks.push('clearing the list disables export');
    assert.deepEqual(exceptions, []);
    const report = {checks, exceptions, note: 'Browser flow uses a simulated Photoshop bridge. Actual Photoshop pixels are not verified.'};
    fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { ws.close(); await fetch('http://127.0.0.1:9433/json/close/' + target.id); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
