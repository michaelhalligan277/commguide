/* Comm Guide — Incident (ICS-205) import: photo -> table grid -> per-cell OCR -> review -> saved zone.
   Everything runs on this phone. Lazy-loaded from the app menu; needs incident-core.js first. */
(function () {
  'use strict';
  var C = window.CGInc;
  var OVKEY = 'cg_overrides_v1', INCKEY = 'cg_incident_v1', OCR_CACHE = 'cg-ocr-v1';
  var OCR_FILES = ['vendor/ocr/tesseract.min.js', 'vendor/ocr/worker.min.js', 'vendor/ocr/tesseract-core-simd-lstm.wasm.js',
    'vendor/ocr/tesseract-core-lstm.wasm.js', 'vendor/ocr/lang/eng.traineddata.gz'];

  function abs(p) { return new URL(p, document.baseURI).href; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function loadOv() { try { return JSON.parse(localStorage.getItem(OVKEY) || 'null') || {}; } catch (e) { return {}; } }
  function loadInc() { try { return JSON.parse(localStorage.getItem(INCKEY) || 'null'); } catch (e) { return null; } }

  // =====================================================================
  // Vision helpers (canvas only, no libraries)
  // =====================================================================
  function loadToCanvas(file, maxSide) {
    return (window.createImageBitmap ? createImageBitmap(file, { imageOrientation: 'from-image' }) : Promise.reject())
      .catch(function () {
        return new Promise(function (res, rej) {
          var u = URL.createObjectURL(file), im = new Image();
          im.onload = function () { res(im); }; im.onerror = rej; im.src = u;
        });
      }).then(function (bm) {
        var w = bm.width, h = bm.height, k = Math.min(1, maxSide / Math.max(w, h));
        var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
        var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bm, 0, 0, c.width, c.height);
        return c;
      });
  }
  function rotateCanvas(src, deg) {
    deg = ((deg % 360) + 360) % 360;
    if (!deg) return src;
    var sw = src.width, sh = src.height, swap = (deg === 90 || deg === 270);
    var c = document.createElement('canvas'); c.width = swap ? sh : sw; c.height = swap ? sw : sh;
    var x = c.getContext('2d'); x.translate(c.width / 2, c.height / 2); x.rotate(deg * Math.PI / 180); x.drawImage(src, -sw / 2, -sh / 2);
    return c;
  }
  function rotateSmall(src, angleRad) {
    var c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
    var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.translate(c.width / 2, c.height / 2); x.rotate(angleRad); x.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }
  function grayOf(canvas) {
    var w = canvas.width, h = canvas.height, d = canvas.getContext('2d').getImageData(0, 0, w, h).data, g = new Uint8ClampedArray(w * h);
    for (var i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return { w: w, h: h, g: g };
  }
  function binarize(G) { // adaptive threshold via integral image: dark = clearly darker than neighbourhood
    var w = G.w, h = G.h, g = G.g, W = w + 1, I = new Uint32Array(W * (h + 1)), x, y;
    for (y = 0; y < h; y++) { var rs = 0; for (x = 0; x < w; x++) { rs += g[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + rs; } }
    var r = Math.max(8, Math.round(Math.min(w, h) / 70)), bin = new Uint8Array(w * h);
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        var n = (x1 - x0) * (y1 - y0), s = I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
        var v = g[y * w + x];
        bin[y * w + x] = (v < (s / n) * 0.82 && v < 175) ? 1 : 0;
      }
    }
    return bin;
  }
  function skewAngle(bin, w, h) { // best angle in [-4,4] deg: the one that makes ruled lines sharpest
    var step = Math.max(1, Math.floor(Math.max(w, h) / 900)), pts = [], x, y;
    for (y = 0; y < h; y += step) for (x = 0; x < w; x += step) if (bin[y * w + x]) pts.push(x, y);
    var best = 0, bestScore = -1, a;
    for (a = -4; a <= 4.001; a += 0.25) {
      var t = Math.tan(a * Math.PI / 180), hist = new Uint32Array(h + w + 8), off = w;
      for (var i = 0; i < pts.length; i += 2) { var yy = Math.round(pts[i + 1] - pts[i] * t) + off; if (yy >= 0 && yy < hist.length) hist[yy]++; }
      var sc = 0; for (var k = 0; k < hist.length; k++) sc += hist[k] * hist[k];
      if (sc > bestScore) { bestScore = sc; best = a; }
    }
    return best;
  }
  function clusters(flags) { // runs of true -> centres
    var out = [], s = -1, i;
    for (i = 0; i <= flags.length; i++) {
      if (i < flags.length && flags[i]) { if (s < 0) s = i; }
      else if (s >= 0) { out.push((s + i - 1) / 2); s = -1; }
    }
    return out;
  }
  // Find ruled table: equally spaced horizontal lines (data rows) and the vertical lines across them.
  function detectGrid(bin, w, h) {
    var rs = new Uint32Array(h), x, y, mx = 0;
    for (y = 0; y < h; y++) { var c = 0; for (x = 0; x < w; x++) c += bin[y * w + x]; rs[y] = c; if (c > mx) mx = c; }
    var hl = clusters(Array.prototype.map.call(rs, function (v) { return v >= mx * 0.55; }));
    if (hl.length < 8) return null;
    var bestI = 0, bestLen = 0, i, j;
    for (i = 0; i < hl.length - 2; i++) {
      var d0 = hl[i + 1] - hl[i]; if (d0 < 12) continue;
      j = i + 1;
      while (j + 1 < hl.length && Math.abs((hl[j + 1] - hl[j]) - d0) <= 0.25 * d0) j++;
      if (j - i > bestLen) { bestLen = j - i; bestI = i; }
    }
    if (bestLen < 8) return null;
    var rows = hl.slice(bestI, bestI + bestLen + 1), yTop = rows[0], yBot = rows[rows.length - 1];
    var cs = new Uint32Array(w), y0 = Math.round(yTop), y1 = Math.round(yBot);
    for (x = 0; x < w; x++) { var cc = 0; for (y = y0; y <= y1; y++) cc += bin[y * w + x]; cs[x] = cc; }
    var vl = clusters(Array.prototype.map.call(cs, function (v) { return v >= (y1 - y0) * 0.55; }));
    return { rows: rows, cols: vl };
  }

  // Prepare one cell for OCR: crop, upscale, flatten light background/watermark, add white margin.
  function prepCell(srcCanvas, G, bin, x0, y0, x1, y1) {
    var cw = x1 - x0, ch = y1 - y0; if (cw < 6 || ch < 6) return null;
    var ink = 0, x, y;
    for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) ink += bin[y * G.w + x];
    if (ink / (cw * ch) < 0.02) return null; // empty cell
    var sc = Math.max(1.5, Math.min(3.2, 96 / ch)), pad = 14;
    var c = document.createElement('canvas'); c.width = Math.round(cw * sc) + pad * 2; c.height = Math.round(ch * sc) + pad * 2;
    var cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
    cx.imageSmoothingQuality = 'high'; cx.drawImage(srcCanvas, x0, y0, cw, ch, pad, pad, c.width - pad * 2, c.height - pad * 2);
    var im = cx.getImageData(0, 0, c.width, c.height), d = im.data, lo = 255, i;
    for (i = 0; i < d.length; i += 4) { var v = (d[i] + d[i + 1] + d[i + 2]) / 3; if (v < lo) lo = v; }
    var hi = 175; lo = Math.min(lo, 90);
    for (i = 0; i < d.length; i += 4) {
      var g = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8, o = (g - lo) * 255 / (hi - lo); o = o < 0 ? 0 : o > 255 ? 255 : o;
      d[i] = d[i + 1] = d[i + 2] = o;
    }
    cx.putImageData(im, 0, 0);
    return c;
  }

  // A frequency is read three ways (slightly larger, black-and-white, larger black-and-white).
  // The majority wins; if the readings disagree the cell is flagged and the alternatives offered.
  function variant(cv, scale, binar) {
    var c = document.createElement('canvas'); c.width = Math.round(cv.width * scale); c.height = Math.round(cv.height * scale);
    var x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cv, 0, 0, c.width, c.height);
    if (binar) { var im = x.getImageData(0, 0, c.width, c.height), d = im.data; for (var i = 0; i < d.length; i += 4) { var v = d[i] < 140 ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = v; } x.putImageData(im, 0, 0); }
    return c;
  }
  function voteRead(worker, cv) {
    var vs = [variant(cv, 1.3, false), variant(cv, 1, true), variant(cv, 1.6, true)], out = [];
    return vs.reduce(function (p, v) { return p.then(function () { return worker.recognize(v).then(function (r) { out.push((r.data.text || '').trim()); }); }); }, Promise.resolve()).then(function () {
      var cnt = {}; out.forEach(function (t) { cnt[t] = (cnt[t] || 0) + 1; });
      var ranked = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; });
      return { text: ranked[0], alts: ranked.slice(1), agree: ranked.length === 1 };
    });
  }

  // =====================================================================
  // OCR engine (Tesseract.js, vendored, lazy)
  // =====================================================================
  var workerP = null;
  function getWorker(onStatus) {
    if (workerP) return workerP;
    workerP = new Promise(function (res, rej) {
      function mk() {
        onStatus && onStatus('Starting reader…');
        window.Tesseract.createWorker('eng', 1, { workerPath: abs('vendor/ocr/worker.min.js'), corePath: abs('vendor/ocr/'), langPath: abs('vendor/ocr/lang'), gzip: true })
          .then(res, rej);
      }
      if (window.Tesseract) return mk();
      var s = document.createElement('script'); s.src = abs('vendor/ocr/tesseract.min.js'); s.onload = mk; s.onerror = function () { rej(new Error('Could not load the reader. Open this screen once while online.')); };
      document.head.appendChild(s);
    }).catch(function (e) { workerP = null; throw e; });
    return workerP;
  }
  function ocr(worker, canvas, psm, whitelist) {
    return worker.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: whitelist || '' })
      .then(function () { return worker.recognize(canvas); })
      .then(function (r) { return { text: (r.data.text || '').trim(), conf: r.data.confidence }; });
  }
  var COLCFG = [ // [psm, whitelist]
    [7, '0123456789'], [6, ''], [6, ''], [6, ''], [7, '0123456789.'], [7, '0123456789.()T'], [7, '0123456789.'], [7, '0123456789.()T'], [10, 'ADMN'], [6, '']];

  function scanImage(file, progress) {
    var work, bin, G, grid, rot = 0, worker;
    progress('Loading photo…', 0.02);
    return loadToCanvas(file, 2600).then(function (cv) {
      work = cv;
      return getWorker(function (m) { progress(m, 0.05); });
    }).then(function (w) {
      worker = w;
      progress('Straightening and finding the table…', 0.1);
      // try the page as is, then turned 90 degrees (the form is landscape), looking for the ruled table
      var tried = [];
      function attempt(deg) {
        var cv = rotateCanvas(work, deg), g0 = grayOf(cv), b0 = binarize(g0), ang = skewAngle(b0, g0.w, g0.h);
        if (Math.abs(ang) > 0.2) { cv = rotateSmall(cv, -ang * Math.PI / 180); g0 = grayOf(cv); b0 = binarize(g0); }
        var gr = detectGrid(b0, g0.w, g0.h);
        tried.push(deg);
        return { cv: cv, G: g0, bin: b0, grid: gr };
      }
      var a = attempt(0);
      var okGrid = function (r) { return r.grid && r.grid.cols.length === 11 && r.grid.rows.length >= 9; };
      if (!okGrid(a)) { var b = attempt(90); if (okGrid(b)) a = b; else { var c = attempt(270); if (okGrid(c)) a = c; else a = okGrid(a) ? a : (okGrid(b) ? b : null); } }
      if (!a) throw new Error('Could not find the radio table. Lay the page flat, fill the frame, keep it level and well lit, then try again.');
      work = a.cv; G = a.G; bin = a.bin; grid = a.grid;
      // Upside down? Read the header row both ways.
      progress('Checking page direction…', 0.2);
      var hy0 = Math.max(0, Math.round(grid.rows[0] - (grid.rows[1] - grid.rows[0]) * 1.05)), hy1 = Math.round(grid.rows[0]);
      function headerScore(cv, y0, y1) {
        var p = prepCell(cv, grayOf(cv), binarize(grayOf(cv)), 4, y0 + 2, cv.width - 4, y1 - 2); if (!p) return Promise.resolve(0);
        return ocr(worker, p, 7, '').then(function (r) { var m = r.text.match(/Function|Assigned|Notes|Mode|Name|Freq|Tone/gi); return m ? m.length : 0; });
      }
      return headerScore(work, hy0, hy1).then(function (s0) {
        if (s0 >= 2) return;
        var flipped = rotateCanvas(work, 180), g1 = grayOf(flipped), b1 = binarize(g1), gr1 = detectGrid(b1, g1.w, g1.h);
        if (!gr1 || gr1.cols.length !== 11) return;
        var y0 = Math.max(0, Math.round(gr1.rows[0] - (gr1.rows[1] - gr1.rows[0]) * 1.05)), y1 = Math.round(gr1.rows[0]);
        return headerScore(flipped, y0, y1).then(function (s1) { if (s1 > s0) { work = flipped; G = g1; bin = b1; grid = gr1; } });
      });
    }).then(function () {
      var rows = grid.rows, cols = grid.cols, nR = rows.length - 1, cells = [], r, c, jobs = [], inset = 4;
      // header (top of page) and footer text blocks
      var topY = Math.max(0, Math.round(rows[0] - (rows[1] - rows[0]) * 0.1)), botY = Math.round(rows[rows.length - 1]);
      var pre = prepCell(work, G, bin, 4, 4, G.w - 4, Math.max(40, topY - 2));
      var post = prepCell(work, G, bin, 4, botY + 3, G.w - 4, G.h - 4);
      for (r = 0; r < nR; r++) {
        var row = { pos: r + 1, ch: '', func: '', name: '', assigned: '', rx: '', rxTone: '', tx: '', txTone: '', mode: '', notes: '', conf: null };
        cells.push(row);
      }
      // OCR column by column (one setParameters per column)
      var total = nR * 10, done = 0, confs = [];
      var seq = Promise.resolve();
      for (c = 0; c < 10; c++) (function (c) {
        seq = seq.then(function () {
          return worker.setParameters({ tessedit_pageseg_mode: String(COLCFG[c][0]), tessedit_char_whitelist: COLCFG[c][1] }).then(function () {
            var p = Promise.resolve();
            for (var rr = 0; rr < nR; rr++) (function (rr) {
              p = p.then(function () {
                var cv = prepCell(work, G, bin, Math.round(cols[c]) + inset, Math.round(rows[rr]) + inset, Math.round(cols[c + 1]) - inset, Math.round(rows[rr + 1]) - inset);
                done++; progress('Reading the channel table… ' + Math.round(done / total * 100) + '%', 0.25 + 0.65 * done / total);
                if (!cv) return null;
                if (c === 4 || c === 6) {
                  return voteRead(worker, cv).then(function (v) {
                    var k = C.COLS[c]; cells[rr][k] = v.text; cells[rr][k + 'Alts'] = v.alts; cells[rr][k + 'Dis'] = !v.agree;
                  });
                }
                return worker.recognize(cv).then(function (res) {
                  cells[rr][C.COLS[c]] = (res.data.text || '').trim();
                  if (c === 2) { var cf = cells[rr]._cf = (cells[rr]._cf || []); cf.push(res.data.confidence); }
                });
              });
            })(rr);
            return p;
          });
        });
      })(c);
      return seq.then(function () {
        progress('Reading the page header…', 0.92);
        var head = '', foot = '';
        return worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' })
          .then(function () { return pre ? worker.recognize(pre) : null; }).then(function (r) { head = r ? r.data.text : ''; })
          .then(function () { return post ? worker.recognize(post) : null; }).then(function (r) { foot = r ? r.data.text : ''; })
          .then(function () {
            cells.forEach(function (c) { if (c._cf) { c.conf = Math.min.apply(null, c._cf); delete c._cf; } });
            return { cells: cells, head: head, foot: foot };
          });
      });
    });
  }

  // =====================================================================
  // Offline engine files
  // =====================================================================
  function ocrReady() {
    if (!window.caches) return Promise.resolve(false);
    return caches.open(OCR_CACHE).then(function (ch) {
      return Promise.all(OCR_FILES.map(function (f) { return ch.match(abs(f)); }));
    }).then(function (r) { return r.every(Boolean); }).catch(function () { return false; });
  }
  function prepareOffline(progress) {
    return caches.open(OCR_CACHE).then(function (ch) {
      var p = Promise.resolve(), n = 0;
      OCR_FILES.forEach(function (f) {
        p = p.then(function () {
          return ch.match(abs(f)).then(function (hit) {
            if (hit) { n++; return; }
            return fetch(abs(f)).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return ch.put(abs(f), r.clone()).then(function () { return r.arrayBuffer(); }); })
              .then(function () { n++; progress && progress(n, OCR_FILES.length); });
          });
        });
      });
      return p;
    });
  }

  // =====================================================================
  // UI
  // =====================================================================
  var FLAGTXT = {
    'freq-band': 'Frequency is outside the radio bands', 'freq-step': 'Not on a 2.5 kHz step — check the digits',
    'freq-format': 'Frequency not readable', 'freq-short': 'Frequency had too few digits', 'freq-missing': 'No frequency read',
    'rx-tx-1digit': 'RX and TX differ by one digit — check both', 'freq-disagree': 'Readings disagree — check the digits against the form', 'freq-disagree-known': 'Readings disagreed, but this matches a channel already in the app', 'tone-mismatch': 'Tone number and Hz disagree',
    'tone-fixed': 'Tone repaired from the tone number', 'tone-unreadable': 'Tone not readable', 'tone-missing': 'Tone cell looks blank',
    'differs-from-load': 'Differs from the statewide load', 'low-confidence': 'Low reading confidence', 'mode-odd': 'Unusual mode'
  };
  var SEV = { 'freq-band': 2, 'freq-step': 2, 'freq-format': 2, 'freq-short': 2, 'freq-missing': 2, 'freq-disagree': 2, 'freq-disagree-known': 1, 'rx-tx-1digit': 2, 'tone-mismatch': 2, 'tone-unreadable': 2,
    'tone-fixed': 1, 'tone-missing': 1, 'differs-from-load': 1, 'low-confidence': 1, 'mode-odd': 1 };
  var host = null, state = { rows: [], meta: null, open: -1, busy: false }, known = null;

  function ensureHost() {
    if (host) return host;
    host = document.createElement('div'); host.id = 'cg-inc-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:100000;display:none;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif';
    document.body.appendChild(host); return host;
  }
  function shell(title, body, onBack) {
    var h = ensureHost(); h.style.display = 'block';
    h.innerHTML = '<div data-x="close" style="position:absolute;inset:0;background:rgba(4,6,8,.6)"></div>' +
      '<div style="position:absolute;left:0;right:0;bottom:0;max-height:94%;display:flex;flex-direction:column;background:#0E1214;border-top:1px solid #2a3439;border-radius:16px 16px 0 0">' +
      '<div style="display:flex;align-items:center;gap:10px;padding:14px 16px 10px;border-bottom:1px solid #1c2226;flex-shrink:0">' +
      (onBack ? '<button data-x="back" style="background:none;border:none;color:#9AA3AE;font-size:22px;padding:0 6px;min-height:36px">‹</button>' : '') +
      '<div style="flex:1;font:700 15px Helvetica,Arial,sans-serif;color:#ECEEF1">' + esc(title) + '</div>' +
      '<button data-x="close" aria-label="Close" style="background:none;border:none;color:#9AA3AE;font-size:18px;min-width:40px;min-height:40px">✕</button></div>' +
      '<div id="cg-inc-body" style="overflow:auto;padding:14px 16px calc(18px + env(safe-area-inset-bottom,0px));-webkit-overflow-scrolling:touch">' + body + '</div></div>';
    h.querySelectorAll('[data-x="close"]').forEach(function (b) { b.onclick = close; });
    var bk = h.querySelector('[data-x="back"]'); if (bk && onBack) bk.onclick = onBack;
    return h.querySelector('#cg-inc-body');
  }
  function close() { if (host) { host.style.display = 'none'; host.innerHTML = ''; } state.busy = false; }
  function btn(id, label, kind, extra) {
    var bg = kind === 'go' ? '#2f7d4f' : kind === 'warn' ? '#6b2a2d' : '#1b2328';
    return '<button id="' + id + '" style="width:100%;min-height:48px;margin-top:10px;background:' + bg + ';color:#fff;border:1px solid #2a3439;border-radius:12px;font:700 15px Helvetica,Arial,sans-serif;' + (extra || '') + '">' + label + '</button>';
  }
  function note(t, c) { return '<div style="font-size:12px;line-height:1.55;color:' + (c || '#828B97') + ';margin-top:8px">' + t + '</div>'; }

  function opEnded(m) {
    try {
      var d = m.dateTo && m.dateTo.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (!d) return false;
      var y = +d[3]; if (y < 100) y += 2000;
      var t = (m.timeTo || '0000').padStart(4, '0');
      return Date.now() > new Date(y, +d[1] - 1, +d[2], +t.slice(0, 2), +t.slice(2)).getTime();
    } catch (e) { return false; }
  }

  function home() {
    var inc = loadInc(), b = '';
    if (inc) {
      var ended = opEnded(inc.meta);
      b += '<div style="background:#161C1F;border:1px solid #2A3439;border-left:4px solid #FF8A3D;border-radius:12px;padding:12px 14px">' +
        '<div style="font:700 15px Helvetica,Arial,sans-serif;color:#ECEEF1">' + esc([inc.meta.incident, inc.meta.zone].filter(Boolean).join(' · ') || 'Incident') + '</div>' +
        '<div style="font:500 12px Helvetica,Arial,sans-serif;color:#7A828C;margin-top:3px">' + inc.rows.length + ' channels · ' + esc(inc.meta.dateFrom || '') + ' ' + esc(inc.meta.timeFrom || '') + ' to ' + esc(inc.meta.dateTo || '') + ' ' + esc(inc.meta.timeTo || '') + '</div>' +
        (ended ? '<div style="margin-top:8px;font:700 12px Helvetica,Arial,sans-serif;color:#FFB23E">Operational period has ended — scan the new ICS-205 or remove this incident.</div>' : '') +
        '<div style="font-size:12px;color:#828B97;margin-top:8px">Find it under <b>Channels</b> for your unit: “ZONE INC”.</div></div>' +
        btn('inc-scan', 'Scan a new ICS-205', 'go') + btn('inc-del', 'Remove this incident', 'warn');
    } else {
      b += '<div style="font-size:13px;line-height:1.6;color:#ECEEF1">Take a photo of the ICS-205 (radio communications plan) from the IAP, or choose one from your photos. ' +
        'The channels load as an <b>INC</b> zone you can use offline.</div>';
      b += btn('inc-scan', 'Take or choose a photo', 'go');
    }
    b += '<div id="inc-off" style="margin-top:14px"></div>';
    b += note('Tips: lay the page flat, fill the frame, keep it level, good light, no glare. Everything is read on this phone — nothing is uploaded. ' +
      'IAP forms are marked <b>Controlled Unclassified Information</b>; make sure storing them on a personal phone is allowed for your unit. Always check the radio against the form.', '#828B97');
    var body = shell('Incident · ICS-205', b, null);
    var sc = body.querySelector('#inc-scan'); if (sc) sc.onclick = pick;
    var dl = body.querySelector('#inc-del'); if (dl) dl.onclick = function () { if (confirm('Remove this incident and its channels from this phone?')) removeIncident(); };
    ocrReady().then(function (ok) {
      var el = document.getElementById('inc-off'); if (!el) return;
      el.innerHTML = ok ? '<div style="font-size:12px;color:#5BD06A">✓ Reader saved on this phone — works with no signal.</div>' :
        '<div style="font-size:12px;color:#FFB23E;line-height:1.5">The reader (about 11 MB) isn’t saved on this phone yet. Download it now while you have signal so scanning works on the fireline.</div>' +
        '<button id="inc-prep" style="width:100%;min-height:44px;margin-top:8px;background:#1b2328;color:#fff;border:1px solid #2a3439;border-radius:12px;font:700 14px Helvetica,Arial,sans-serif">Download reader for offline use</button>';
      var p = document.getElementById('inc-prep');
      if (p) p.onclick = function () {
        p.disabled = true; p.textContent = 'Downloading…';
        prepareOffline(function (n, t) { p.textContent = 'Downloading… ' + n + ' of ' + t; }).then(function () { home(); }, function (e) { p.disabled = false; p.textContent = 'Failed — tap to retry (' + e.message + ')'; });
      };
    });
  }

  function pick() {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = function () { if (inp.files && inp.files[0]) run(inp.files[0]); };
    inp.click();
  }

  function run(file) {
    state.busy = true;
    var body = shell('Reading the form…', '<div id="inc-msg" style="font-size:14px;color:#ECEEF1">Starting…</div>' +
      '<div style="height:8px;background:#1b2328;border-radius:4px;margin-top:12px;overflow:hidden"><div id="inc-bar" style="height:100%;width:2%;background:#FF8A3D;transition:width .2s"></div></div>' +
      note('This can take 20–40 seconds. Keep the screen on.'), null);
    function progress(m, f) { var a = document.getElementById('inc-msg'), b = document.getElementById('inc-bar'); if (a) a.textContent = m; if (b) b.style.width = Math.round(f * 100) + '%'; }
    var t0 = Date.now();
    scanImage(file, progress).then(function (res) {
      if (!known) known = C.buildKnown(window.RADIO || {});
      var cells = res.cells.filter(function (c) {
        return c.func.replace(/[^A-Za-z]/g, '').length >= 3 || /\d{3}\.?\d{3}/.test((c.rx || '') + (c.tx || ''));
      });
      state.rows = C.buildRows(cells, known);
      var h = C.parseHeader(res.head), f = C.parseFooter(res.foot);
      state.meta = { incident: h.incident, zone: h.zone, dateFrom: h.dateFrom, timeFrom: h.timeFrom, dateTo: h.dateTo, timeTo: h.timeTo, prepared: f.prepared, special: f.special };
      state.open = -1; state.busy = false; state.secs = Math.round((Date.now() - t0) / 1000);
      review();
    }).catch(function (e) {
      state.busy = false;
      var b = shell('Could not read that photo', '<div style="font-size:13px;line-height:1.6;color:#ECEEF1">' + esc(e.message || String(e)) + '</div>' + btn('inc-again', 'Try another photo', 'go') + btn('inc-home', 'Back', ''), null);
      b.querySelector('#inc-again').onclick = pick; b.querySelector('#inc-home').onclick = home;
    });
  }

  function worst(r) { var w = 0; (r.flags || []).forEach(function (f) { w = Math.max(w, SEV[f] || 1); }); return w; }
  function fld(label, key, r, i, w, mono) {
    var ff = (r.fieldFlags && r.fieldFlags[key]) || [], bad = ff.some(function (f) { return (SEV[f] || 1) === 2; }), warn = ff.length;
    return '<label style="display:block;flex:' + (w || 1) + ';min-width:0"><span style="font:600 10px Helvetica,Arial,sans-serif;letter-spacing:.06em;color:#7A828C">' + label + '</span>' +
      '<input data-i="' + i + '" data-k="' + key + '" value="' + esc(r[key]) + '" autocomplete="off" autocapitalize="characters" style="width:100%;box-sizing:border-box;min-height:42px;margin-top:2px;background:#0b0f11;color:#ECEEF1;border:1px solid ' + (bad ? '#FF6B6B' : warn ? '#FFB23E' : '#2a3439') + ';border-radius:8px;padding:6px 8px;font:500 14px ' + (mono ? "'Spline Sans Mono',monospace" : 'Helvetica,Arial,sans-serif') + '"></label>';
  }
  function card(r, i) {
    var w = worst(r), open = state.open === i, color = w === 2 ? '#FF6B6B' : w === 1 ? '#FFB23E' : '#2E7D46';
    var sum = '<div style="display:flex;align-items:center;gap:10px"><div style="min-width:34px;font:700 13px \'Spline Sans Mono\',monospace;color:#7A828C">' + esc(r.ch) + '</div>' +
      '<div style="flex:1;min-width:0"><div style="font:700 14px Helvetica,Arial,sans-serif;color:#ECEEF1">' + esc(r.name || '—') + ' <span style="font-weight:400;color:#7A828C">· ' + esc(r.assigned || r.func) + '</span></div>' +
      '<div style="font:500 12px \'Spline Sans Mono\',monospace;color:#B8C0C8;margin-top:2px">RX ' + esc(r.rx || '—') + ' ' + esc(r.rxTone && r.rxTone !== 'None' ? r.rxTone : '') + ' · TX ' + esc(r.tx || '—') + ' ' + esc(r.txTone && r.txTone !== 'None' ? r.txTone : '') + '</div></div>' +
      '<div style="width:10px;height:10px;border-radius:50%;background:' + (r.ok ? '#2E7D46' : color) + '"></div></div>';
    var det = '';
    if (open) {
      det = '<div style="margin-top:10px">' +
        '<div style="display:flex;gap:8px">' + fld('CH', 'ch', r, i, 0.6, 1) + fld('FUNCTION', 'func', r, i, 1.4) + fld('NAME', 'name', r, i, 1.4) + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:8px">' + fld('ASSIGNED TO', 'assigned', r, i, 2) + fld('MODE', 'mode', r, i, 0.5) + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:8px">' + fld('RX FREQ', 'rx', r, i, 1.3, 1) + fld('RX TONE', 'rxTone', r, i, 1, 1) + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:8px">' + fld('TX FREQ', 'tx', r, i, 1.3, 1) + fld('TX TONE', 'txTone', r, i, 1, 1) + '</div>' +
        '<div style="margin-top:8px">' + fld('NOTES', 'notes', r, i, 1) + '</div>';
      (r.flags || []).forEach(function (f) { det += '<div style="font-size:12px;color:' + ((SEV[f] || 1) === 2 ? '#FF9A9A' : '#FFD07A') + ';margin-top:7px">⚠ ' + esc(FLAGTXT[f] || f) + (f === 'differs-from-load' && r.loadHint ? ' (load: ' + esc(r.loadHint) + ')' : '') + '</div>'; });
      var sg = r.suggest || {};
      Object.keys(sg).forEach(function (k) {
        (sg[k] || []).forEach(function (v) {
          det += '<button data-sg="' + i + '|' + k + '|' + esc(v) + '" style="margin:8px 8px 0 0;min-height:38px;background:#1b2328;color:#ECEEF1;border:1px solid #4C8DFF;border-radius:19px;padding:0 14px;font:600 13px \'Spline Sans Mono\',monospace">Use ' + k.toUpperCase().replace('TONE', ' tone') + ' ' + esc(v) + '</button>';
        });
      });
      det += '<div style="display:flex;gap:8px;margin-top:12px"><button data-ok="' + i + '" style="flex:1;min-height:44px;background:#2f7d4f;color:#fff;border:0;border-radius:10px;font:700 14px Helvetica,Arial,sans-serif">' + (r.ok ? '✓ Checked against the form' : 'Mark checked') + '</button>' +
        '<button data-del="' + i + '" style="min-height:44px;padding:0 16px;background:#3a1b1d;color:#ff9a9a;border:0;border-radius:10px;font:700 14px Helvetica,Arial,sans-serif">Delete</button></div></div>';
    }
    return '<div data-card="' + i + '" style="background:#161C1F;border:1px solid #2A3439;border-left:4px solid ' + (r.ok ? '#2E7D46' : color) + ';border-radius:12px;padding:11px 12px;margin-bottom:8px"><div data-open="' + i + '" style="cursor:pointer">' + sum + '</div>' + det + '</div>';
  }
  function revalidate(i, changed) {
    var r = state.rows[i];
    var raw = { pos: r.pos, ch: r.ch, func: r.func, name: r.name, assigned: r.assigned, rx: r.rx, rxTone: r.rxTone, tx: r.tx, txTone: r.txTone, mode: r.mode, notes: r.notes };
    // keep the doubt about a frequency the person has not touched
    ['rx', 'tx'].forEach(function (k) { if (changed !== k && r[k + 'Dis']) { raw[k + 'Dis'] = true; raw[k + 'Alts'] = r[k + 'Alts'] || []; } });
    var nr = C.buildRows([raw], known)[0]; nr.ok = false; state.rows[i] = nr;
  }
  function review() {
    var m = state.meta, flagged = state.rows.filter(function (r) { return !r.ok && worst(r) > 0; }).length;
    var mf = function (label, key, w) { return '<label style="flex:' + (w || 1) + ';min-width:0"><span style="font:600 10px Helvetica,Arial,sans-serif;letter-spacing:.06em;color:#7A828C">' + label + '</span><input data-m="' + key + '" value="' + esc(m[key]) + '" style="width:100%;box-sizing:border-box;min-height:42px;margin-top:2px;background:#0b0f11;color:#ECEEF1;border:1px solid #2a3439;border-radius:8px;padding:6px 8px;font:500 14px Helvetica,Arial,sans-serif"></label>'; };
    var b = '<div style="font-size:13px;line-height:1.55;color:#ECEEF1">' + state.rows.length + ' channels read in ' + state.secs + ' s. <b style="color:' + (flagged ? '#FFB23E' : '#5BD06A') + '">' + (flagged ? flagged + ' to check' : 'None flagged') + '</b> — tap a channel, compare it with the form, fix anything wrong, then save.</div>' +
      '<div style="display:flex;gap:8px;margin:12px 0 6px">' + mf('INCIDENT', 'incident', 1.2) + mf('ZONE / DIVISION', 'zone', 1) + '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:12px">' + mf('FROM', 'dateFrom') + mf('TIME', 'timeFrom', 0.6) + mf('TO', 'dateTo') + mf('TIME', 'timeTo', 0.6) + '</div>' +
      state.rows.map(card).join('') + btn('inc-save', 'Save as INC zone', 'go') + btn('inc-redo', 'Scan a different photo', '') +
      note('Frequencies are never changed automatically. Amber/red items are things the app could not confirm — check them against the printed form before you rely on them.');
    var body = shell('Check the channels', b, null);
    wire(body);
  }
  function wire(body) {
    body.querySelectorAll('[data-open]').forEach(function (e) { e.onclick = function () { var i = +e.getAttribute('data-open'); state.open = state.open === i ? -1 : i; var y = body.scrollTop; review(); document.getElementById('cg-inc-body').scrollTop = y; }; });
    body.querySelectorAll('input[data-k]').forEach(function (e) {
      e.onchange = function () {
        var i = +e.getAttribute('data-i'), k = e.getAttribute('data-k'); state.rows[i][k] = e.value.trim(); revalidate(i, k);
        var y = document.getElementById('cg-inc-body').scrollTop; review(); document.getElementById('cg-inc-body').scrollTop = y;
      };
    });
    body.querySelectorAll('input[data-m]').forEach(function (e) { e.onchange = function () { state.meta[e.getAttribute('data-m')] = e.value.trim(); }; });
    body.querySelectorAll('[data-sg]').forEach(function (e) {
      e.onclick = function () {
        var p = e.getAttribute('data-sg').split('|'), i = +p[0]; state.rows[i][p[1]] = p.slice(2).join('|'); revalidate(i, p[1]);
        var y = document.getElementById('cg-inc-body').scrollTop; review(); document.getElementById('cg-inc-body').scrollTop = y;
      };
    });
    body.querySelectorAll('[data-ok]').forEach(function (e) { e.onclick = function () { var i = +e.getAttribute('data-ok'); state.rows[i].ok = !state.rows[i].ok; var y = document.getElementById('cg-inc-body').scrollTop; review(); document.getElementById('cg-inc-body').scrollTop = y; }; });
    body.querySelectorAll('[data-del]').forEach(function (e) { e.onclick = function () { state.rows.splice(+e.getAttribute('data-del'), 1); state.open = -1; review(); }; });
    body.querySelector('#inc-redo').onclick = function () { if (confirm('Discard what was just read?')) pick(); };
    body.querySelector('#inc-save').onclick = function () {
      var left = state.rows.filter(function (r) { return !r.ok && worst(r) === 2; }).length;
      if (left && !confirm(left + ' channel' + (left > 1 ? 's are' : ' is') + ' still flagged red. Save anyway?')) return;
      save();
    };
  }

  function save() {
    try {
      var zone = C.buildZone(state.meta, state.rows);
      var ov = loadOv(); ov.ADDZ = ov.ADDZ || {};
      var list = (ov.ADDZ.HOME || []).filter(function (z) { return !z.incident; });
      list.unshift(zone); ov.ADDZ.HOME = list;
      localStorage.setItem(OVKEY, JSON.stringify(ov));
      localStorage.setItem(INCKEY, JSON.stringify({ meta: state.meta, rows: state.rows.map(function (r) { return { ch: r.ch, name: r.name, func: r.func, assigned: r.assigned, rx: r.rx, rxTone: r.rxTone, tx: r.tx, txTone: r.txTone, mode: r.mode, notes: r.notes }; }), savedAt: Date.now() }));
    } catch (e) { alert('Could not save (storage blocked).'); return; }
    shell('Saved', '<div style="font-size:14px;line-height:1.6;color:#ECEEF1">Saved ' + state.rows.length + ' channels. They appear under <b>Channels</b> as “ZONE INC”.</div>' + btn('inc-ok', 'Open Channels', 'go'), null);
    document.getElementById('inc-ok').onclick = function () { try { sessionStorage.setItem('cg_open_tab', 'channels'); } catch (e) {} location.reload(); };
  }
  function removeIncident() {
    try {
      var ov = loadOv();
      if (ov.ADDZ && ov.ADDZ.HOME) { ov.ADDZ.HOME = ov.ADDZ.HOME.filter(function (z) { return !z.incident; }); if (!ov.ADDZ.HOME.length) delete ov.ADDZ.HOME; if (!Object.keys(ov.ADDZ).length) delete ov.ADDZ; }
      if (Object.keys(ov).length) localStorage.setItem(OVKEY, JSON.stringify(ov)); else localStorage.removeItem(OVKEY);
      localStorage.removeItem(INCKEY);
    } catch (e) {}
    location.reload();
  }

  // test hook (headless tests call the pipeline directly)
  window.__cgIncident = { open: home, scanImage: scanImage, detectGrid: detectGrid, state: state, setKnown: function (k) { known = k; } };
  window.__cgOpenIncident = home;
})();
