/* Easter egg: rest the mouse on the logo. Black ink bleeds out from it over the panel,
   the ink-wash clip surfaces through the ink a beat later (filling the panel, with the whole
   frame in view near the top), then the poem is brushed in vertical columns, right to left.
   Leaving the logo or pressing Esc fades it away. ES5 only (older CEP Chromium). */
(function () {
  'use strict';
  var FRAMES = 106, FPS = 30, HOLD_MS = 1200;
  var PLAY_AFTER_MS = 1400, RAMP_MS = 1800, INK_MS = 4200, CLIP_LAG_MS = 900, CLIP_MS = 4200, POEM_AT_MS = 3800, CHAR_MS = 95, LINE_GAP_MS = 420;
  // The canvas works in CSS pixels: the clip is 480 px wide and the rest is blurred, so a retina-size
  // canvas would only quadruple the work. Masks and the backdrop are built at quarter size.
  var PAPER = '#0d0e10', MASK_SCALE = 0.25, SOFT = 0.25;
  var POEM = ['历经五十四次劫，劫云仍旧漫遮天。', '胸中魂光压众生，拳里剑气纵北原。', '时来时去四百载，无死何能生新颜。', '弃此残躯换清风，卷席苍穹复光年。'];

  var icon = document.querySelector('.app-icon');
  if (!icon || !document.createElement('canvas').getContext) { return; }

  var layer = document.createElement('div'); layer.className = 'egg'; layer.setAttribute('aria-hidden', 'true');
  var canvas = document.createElement('canvas'); layer.appendChild(canvas);
  var poem = document.createElement('div'); poem.className = 'egg-poem'; layer.appendChild(poem);
  layer.appendChild(inkFilter());
  document.body.appendChild(layer);
  var ctx = canvas.getContext('2d');
  var clip = document.createElement('canvas'), cctx = clip.getContext('2d');   // clip layer, full size
  var sharp = document.createElement('canvas'), sctx = sharp.getContext('2d'); // whole frame, feathered
  var soft = document.createElement('canvas'), soctx = soft.getContext('2d'); // backdrop + bridge, quarter size
  var halo = document.createElement('canvas'), hctx = halo.getContext('2d'); // blurred bridge under the frame
  var mask = document.createElement('canvas'), mctx = mask.getContext('2d');   // ink masks, quarter size

  var frames = [], loaded = 0, holdTimer = 0, raf = 0, startedAt = 0, open = false, playFrom = 0;
  var still = document.createElement('canvas'), stctx = still.getContext('2d'); // current frame, blended
  var blots = makeBlots(), noise = null, box = null;

  // Rough, bleeding edges on the characters, like ink soaking into paper.
  function inkFilter() {
    var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('class', 'egg-defs');
    svg.innerHTML = '<filter id="egg-ink" x="-20%" y="-20%" width="140%" height="140%">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="2" seed="4" result="grain"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="grain" scale="1.6" xChannelSelector="R" yChannelSelector="G" result="rough"/>' +
      '<feGaussianBlur in="rough" stdDeviation="1.8" result="bleed"/>' +
      '<feComponentTransfer in="bleed" result="halo"><feFuncA type="linear" slope="0.55"/></feComponentTransfer>' +
      '<feMerge><feMergeNode in="halo"/><feMergeNode in="rough"/></feMerge></filter>';
    return svg;
  }

  function loadFrames() {
    if (frames.length) { return; }
    // Count a frame only once it is decoded, so drawing it later never stalls on JPEG decoding.
    function ready() { loaded++; }
    for (var i = 0; i < FRAMES; i++) {
      var img = new Image();
      img.onload = img.decode ? null : ready;
      img.src = 'assets/poem/' + ('00' + i).slice(-3) + '.jpg'; frames.push(img);
      if (img.decode) { img.decode().then(ready, ready); }
    }
  }

  function random(seed) { return function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }

  // Blots scattered around the spreading front give it its irregular, tendril-like outline.
  function makeBlots() {
    var list = [], rnd = random(11);
    for (var i = 0; i < 140; i++) { list.push({a: rnd() * Math.PI * 2, d: 0.1 + rnd() * 1.1, s: 0.04 + rnd() * rnd() * 0.32, k: rnd(), w: rnd() * 6.28}); }
    return list;
  }

  // Smooth value noise (two octaves) at mask resolution; thresholding against it frays the ink edge.
  function makeNoise(w, h) {
    var out = new Float32Array(w * h), rnd = random(29), octaves = [[10, 0.65], [4, 0.35]], o, x, y;
    for (o = 0; o < octaves.length; o++) {
      var cell = octaves[o][0], gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2, grid = [];
      for (var g = 0; g < gw * gh; g++) { grid.push(rnd()); }
      for (y = 0; y < h; y++) {
        var gy = y / cell, y0 = Math.floor(gy), ty = gy - y0; ty = ty * ty * (3 - 2 * ty);
        for (x = 0; x < w; x++) {
          var gx = x / cell, x0 = Math.floor(gx), tx = gx - x0; tx = tx * tx * (3 - 2 * tx);
          var a = grid[y0 * gw + x0], b = grid[y0 * gw + x0 + 1], c = grid[(y0 + 1) * gw + x0], d = grid[(y0 + 1) * gw + x0 + 1];
          out[y * w + x] += ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty) * octaves[o][1];
        }
      }
    }
    return out;
  }

  function busy() { var cancel = document.getElementById('cancel'); return cancel && !cancel.hidden; }

  // Clip on top at full panel width (whole frame visible), poem in the space below it.
  function size() {
    var w = window.innerWidth, h = window.innerHeight;
    canvas.width = clip.width = w; canvas.height = clip.height = h;
    mask.width = Math.max(8, Math.round(canvas.width * MASK_SCALE)); mask.height = Math.max(8, Math.round(canvas.height * MASK_SCALE));
    noise = makeNoise(mask.width, mask.height);
    var vh = Math.round(w * 9 / 16), minPoem = 8 * 18 + 40;
    if (h - vh < minPoem) { vh = Math.max(Math.round(h * 0.38), h - minPoem); }
    var vw = Math.min(w, Math.round(vh * 16 / 9));
    box = {x: (w - vw) / 2, y: 0, w: vw, h: vh};
    // Eight columns of seven characters (each line split at its comma); the poem starts inside the
    // clip's fade. Width: 8 columns + 4 gaps of .25em inside couplets + 3 gaps of .8em between them.
    var top = Math.round(vh * 0.8), room = h - top - 34;
    var font = Math.max(14, Math.min(48, Math.floor(room / 7.9), Math.floor((w - 24) / 11.2)));
    poem.style.top = top + 'px'; poem.style.fontSize = font + 'px';
  }

  // Each line becomes a pair of seven-character columns (right to left), split at the comma; the
  // brush font has no vertical punctuation, so the comma becomes a pause and the full stop is dropped.
  function writePoem() {
    poem.innerHTML = '';
    var delay = POEM_AT_MS, jitter = random(101);
    for (var i = 0; i < POEM.length; i++) {
      var pair = document.createElement('div'); pair.className = 'egg-pair';
      var halves = POEM[i].replace('。', '').split('，');
      for (var k = 0; k < halves.length; k++) {
        var col = document.createElement('p'); col.className = 'egg-line';
        for (var j = 0; j < halves[k].length; j++) {
          // Outer span is brushed in (mask wipe); inner glyph gets a slight, seeded variation in
          // position, angle and size so the columns read as written by hand rather than typeset.
          var ch = document.createElement('span'), glyph = document.createElement('span');
          ch.className = 'egg-ch'; glyph.className = 'egg-glyph'; glyph.textContent = halves[k].charAt(j);
          glyph.style.transform = 'translateX(' + ((jitter() - 0.5) * 0.1).toFixed(3) + 'em) rotate(' + ((jitter() - 0.5) * 3.6).toFixed(2) + 'deg) scale(' + (0.94 + jitter() * 0.13).toFixed(3) + ')';
          ch.style.animationDelay = Math.round(delay) + 'ms'; delay += CHAR_MS; ch.appendChild(glyph); col.appendChild(ch);
        }
        delay += CHAR_MS * 3; pair.appendChild(col);
      }
      delay += LINE_GAP_MS; poem.appendChild(pair);
    }
  }

  function ease(t) { return t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  // Paints the ink coverage for progress p (0..1) into the quarter-size mask, frayed by noise.
  function inkMask(p, now, cx, cy) {
    var w = mask.width, h = mask.height, s = MASK_SCALE, x = cx * s, y = cy * s;
    var reach = Math.sqrt(Math.pow(Math.max(x, w - x), 2) + Math.pow(Math.max(y, h - y), 2)) * 1.25, front = p * reach, i, b;
    mctx.globalCompositeOperation = 'source-over'; mctx.clearRect(0, 0, w, h);
    if (p >= 1) { mctx.fillStyle = '#000'; mctx.fillRect(0, 0, w, h); return; }
    blob(x, y, front * 0.8, 1);
    for (i = 0; i < blots.length; i++) {
      b = blots[i]; var at = b.d * reach; if (front < at * 0.5) { continue; }
      var grow = Math.min(1, (front - at * 0.5) / (reach * 0.3)), wob = Math.sin(now / 700 + b.w) * 0.04;
      var dist = at * (0.5 + 0.5 * p), ang = b.a + wob;
      blob(x + Math.cos(ang) * dist, y + Math.sin(ang) * dist, b.s * reach * grow, 0.6 + b.k * 0.4);
    }
    // Threshold against noise: the ink edge breaks into fibres instead of a soft circle.
    var data = mctx.getImageData(0, 0, w, h), px = data.data, cut = 0.35 + 0.25 * (1 - p);
    for (i = 0; i < noise.length; i++) {
      var a = px[i * 4 + 3] / 255, v = (a - noise[i] * cut) * 2.6;
      px[i * 4 + 3] = v <= 0 ? 0 : v >= 1 ? 255 : v * 255;
    }
    mctx.putImageData(data, 0, 0);
  }

  function blob(x, y, radius, alpha) {
    if (radius <= 0) { return; }
    var g = mctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, 'rgba(0,0,0,' + alpha + ')'); g.addColorStop(0.6, 'rgba(0,0,0,' + alpha + ')'); g.addColorStop(1, 'rgba(0,0,0,0)');
    mctx.fillStyle = g; mctx.beginPath(); mctx.arc(x, y, radius, 0, Math.PI * 2); mctx.fill();
  }

  // The clip holds frame 0 while it surfaces through the ink and starts playing from the beginning
  // once the top of the panel is mostly revealed and every frame has loaded (so it never jumps
  // ahead after a slow load). It then loops at its own speed (30 fps); frames are cross-faded by the
  // sub-frame remainder so refreshes between video frames stay smooth, including the wrap to frame 0.
  function currentFrame(t) {
    var first = frames[0]; if (!first || !first.complete || !first.naturalWidth) { return null; }
    if (!playFrom && loaded >= FRAMES && t >= CLIP_LAG_MS + PLAY_AFTER_MS) { playFrom = t; }
    // Ease in: speed ramps from 0 to normal over RAMP_MS, so the still frame starts moving gently.
    var e = playFrom ? t - playFrom : 0, played = e < RAMP_MS ? e * e / (2 * RAMP_MS) : e - RAMP_MS / 2;
    var pos = (played / (1000 / FPS)) % FRAMES;
    var i = Math.floor(pos), f = pos - i, a = frames[i], b = frames[(i + 1) % FRAMES];
    if (still.width !== a.naturalWidth) { still.width = a.naturalWidth; still.height = a.naturalHeight; }
    stctx.globalAlpha = 1; stctx.drawImage(a, 0, 0);
    if (f > 0.001) { stctx.globalAlpha = f; stctx.drawImage(b, 0, 0); stctx.globalAlpha = 1; }
    return still;
  }

  // Full-bleed backdrop: the same frame stretched to cover the panel, blurred and darkened. The whole
  // frame sits sharp on top, its edges dissolving into the backdrop, so the panel is filled and every
  // figure stays in view.
  function drawClip(now) {
    var w = clip.width, h = clip.height, bx = box.x, by = box.y, bw = box.w, bh = box.h;
    cctx.globalCompositeOperation = 'source-over'; cctx.clearRect(0, 0, w, h);
    var img = currentFrame(now - startedAt);
    if (!img) { cctx.fillStyle = PAPER; cctx.fillRect(0, 0, w, h); return; }
    var iw = img.width, ih = img.height;
    // Backdrop and bridge are blurred anyway, so build them at quarter size and scale up once.
    var sw = Math.max(8, Math.round(w * SOFT)), sh = Math.max(8, Math.round(h * SOFT)), k = SOFT;
    if (soft.width !== sw || soft.height !== sh) { soft.width = sw; soft.height = sh; }
    var cs = Math.max(sw / iw, sh / ih), filters = 'filter' in soctx;
    soctx.globalCompositeOperation = 'source-over'; soctx.globalAlpha = 1;
    if (filters) { soctx.filter = 'blur(' + (14 * k) + 'px)'; }
    soctx.drawImage(img, (sw - iw * cs) / 2 - 5, (sh - ih * cs) / 2 - 5, iw * cs + 10, ih * cs + 10);
    var shade = soctx.createLinearGradient(0, 0, 0, sh), fold = Math.min(0.9, (by + bh) / h);
    shade.addColorStop(0, 'rgba(10,11,13,.35)'); shade.addColorStop(fold, 'rgba(10,11,13,.6)'); shade.addColorStop(1, 'rgba(10,11,13,.82)');
    if (filters) { soctx.filter = 'none'; }
    soctx.fillStyle = shade; soctx.fillRect(0, 0, sw, sh);
    // Bridge: a blurred, slightly larger copy of the frame under the sharp one, faded in and out
    // smoothly, so the sharp frame melts through matching shapes into the backdrop.
    if (filters) {
      halo.width = sw; halo.height = sh;
      hctx.globalCompositeOperation = 'source-over'; hctx.filter = 'blur(' + (10 * k) + 'px)';
      hctx.drawImage(img, (bx - bw * 0.06) * k, (by - bh * 0.04) * k, bw * 1.12 * k, bh * 1.3 * k); hctx.filter = 'none';
      var top = (by + bh * 0.2) * k, bottom = Math.min(sh, (by + bh * 1.3) * k), hf = hctx.createLinearGradient(0, top, 0, bottom);
      for (var g = 0; g <= 10; g++) { var v = g / 10, bell = Math.sin(Math.PI * v); hf.addColorStop(v, 'rgba(0,0,0,' + (0.7 * bell * bell).toFixed(3) + ')'); }
      hctx.globalCompositeOperation = 'destination-in'; hctx.fillStyle = hf; hctx.fillRect(0, 0, sw, sh);
      soctx.drawImage(halo, 0, 0);
    }
    cctx.imageSmoothingEnabled = true; cctx.drawImage(soft, 0, 0, w, h);
    // Sharp frame with feathered edges (alpha gradients), laid over the backdrop.
    sharp.width = Math.round(bw); sharp.height = Math.round(bh);
    sctx.globalCompositeOperation = 'source-over'; sctx.drawImage(img, 0, 0, sharp.width, sharp.height);
    sctx.globalCompositeOperation = 'destination-in';
    var vert = sctx.createLinearGradient(0, 0, 0, sharp.height);
    vert.addColorStop(0, 'rgba(0,0,0,.85)'); vert.addColorStop(0.1, '#000'); vert.addColorStop(0.36, '#000');
    // Long, eased fade (smoothstep samples) so the frame melts into the backdrop instead of ending at a line.
    for (var f = 1; f <= 8; f++) { var u = f / 8, a = 1 - u * u * (3 - 2 * u); vert.addColorStop(0.36 + 0.64 * u, 'rgba(0,0,0,' + a.toFixed(3) + ')'); }
    sctx.fillStyle = vert; sctx.fillRect(0, 0, sharp.width, sharp.height);
    var edge = Math.min(0.12, 28 / sharp.width), horiz = sctx.createLinearGradient(0, 0, sharp.width, 0);
    horiz.addColorStop(0, 'rgba(0,0,0,0)'); horiz.addColorStop(edge, '#000'); horiz.addColorStop(1 - edge, '#000'); horiz.addColorStop(1, 'rgba(0,0,0,0)');
    sctx.fillStyle = horiz; sctx.fillRect(0, 0, sharp.width, sharp.height);
    cctx.drawImage(sharp, bx, by);
  }

  function draw(now) {
    raf = window.requestAnimationFrame(draw);
    var w = canvas.width, h = canvas.height, t = now - startedAt;
    var ib = icon.getBoundingClientRect(), cx = ib.left + ib.width / 2, cy = ib.top + ib.height / 2;

    // 1. Black ink bleeds over the panel.
    ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, w, h);
    var p = ease(t / INK_MS);
    if (p < 1) { inkMask(p, now, cx, cy); ctx.globalCompositeOperation = 'destination-in'; ctx.imageSmoothingEnabled = true; ctx.drawImage(mask, 0, 0, w, h); }

    // 2. The clip surfaces through the ink, trailing the front.
    var q = ease((t - CLIP_LAG_MS) / CLIP_MS);
    if (q > 0) {
      drawClip(now);
      if (q < 1) { inkMask(q, now + 5000, cx, cy); cctx.globalCompositeOperation = 'destination-in'; cctx.drawImage(mask, 0, 0, w, h); }
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = Math.min(1, 0.35 + q); ctx.drawImage(clip, 0, 0); ctx.globalAlpha = 1;
      // 3. Ink smoke keeps rising from the bottom.
      drawSmoke(q, now);
    }
  }

  // Ink smoke rising from the bottom: soft translucent wisps drift up, sway, spread and fade, like
  // ink dropped into water. Each wisp is one pre-rendered sprite drawn with drawImage, so it is cheap.
  var SMOKE_COUNT = 34, smoke = [], sprites = [];

  function makeSprites() {
    var size = 128, grain = makeNoise(size, size), tones = [[30, 32, 38], [96, 100, 110], [150, 154, 164]];
    for (var v = 0; v < tones.length * 2; v++) {
      var c = document.createElement('canvas'), x = c.getContext('2d'); c.width = c.height = size;
      var img = x.createImageData(size, size), px = img.data, off = v * 977, stretch = v % 2 ? 1.5 : 1, tone = tones[v % tones.length];
      for (var i = 0; i < size * size; i++) {
        var dx = (i % size - size / 2) / (size / 2), dy = (Math.floor(i / size) - size / 2) / (size / 2) * stretch;
        var fall = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy)), n = grain[(i + off) % grain.length];
        var a = Math.pow(fall, 1.2) * (n * 1.6 - 0.45);   // grain cut-off leaves wisps, not a disc
        px[i * 4] = tone[0]; px[i * 4 + 1] = tone[1]; px[i * 4 + 2] = tone[2]; px[i * 4 + 3] = a <= 0 ? 0 : Math.min(255, Math.round(a * 255));
      }
      x.putImageData(img, 0, 0);
      if ('filter' in x) {   // soften the grain into smoke
        var blurred = document.createElement('canvas'), bx = blurred.getContext('2d'); blurred.width = blurred.height = size;
        bx.filter = 'blur(3px)'; bx.drawImage(c, 0, 0); c = blurred;
      }
      sprites.push(c);
    }
  }

  function spawn(p, w, h) {
    var rnd = Math.random;
    p.x = rnd() * w; p.y = h * (1.02 + rnd() * 0.06);
    p.vy = -(h * (0.022 + rnd() * 0.024));           // px per second: a slow rise
    p.size = w * (0.16 + rnd() * 0.14); p.grow = w * (0.05 + rnd() * 0.06);
    p.life = 7000 + rnd() * 5000; p.age = 0; p.sway = rnd() * 6.28; p.swayAmp = w * (0.015 + rnd() * 0.03);
    p.rot = rnd() * 6.28; p.spin = (rnd() - 0.5) * 0.12; p.sprite = sprites[Math.floor(rnd() * sprites.length)];
    p.peak = 0.35 + rnd() * 0.3;
    return p;
  }

  function resetSmoke(w, h) {
    if (!sprites.length) { makeSprites(); }
    smoke = [];
    for (var i = 0; i < SMOKE_COUNT; i++) { var p = spawn({}, w, h); p.age = Math.random() * p.life; smoke.push(p); }
  }

  var smokeAt = 0;

  function drawSmoke(q, now) {
    var w = canvas.width, h = canvas.height, dt = smokeAt ? Math.min(100, now - smokeAt) : 16;
    smokeAt = now;
    ctx.globalCompositeOperation = 'source-over';
    for (var i = 0; i < smoke.length; i++) {
      var p = smoke[i]; p.age += dt;
      if (p.age >= p.life) { spawn(p, w, h); continue; }
      var u = p.age / p.life, sec = p.age / 1000;
      var y = p.y + p.vy * sec, x = p.x + Math.sin(p.sway + sec * 0.45) * p.swayAmp, size = p.size + p.grow * sec;
      var fade = Math.sin(Math.PI * u);                          // in, then out
      ctx.globalAlpha = Math.max(0, fade * fade * p.peak * q);
      ctx.save(); ctx.translate(x, y); ctx.rotate(p.rot + p.spin * sec);
      ctx.drawImage(p.sprite, -size / 2, -size / 2, size, size); ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function show() {
    if (open || busy()) { return; }
    open = true; size(); writePoem(); resetSmoke(canvas.width, canvas.height); smokeAt = 0; playFrom = 0; startedAt = window.performance.now();
    layer.className = 'egg egg-open'; raf = window.requestAnimationFrame(draw);
  }

  function hide() {
    window.clearTimeout(holdTimer); holdTimer = 0;
    if (!open) { return; }
    open = false; layer.className = 'egg egg-closing';
    window.setTimeout(function () { if (!open) { window.cancelAnimationFrame(raf); layer.className = 'egg'; poem.innerHTML = ''; } }, 900);
  }

  icon.addEventListener('mouseenter', function () {
    loadFrames(); window.clearTimeout(holdTimer);
    holdTimer = window.setTimeout(show, HOLD_MS);
  });
  icon.addEventListener('mouseleave', hide);
  window.addEventListener('resize', function () { if (open) { size(); } });
  document.addEventListener('keydown', function (e) { if (e.keyCode === 27) { hide(); } });
  // A character that has finished drops its mask and animation and becomes plain text; dozens of
  // masked, filtered layers kept alive can make Chromium skip painting some of them.
  poem.addEventListener('animationend', function (e) { if (e.target.className === 'egg-ch') { e.target.className = 'egg-ch egg-done'; } });
}());
