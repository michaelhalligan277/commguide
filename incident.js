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
  // ---- line segments (ruled tables) ----
  function mergeSegs(a, pk, k0, k1, tol) {
    a.sort(function (p, q) { return p[pk] - q[pk] || p[k0] - q[k0]; });
    var cl = [];
    a.forEach(function (s) {
      for (var i = cl.length - 1; i >= 0 && i >= cl.length - 12; i--) {
        var c = cl[i];
        if (s[pk] - c.last <= tol) {
          var ov = Math.min(c[k1], s[k1]) - Math.max(c[k0], s[k0]), len = Math.min(c[k1] - c[k0], s[k1] - s[k0]);
          if (ov > 0.6 * len) { c.n++; c.sum += s[pk]; c.last = s[pk]; c[k0] = Math.min(c[k0], s[k0]); c[k1] = Math.max(c[k1], s[k1]); return; }
        }
      }
      var o = { n: 1, sum: s[pk], last: s[pk] }; o[k0] = s[k0]; o[k1] = s[k1]; cl.push(o);
    });
    return cl.map(function (c) { var o = {}; o[pk] = c.sum / c.n; o[k0] = c[k0]; o[k1] = c[k1]; return o; });
  }
  function vsegs(bin, w, h, minLen, gap) {
    var out = [], x, y;
    for (x = 0; x < w; x++) {
      var s = -1, last = -1, miss = 0;
      for (y = 0; y <= h; y++) {
        var on = y < h && (bin[y * w + x] || (x > 0 && bin[y * w + x - 1]) || (x < w - 1 && bin[y * w + x + 1])); // 1 px tolerance for slight tilt
        if (on) { if (s < 0) s = y; last = y; miss = 0; }
        else if (s >= 0) { miss++; if (miss > gap || y === h) { if (last - s + 1 >= minLen) out.push({ x: x, y0: s, y1: last }); s = -1; miss = 0; } }
      }
    }
    return mergeSegs(out, 'x', 'y0', 'y1', 2);
  }
  function hsegs(bin, w, h, minLen, gap) {
    var out = [], x, y;
    for (y = 0; y < h; y++) {
      var s = -1, last = -1, miss = 0, o = y * w;
      for (x = 0; x <= w; x++) {
        var on = x < w && (bin[o + x] || (y > 0 && bin[o - w + x]) || (y < h - 1 && bin[o + w + x]));
        if (on) { if (s < 0) s = x; last = x; miss = 0; }
        else if (s >= 0) { miss++; if (miss > gap || x === w) { if (last - s + 1 >= minLen) out.push({ y: y, x0: s, x1: last }); s = -1; miss = 0; } }
      }
    }
    return mergeSegs(out, 'y', 'x0', 'x1', 2);
  }
  // ICS-204: find the resource table, the communications table and the header boxes from the ruled lines.
  function find204(bin, w, h) {
    var V = vsegs(bin, w, h, Math.round(0.04 * h), 3);
    if (V.length < 8) return null;
    var big = V.filter(function (v) { return v.y1 - v.y0 > 0.55 * h; });
    if (big.length < 2) return null;
    var xL = Math.min.apply(null, big.map(function (v) { return v.x; })), xR = Math.max.apply(null, big.map(function (v) { return v.x; }));
    if (xR - xL < 0.5 * w) return null;
    var inner = V.filter(function (v) { return v.x > xL + 0.012 * w && v.x < xR - 0.012 * w; }).sort(function (a, b) { return a.y0 - b.y0; });
    var tol = 0.012 * h, groups = [];
    inner.forEach(function (v) { // vertical lines that end at the same height belong to the same table
      var g = groups.filter(function (g) { return Math.abs(g.y1 - v.y1) <= tol; })[0];
      if (g) { g.xs.push(v.x); g.y0s.push(v.y0); } else groups.push({ y1: v.y1, xs: [v.x], y0s: [v.y0] });
    });
    groups.forEach(function (g) { g.xs.sort(function (a, b) { return a - b; }); g.y0s.sort(function (a, b) { return a - b; }); g.y0 = g.y0s[g.y0s.length >> 1]; });
    var comm = groups.filter(function (g) { return g.xs.length === 8; }).sort(function (a, b) { return b.y0 - a.y0; })[0];
    if (!comm) return null;
    var res = groups.filter(function (g) { return g.y1 < comm.y0 && g.xs.length >= 5 && g.xs.length <= 8 && g.y1 - g.y0 > 0.12 * h; }).sort(function (a, b) { return (b.y1 - b.y0) - (a.y1 - a.y0); })[0];
    if (!res) return null;
    var Hs = hsegs(bin, w, h, Math.round(0.25 * w), 4).filter(function (l) { return l.x1 - l.x0 >= 0.8 * (xR - xL); });
    // header boxes (1 incident, 2 operational period, 3 branch/division)
    var top = inner.filter(function (v) { return v.y1 < res.y0 - 5 && v.y0 < 0.3 * h; });
    var box = null;
    if (top.length) {
      var yb = Math.min.apply(null, top.map(function (v) { return v.y0; }));
      var tv = top.filter(function (v) { return Math.abs(v.y0 - yb) <= 0.02 * h; });
      var yt = Math.max.apply(null, tv.map(function (v) { return v.y1; }));
      box = { y0: yb, y1: yt, xs: tv.map(function (v) { return v.x; }).sort(function (a, b) { return a - b; }) };
    }
    // row lines of the communications table
    var ys = [comm.y0];
    Hs.filter(function (l) { return l.y > comm.y0 + 6 && l.y < comm.y1 - 6; }).forEach(function (l) { if (l.y - ys[ys.length - 1] > 8) ys.push(l.y); });
    if (comm.y1 - ys[ys.length - 1] > 8) ys.push(comm.y1); else ys[ys.length - 1] = comm.y1;
    var above = Hs.filter(function (l) { return l.y < res.y0 - 5; }), resTop = above.length ? above[above.length - 1].y : res.y0 - 30;
    var mid = Hs.filter(function (l) { return l.y > res.y1 + 6 && l.y < comm.y0 - 6; }).map(function (l) { return l.y; });
    var below = Hs.filter(function (l) { return l.y > comm.y1 + 6; }), footEnd = below.length ? below[0].y : Math.min(h - 2, comm.y1 + 0.06 * h);
    return { xL: xL, xR: xR, comm: comm, res: res, commYs: ys, box: box, resTop: resTop, mid: mid, footEnd: footEnd, Hs: Hs };
  }
  // text lines inside the resource table (data rows have no ruling, so find them by ink)
  function inkBands(bin, w, h, xs, y0, y1, xL, xR, Hs) {
    var prof = new Uint16Array(h), y, x;
    var skip = new Uint8Array(w);
    xs.concat([xL, xR]).forEach(function (vx) { for (var d = -4; d <= 4; d++) { var q = Math.round(vx) + d; if (q >= 0 && q < w) skip[q] = 1; } });
    var ruled = new Uint8Array(h);
    Hs.forEach(function (l) { for (var d = -Math.max(3, Math.round(h * 0.003)); d <= Math.max(3, Math.round(h * 0.003)); d++) { var q = Math.round(l.y) + d; if (q >= 0 && q < h) ruled[q] = 1; } });
    for (y = Math.round(y0); y < Math.round(y1); y++) {
      if (ruled[y]) continue;
      var c = 0, o = y * w; for (x = Math.round(xL) + 5; x < Math.round(xR) - 5; x++) if (!skip[x] && bin[o + x]) c++;
      prof[y] = c;
    }
    var bands = [], s = -1, miss = 0, gap = Math.max(4, Math.round(0.004 * h));
    for (y = Math.round(y0); y <= Math.round(y1); y++) {
      var on = y < Math.round(y1) && prof[y] >= 2;
      if (on) { if (s < 0) s = y; miss = 0; }
      else if (s >= 0) { miss++; if (miss > gap || y >= Math.round(y1)) { var e = y - miss; if (e - s >= 6) bands.push([s, e]); s = -1; miss = 0; } }
    }
    return bands;
  }

  var COLCFG = [ // [psm, whitelist, vote]
    [7, '0123456789'], [6, ''], [6, ''], [6, ''], [7, '0123456789.', 1], [7, '0123456789.()T'], [7, '0123456789.', 1], [7, '0123456789.()T'], [10, 'ADMN'], [6, '']];
  var COLCFG204 = [ // Name | Ch | Function | Rx Freq | Rx Tone | Tx Freq | Tx Tone | Mode | Notes
    [7, ''], [7, '0123456789'], [7, ''], [7, '0123456789.', 1], [7, '0123456789.()T'], [7, '0123456789.', 1], [7, '0123456789.()T'], [10, 'ADMN'], [6, '']];
  var KEYS204 = ['name', 'ch', 'func', 'rx', 'rxTone', 'tx', 'txTone', 'mode', 'notes'];

  // read every cell of a ruled grid, column by column; rows[] are pre-made objects that get filled
  function readCells(worker, work, G, bin, xs, ys, keys, cfg, rows, progress, p0, p1, label, confKey, spans) {
    spans = spans || ys.slice(0, -1).map(function (y, i) { return [y, ys[i + 1]]; });
    var nR = spans.length, total = nR * keys.length, done = 0, inset = Math.max(4, Math.round(G.h * 0.0022)), seq = Promise.resolve();
    keys.forEach(function (key, c) {
      if (!cfg[c]) return;
      seq = seq.then(function () {
        return worker.setParameters({ tessedit_pageseg_mode: String(cfg[c][0]), tessedit_char_whitelist: cfg[c][1] }).then(function () {
          var p = Promise.resolve();
          for (var rr = 0; rr < nR; rr++) (function (rr) {
            p = p.then(function () {
              var cv = prepCell(work, G, bin, Math.round(xs[c]) + inset, Math.round(spans[rr][0]) + inset, Math.round(xs[c + 1]) - inset, Math.round(spans[rr][1]) - inset);
              done++; progress(label + ' ' + Math.round(done / total * 100) + '%', p0 + (p1 - p0) * done / total);
              if (!cv) return null;
              if (cfg[c][2]) {
                return voteRead(worker, cv).then(function (v) { rows[rr][key] = v.text; rows[rr][key + 'Alts'] = v.alts; rows[rr][key + 'Dis'] = !v.agree; });
              }
              return worker.recognize(cv).then(function (res) {
                rows[rr][key] = (res.data.text || '').trim();
                if (confKey === key) { var cf = rows[rr]._cf = (rows[rr]._cf || []); cf.push(res.data.confidence); }
                if (!rows[rr][key] && cfg[c][3]) { // a lone narrow digit can come back empty: retry as a single word / character
                  var q = Promise.resolve();
                  cfg[c][3].forEach(function (psm) {
                    q = q.then(function () {
                      if (rows[rr][key]) return null;
                      return worker.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: cfg[c][1] }).then(function () { return worker.recognize(cv); }).then(function (r2) { rows[rr][key] = (r2.data.text || '').trim(); });
                    });
                  });
                  return q.then(function () { return worker.setParameters({ tessedit_pageseg_mode: String(cfg[c][0]), tessedit_char_whitelist: cfg[c][1] }); });
                }
              });
            });
          })(rr);
          return p;
        });
      });
    });
    return seq;
  }
  function blockText(worker, work, G, bin, x0, y0, x1, y1, psm) {
    var cv = prepCell(work, G, bin, Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1));
    if (!cv) return Promise.resolve('');
    return worker.setParameters({ tessedit_pageseg_mode: String(psm || 6), tessedit_char_whitelist: '' }).then(function () { return worker.recognize(cv); }).then(function (r) { return (r.data.text || '').trim(); });
  }

  // Straighten, then decide which form this is (205 or 204) and which way up it is.
  function analyze(work, deg) {
    var cv = rotateCanvas(work, deg), g0 = grayOf(cv), b0 = binarize(g0), ang = skewAngle(b0, g0.w, g0.h);
    if (Math.abs(ang) > 0.2) { cv = rotateSmall(cv, -ang * Math.PI / 180); g0 = grayOf(cv); b0 = binarize(g0); }
    var r = { cv: cv, G: g0, bin: b0, grid: null, f204: find204(b0, g0.w, g0.h), type: null };
    if (r.f204) r.type = '204';                       // checked first: the 204 also has ruled rows that can look like a 205
    else { r.grid = detectGrid(b0, g0.w, g0.h); if (r.grid && r.grid.cols.length === 11 && r.grid.rows.length >= 9) r.type = '205'; }
    return r;
  }

  function scanImage(file, progress) {
    var A, worker, work;
    progress('Loading photo…', 0.02);
    return loadToCanvas(file, 2600).then(function (cv) {
      work = cv;
      return getWorker(function (m) { progress(m, 0.05); });
    }).then(function (w) {
      worker = w;
      progress('Straightening and finding the tables…', 0.1);
      var degs = [0, 90, 270, 180];
      for (var i = 0; i < degs.length; i++) { var t = analyze(work, degs[i]); if (t.type) { A = t; break; } }
      if (!A) throw new Error('Could not find the tables. This reader handles the ICS-205 and ICS-204. Lay the page flat, fill the frame, keep it level and well lit, then try again.');
      progress('Checking page direction…', 0.2);
      function headerScore(a) { // read the table header row; right way up it names the columns
        var y0, y1;
        if (a.type === '205') { var g = a.grid; y0 = Math.max(0, Math.round(g.rows[0] - (g.rows[1] - g.rows[0]) * 1.05)); y1 = Math.round(g.rows[0]); }
        else { y0 = Math.round(a.f204.commYs[0]); y1 = Math.round(a.f204.commYs[1]); }
        var p = prepCell(a.cv, a.G, a.bin, 4, y0 + 2, a.cv.width - 4, y1 - 2); if (!p) return Promise.resolve(0);
        return ocr(worker, p, 7, '').then(function (r) { var m = r.text.match(/Function|Assigned|Notes|Mode|Name|Freq|Tone/gi); return m ? m.length : 0; });
      }
      return headerScore(A).then(function (s0) {
        if (s0 >= 2) return;
        var fl = rotateCanvas(A.cv, 180), g1 = grayOf(fl), b1 = binarize(g1), B = { cv: fl, G: g1, bin: b1, grid: null, f204: null, type: A.type };
        if (A.type === '205') { B.grid = detectGrid(b1, g1.w, g1.h); if (!B.grid || B.grid.cols.length !== 11) return; }
        else { B.f204 = find204(b1, g1.w, g1.h); if (!B.f204) return; }
        return headerScore(B).then(function (s1) { if (s1 > s0) A = B; });
      });
    }).then(function () {
      return A.type === '205' ? read205(worker, A, progress) : read204(worker, A, progress);
    });
  }

  function read205(worker, A, progress) {
    var work = A.cv, G = A.G, bin = A.bin, grid = A.grid;
    var rows = grid.rows, cols = grid.cols, nR = rows.length - 1, cells = [], r;
    var topY = Math.max(0, Math.round(rows[0] - (rows[1] - rows[0]) * 0.1)), botY = Math.round(rows[rows.length - 1]);
    var pre = prepCell(work, G, bin, 4, 4, G.w - 4, Math.max(40, topY - 2));
    var post = prepCell(work, G, bin, 4, botY + 3, G.w - 4, G.h - 4);
    for (r = 0; r < nR; r++) cells.push({ pos: r + 1, ch: '', func: '', name: '', assigned: '', rx: '', rxTone: '', tx: '', txTone: '', mode: '', notes: '', conf: null });
    return readCells(worker, work, G, bin, cols, rows, C.COLS, COLCFG, cells, progress, 0.25, 0.9, 'Reading the channel table…', 'name').then(function () {
      progress('Reading the page header…', 0.92);
      var head = '', foot = '';
      return worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' })
        .then(function () { return pre ? worker.recognize(pre) : null; }).then(function (r) { head = r ? r.data.text : ''; })
        .then(function () { return post ? worker.recognize(post) : null; }).then(function (r) { foot = r ? r.data.text : ''; })
        .then(function () {
          cells.forEach(function (c) { if (c._cf) { c.conf = Math.min.apply(null, c._cf); delete c._cf; } });
          return { type: '205', cells: cells, head: head, foot: foot };
        });
    });
  }

  function read204(worker, A, progress) {
    var work = A.cv, G = A.G, bin = A.bin, F = A.f204, out = { type: '204', texts: {}, res: [], cells: [] };
    var xL = F.xL, xR = F.xR, B = F.box;
    // 1) header boxes + operations personnel
    progress('Reading the header…', 0.22);
    var jobs = [];
    if (B && B.xs.length >= 2) {
      var bx = [xL].concat(B.xs.slice(0, 2), [xR]);
      jobs.push(['incident', bx[0] + 4, B.y0 + 4, bx[1] - 4, B.y1 - 4], ['op', bx[1] + 4, B.y0 + 4, bx[2] - 4, B.y1 - 4], ['branch', bx[2] + 4, B.y0 + 4, bx[3] - 4, B.y1 - 4]);
    }
    if (B) jobs.push(['ops', xL + 4, B.y1 + 3, xR - 4, F.resTop - 3]);
    var seq = Promise.resolve();
    jobs.forEach(function (j) { seq = seq.then(function () { return blockText(worker, work, G, bin, j[1], j[2], j[3], j[4], 6).then(function (t) { out.texts[j[0]] = t; }); }); });
    // 2) resources (data rows have no ruling: rows come from the text lines)
    seq = seq.then(function () {
      progress('Finding the resource lines…', 0.3);
      var rx = [xL].concat(F.res.xs, [xR]);
      var spans = null, bands = inkBands(bin, G.w, G.h, F.res.xs, F.res.y0 + 2, F.res.y1 - 2, xL, xR, F.Hs);
      if (bands.length) bands.shift(); // header row (Resource Identifier, ALS, Leader …)
      var hs = bands.map(function (b) { return b[1] - b[0]; }).sort(function (a, b) { return a - b; }), hm = hs[hs.length >> 1] || 0;
      var bandsOk = bands.length >= 3 && hs[hs.length - 1] <= 2 * hm;
      if (bandsOk) spans = bands.map(function (b) { return [b[0] - 4, b[1] + 4]; });
      else { // text lines ran together (blur): fall back to the printed row rules when they are evenly spaced
        var rl = F.Hs.filter(function (l) { return l.y > F.res.y0 - 4 && l.y < F.res.y1 + 4; }).map(function (l) { return l.y; });
        if (rl.length >= 7) {
          var df = rl.slice(1).map(function (y, i) { return y - rl[i]; }), srt = df.slice().sort(function (a, b) { return a - b; }), med = srt[srt.length >> 1];
          if (df.filter(function (d) { return Math.abs(d - med) <= 0.3 * med; }).length >= 0.8 * df.length) spans = df.map(function (d, i) { return d > 0.7 * med && d < 1.3 * med ? [rl[i], rl[i + 1]] : null; }).filter(Boolean).slice(1);
        }
        if (!spans) spans = bands.map(function (b) { return [b[0] - 4, b[1] + 4]; });
      }
      var n = rx.length - 1, hasSplit = n === 8;
      var keys = hasSplit ? ['id', 'als', 'x', 'leader', 'pers', 'req', 'hours', 'loc'] : ['id', 'als', 'x', 'leader', 'pers', 'req', 'hl'];
      var NAMEWL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ./-()'&,";
      var cfgBy = { id: [7, '', 1], leader: [7, ''], pers: [7, '0123456789', 0, [8, 10]], req: [7, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-', 1], hl: [7, ''], hours: [7, '0123456789-'], loc: [7, ''] };
      var cfg = keys.map(function (k) { return cfgBy[k] || null; });
      var rr = spans.map(function () { return {}; });
      spans.forEach(function (y, i) { // ALS mark: any ink in that cell
        var ink = 0, cw = 0, x0 = Math.round(rx[1]) + 5, x1 = Math.round(rx[2]) - 5, y0 = Math.round(y[0]) + 4, y1 = Math.round(y[1]) - 4;
        for (var yy = y0; yy < y1; yy++) for (var xx = x0; xx < x1; xx++) { ink += bin[yy * G.w + xx]; cw++; }
        rr[i].als = cw > 0 && ink / cw > 0.012;
      });
      return readCells(worker, work, G, bin, rx, null, keys, cfg, rr, progress, 0.3, 0.6, 'Reading the resources…', null, spans).then(function () { out.res = rr; });
    });
    // 3) work assignments / special instructions
    seq = seq.then(function () {
      progress('Reading the work assignments…', 0.62);
      var m = F.mid.slice().sort(function (a, b) { return a - b; });
      if (m.length < 2) { out.texts.work = ''; out.texts.special = ''; out.blocksMissed = true; return null; }
      var bounds = [F.res.y1, m[0], m[1]];
      return blockText(worker, work, G, bin, xL + 6, bounds[0] + 4, xR - 6, bounds[1] - 3, 6).then(function (t) { out.texts.work = t; })
        .then(function () { progress('Reading the special instructions…', 0.7); return blockText(worker, work, G, bin, xL + 6, bounds[1] + 4, xR - 6, bounds[2] - 3, 6); }).then(function (t) { out.texts.special = t; });
    });
    // 4) communications table
    seq = seq.then(function () {
      var ys = F.commYs.slice(1), xs = [xL].concat(F.comm.xs, [xR]);   // skip the header row
      var rows = ys.slice(0, -1).map(function (_, i) { return { pos: i + 1, ch: '', func: '', name: '', assigned: '', rx: '', rxTone: '', tx: '', txTone: '', mode: '', notes: '', conf: null }; });
      return readCells(worker, work, G, bin, xs, ys, KEYS204, COLCFG204, rows, progress, 0.72, 0.92, 'Reading the channels…', 'name').then(function () {
        rows.forEach(function (c) { if (c._cf) { c.conf = Math.min.apply(null, c._cf); delete c._cf; } });
        out.cells = rows;
      });
    });
    // 5) footer
    seq = seq.then(function () {
      progress('Reading the footer…', 0.94);
      return blockText(worker, work, G, bin, xL + 4, F.commYs[F.commYs.length - 1] + 3, xR - 4, F.footEnd - 2, 6).then(function (t) { out.texts.foot = t; });
    });
    return seq.then(function () { return out; });
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
    'differs-from-load': 'Differs from the statewide load', 'differs-205': 'Differs from the ICS-205 on this phone', 'low-confidence': 'Low reading confidence', 'mode-odd': 'Unusual mode'
  };
  var SEV = { 'freq-band': 2, 'freq-step': 2, 'freq-format': 2, 'freq-short': 2, 'freq-missing': 2, 'freq-disagree': 2, 'freq-disagree-known': 1, 'rx-tx-1digit': 2, 'tone-mismatch': 2, 'tone-unreadable': 2,
    'tone-fixed': 1, 'tone-missing': 1, 'differs-from-load': 1, 'differs-205': 1, 'low-confidence': 1, 'mode-odd': 1 };
  var host = null, state = { rows: [], meta: null, open: -1, busy: false, kind: '205', d: null }, known = null;

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
      var ended = opEnded(inc.meta), n205 = (inc.rows || []).length;
      b += '<div style="background:#161C1F;border:1px solid #2A3439;border-left:4px solid #FF8A3D;border-radius:12px;padding:12px 14px">' +
        '<div style="font:700 15px Helvetica,Arial,sans-serif;color:#ECEEF1">' + esc([inc.meta.incident, inc.meta.zone].filter(Boolean).join(' · ') || 'Incident') + '</div>' +
        '<div style="font:500 12px Helvetica,Arial,sans-serif;color:#7A828C;margin-top:3px">' + (n205 ? 'ICS-205: ' + n205 + ' channels · ' : 'No ICS-205 loaded yet · ') + esc(inc.meta.dateFrom || '') + ' ' + esc(inc.meta.timeFrom || '') + ' to ' + esc(inc.meta.dateTo || '') + ' ' + esc(inc.meta.timeTo || '') + '</div>' +
        (ended ? '<div style="margin-top:8px;font:700 12px Helvetica,Arial,sans-serif;color:#FFB23E">Operational period has ended — scan the new ICS-205 / 204 or remove this incident.</div>' : '') +
        (n205 ? '<div style="font-size:12px;color:#828B97;margin-top:8px">ICS-205 channels: <b>Channels</b> tab, “ZONE INC”.</div>' : '') + '</div>';
      (inc.divs || []).forEach(function (dv, i) {
        b += '<div data-div="' + i + '" style="cursor:pointer;background:#161C1F;border:1px solid #2A3439;border-left:4px solid #FFC53D;border-radius:12px;padding:12px 14px;margin-top:8px">' +
          '<div style="font:700 15px Helvetica,Arial,sans-serif;color:#ECEEF1">Division ' + esc(dv.meta.division) + (dv.meta.divName ? ' · ' + esc(dv.meta.divName) : '') + ' <span style="color:#7A828C;font-weight:400">›</span></div>' +
          '<div style="font:500 12px Helvetica,Arial,sans-serif;color:#7A828C;margin-top:3px">' + dv.res.length + ' resources · ' + C.totalPeople(dv.res) + ' personnel · ' + (dv.comms || []).length + ' channels</div></div>';
      });
      b += btn('inc-scan', 'Scan another ICS-205 / 204', 'go') + btn('inc-del', 'Remove this incident', 'warn');
    } else {
      b += '<div style="font-size:13px;line-height:1.6;color:#ECEEF1">Take a photo of the <b>ICS-205</b> (radio communications plan) or your division’s <b>ICS-204</b> (assignment list) from the IAP, or choose one from your photos. ' +
        'The app tells which form it is. The 205 loads as an <b>INC</b> zone; the 204 gives you a division screen (resources, overhead, work assignments, instructions) and a <b>DIV</b> channel zone — all usable offline.</div>';
      b += btn('inc-scan', 'Take or choose a photo', 'go');
    }
    b += '<div id="inc-off" style="margin-top:14px"></div>';
    b += note('Tips: lay the page flat, fill the frame, keep it level, good light, no glare. Everything is read on this phone — nothing is uploaded. ' +
      'IAP forms are marked <b>Controlled Unclassified Information</b>; make sure storing them on a personal phone is allowed for your unit. Always check the radio against the form.', '#828B97');
    var body = shell('Incident · ICS-205 / 204', b, null);
    var sc = body.querySelector('#inc-scan'); if (sc) sc.onclick = pick;
    var dl = body.querySelector('#inc-del'); if (dl) dl.onclick = function () { if (confirm('Remove this incident, its divisions and all their channels from this phone?')) removeIncident(); };
    body.querySelectorAll('[data-div]').forEach(function (e) { e.onclick = function () { divView(+e.getAttribute('data-div')); }; });
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
      state.kind = res.type; state.d = null;
      if (res.type === '204') {
        var T = res.texts, h = C.parseHeader(T.op || ''), bd = C.parseBranchDiv(T.branch || '');
        var head = function (t, re) { var l = String(t || '').split(/\r?\n/); if (l.length && re.test(l[0])) l.shift(); return l.join('\n').replace(/\n{2,}/g, '\n').trim(); };
        var ops = C.parseOps(T.ops || ''); if (!ops.length && C.cleanText(T.ops || '')) ops = [{ label: 'Operations personnel', value: C.cleanText(T.ops) }];
        state.rows.forEach(annot);
        state.d = {
          meta: { incident: C.parseIncidentName(T.incident || ''), branch: bd.branch, division: bd.division, divName: bd.divName, dateFrom: h.dateFrom, timeFrom: h.timeFrom, dateTo: h.dateTo, timeTo: h.timeTo },
          ops: ops, work: head(T.work, /work\s*assign/i), special: head(T.special, /special\s*instr/i), foot: C.parseFoot204(T.foot || ''),
          res: res.res.map(function (r) { return C.buildResource({ id: r.id, als: r.als, leader: r.leader, pers: r.pers, req: r.req, hl: r.hl, hours: r.hours, loc: r.loc, idAlts: r.idAlts, leaderAlts: r.leaderAlts, reqAlts: r.reqAlts }); })
            .filter(function (r) { return r.id.replace(/[^A-Za-z]/g, '').length >= 3 || r.leader.replace(/[^A-Za-z]/g, '').length >= 3; }), openRes: -1, blocksMissed: !!res.blocksMissed
        };
      } else {
        var h2 = C.parseHeader(res.head), f = C.parseFooter(res.foot);
        state.meta = { incident: h2.incident, zone: h2.zone, dateFrom: h2.dateFrom, timeFrom: h2.timeFrom, dateTo: h2.dateTo, timeTo: h2.timeTo, prepared: f.prepared, special: f.special };
      }
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
        '<div style="display:flex;gap:8px;margin-top:8px">' + (state.kind === '204' ? '' : fld('ASSIGNED TO', 'assigned', r, i, 2)) + fld('MODE', 'mode', r, i, 0.5) + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:8px">' + fld('RX FREQ', 'rx', r, i, 1.3, 1) + fld('RX TONE', 'rxTone', r, i, 1, 1) + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:8px">' + fld('TX FREQ', 'tx', r, i, 1.3, 1) + fld('TX TONE', 'txTone', r, i, 1, 1) + '</div>' +
        '<div style="margin-top:8px">' + fld('NOTES', 'notes', r, i, 1) + '</div>';
      (r.flags || []).forEach(function (f) { det += '<div style="font-size:12px;color:' + ((SEV[f] || 1) === 2 ? '#FF9A9A' : '#FFD07A') + ';margin-top:7px">⚠ ' + esc(FLAGTXT[f] || f) + (f === 'differs-from-load' && r.loadHint ? ' (load: ' + esc(r.loadHint) + ')' : '') + (f === 'differs-205' && r.hint205 ? ' (205: ' + esc(r.hint205) + ')' : '') + '</div>'; });
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
  function annot(r) { // 204 channel vs the ICS-205 already saved: show any difference, never merge
    if (state.kind !== '204') return;
    var inc = loadInc(), h = inc && inc.rows && C.cross205(r, inc.rows);
    if (h) { if (r.flags.indexOf('differs-205') < 0) r.flags.push('differs-205'); (r.fieldFlags.name = r.fieldFlags.name || []).push('differs-205'); r.hint205 = h; }
  }
  function revalidate(i, changed) {
    var r = state.rows[i];
    var raw = { pos: r.pos, ch: r.ch, func: r.func, name: r.name, assigned: r.assigned, rx: r.rx, rxTone: r.rxTone, tx: r.tx, txTone: r.txTone, mode: r.mode, notes: r.notes };
    // keep the doubt about a frequency the person has not touched
    ['rx', 'tx'].forEach(function (k) { if (changed !== k && r[k + 'Dis']) { raw[k + 'Dis'] = true; raw[k + 'Alts'] = r[k + 'Alts'] || []; } });
    var nr = C.buildRows([raw], known)[0]; nr.ok = false; annot(nr); state.rows[i] = nr;
  }
  function review() {
    if (state.kind === '204') return review204();
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
    if (state.kind === '204') return save204();
    var inc = loadInc(), wipe = false;
    if (inc && inc.meta && inc.meta.incident && state.meta.incident && !C.sameIncident(inc.meta.incident, state.meta.incident)) { if (mismatch(inc, state.meta.incident)) return; wipe = true; inc = null; }
    try {
      var zone = C.buildZone(state.meta, state.rows);
      var ov = loadOv(); ov.ADDZ = ov.ADDZ || {};
      var list = (ov.ADDZ.HOME || []).filter(function (z) { return wipe ? !z.incident : !(z.incident && z.incKind !== 'ics204'); });
      list.unshift(zone); ov.ADDZ.HOME = sortZones(list);
      localStorage.setItem(OVKEY, JSON.stringify(ov));
      localStorage.setItem(INCKEY, JSON.stringify({ meta: state.meta, rows: state.rows.map(slimRow), savedAt: Date.now(), divs: (inc && inc.divs) || [] }));
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

  // =====================================================================
  // ICS-204 (division assignment list): review, save, division screen
  // =====================================================================
  var RFLAG = { 'id-disagree': 'Readings of this name disagreed — check it against the form', 'leader-disagree': 'Readings of the leader disagreed — check it', 'request-disagree': 'Readings of the request number disagreed',
    'personnel': 'Personnel count not read', 'request': 'Request number not in the usual form (E-123)', 'request-fixed': 'Request number tidied (letter / hyphen) — check it', 'hours': 'Hours not in the 0700-0700 form' };
  var INPSTY = 'width:100%;box-sizing:border-box;min-height:42px;margin-top:2px;background:#0b0f11;color:#ECEEF1;border:1px solid #2a3439;border-radius:8px;padding:6px 8px;font:500 14px Helvetica,Arial,sans-serif';
  function pin(label, path, val, w, mono) {
    return '<label style="display:block;flex:' + (w || 1) + ';min-width:0"><span style="font:600 10px Helvetica,Arial,sans-serif;letter-spacing:.06em;color:#7A828C">' + label + '</span>' +
      '<input data-p="' + path + '" value="' + esc(val) + '" autocomplete="off" style="' + INPSTY + (mono ? ";font-family:'Spline Sans Mono',monospace" : '') + '"></label>';
  }
  function pta(label, path, val, rows) {
    return '<label style="display:block"><span style="font:600 10px Helvetica,Arial,sans-serif;letter-spacing:.06em;color:#7A828C">' + label + '</span>' +
      '<textarea data-p="' + path + '" rows="' + (rows || 4) + '" style="' + INPSTY + ';line-height:1.45;resize:vertical">' + esc(val) + '</textarea></label>';
  }
  function sec(t, extra) { return '<div style="display:flex;align-items:baseline;gap:8px;margin:18px 0 8px"><div style="font:700 12px Helvetica,Arial,sans-serif;letter-spacing:.08em;color:#FF8A3D">' + t + '</div>' + (extra ? '<div style="font-size:12px;color:#7A828C">' + extra + '</div>' : '') + '</div>'; }
  function rcard(r, i) {
    var d = state.d, open = d.openRes === i, bad = !r.ok && r.flags.length;
    var color = r.ok ? '#2E7D46' : bad ? '#FFB23E' : '#2E7D46';
    var sum = '<div data-ropen="' + i + '" style="cursor:pointer"><div style="font:700 14px Helvetica,Arial,sans-serif;color:#ECEEF1">' + esc(r.id || '—') + (r.als ? ' <span style="font:700 10px Helvetica,Arial,sans-serif;background:#6b2a2d;color:#ffb3b3;border-radius:4px;padding:1px 5px;vertical-align:middle">ALS</span>' : '') + '</div>' +
      '<div style="font:500 12px Helvetica,Arial,sans-serif;color:#B8C0C8;margin-top:2px">' + esc(r.leader || '—') + ' · ' + esc(r.personnel || '?') + ' pers · ' + esc(r.request || '—') + ' · ' + esc(r.hours || '—') + ' · ' + esc(r.loc || '—') + '</div></div>';
    var det = '';
    if (open) {
      det = '<div style="margin-top:10px"><div style="display:flex;gap:8px">' + pin('RESOURCE', 'res.' + i + '.id', r.id, 2) + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:8px">' + pin('LEADER', 'res.' + i + '.leader', r.leader, 2) + pin('PERS', 'res.' + i + '.personnel', r.personnel, 0.7, 1) + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:8px">' + pin('REQUEST #', 'res.' + i + '.request', r.request, 1, 1) + pin('HOURS', 'res.' + i + '.hours', r.hours, 1.2, 1) + pin('LOCATION', 'res.' + i + '.loc', r.loc, 1) + '</div>' +
        '<button data-als="' + i + '" style="margin-top:8px;min-height:38px;background:#1b2328;color:#ECEEF1;border:1px solid #2a3439;border-radius:10px;padding:0 14px;font:600 13px Helvetica,Arial,sans-serif">ALS: ' + (r.als ? 'Yes' : 'No') + ' (tap to change)</button>';
      r.flags.forEach(function (f) { det += '<div style="font-size:12px;color:#FFD07A;margin-top:7px">⚠ ' + esc(RFLAG[f] || f) + '</div>'; });
      [['id', 'id'], ['leader', 'leader'], ['request', 'request']].forEach(function (k) {
        ((r.alts && r.alts[k[0]]) || []).forEach(function (v) {
          det += '<button data-rsg="' + i + '|' + k[1] + '|' + esc(v) + '" style="margin:8px 8px 0 0;min-height:38px;background:#1b2328;color:#ECEEF1;border:1px solid #4C8DFF;border-radius:19px;padding:0 14px;font:600 13px Helvetica,Arial,sans-serif">Use “' + esc(v) + '”</button>';
        });
      });
      det += '<div style="display:flex;gap:8px;margin-top:12px"><button data-rok="' + i + '" style="flex:1;min-height:44px;background:#2f7d4f;color:#fff;border:0;border-radius:10px;font:700 14px Helvetica,Arial,sans-serif">' + (r.ok ? '✓ Checked against the form' : 'Mark checked') + '</button>' +
        '<button data-rdel="' + i + '" style="min-height:44px;padding:0 16px;background:#3a1b1d;color:#ff9a9a;border:0;border-radius:10px;font:700 14px Helvetica,Arial,sans-serif">Delete</button></div></div>';
    }
    return '<div style="background:#161C1F;border:1px solid #2A3439;border-left:4px solid ' + color + ';border-radius:12px;padding:10px 12px;margin-bottom:7px">' + sum + det + '</div>';
  }
  function review204() {
    var d = state.d, m = d.meta, sum = C.totalPeople(d.res), printed = parseInt(d.foot.count, 10) || 0;
    var flaggedR = d.res.filter(function (r) { return !r.ok && r.flags.length; }).length;
    var flaggedC = state.rows.filter(function (r) { return !r.ok && worst(r) > 0; }).length;
    var b = '<div style="font-size:13px;line-height:1.55;color:#ECEEF1">Division sheet read in ' + state.secs + ' s: ' + d.res.length + ' resources, ' + state.rows.length + ' channels. <b style="color:' + (flaggedR + flaggedC ? '#FFB23E' : '#5BD06A') + '">' + (flaggedR + flaggedC ? (flaggedR + flaggedC) + ' to check' : 'None flagged') + '</b> — compare with the form, fix anything wrong, then save.</div>';
    if (printed) b += '<div style="margin-top:8px;font-size:12px;line-height:1.5;color:' + (sum === printed ? '#5BD06A' : '#FF9A9A') + '">' + (sum === printed ? '✓ Personnel adds up to the printed count (' + printed + ').' : '⚠ Personnel adds up to ' + sum + ' but the form says ' + printed + ' — a number or a line was misread.') + '</div>';
    if (d.blocksMissed) b += '<div style="margin-top:8px;font-size:12px;color:#FFD07A">Work assignments / special instructions could not be located — type them in below or read them from the paper copy.</div>';
    b += sec('DIVISION') + '<div style="display:flex;gap:8px">' + pin('INCIDENT', 'meta.incident', m.incident, 2) + pin('DIV', 'meta.division', m.division, 0.6) + pin('NAME', 'meta.divName', m.divName, 1.2) + pin('BRANCH', 'meta.branch', m.branch, 0.6) + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:8px">' + pin('FROM', 'meta.dateFrom', m.dateFrom) + pin('TIME', 'meta.timeFrom', m.timeFrom, 0.6) + pin('TO', 'meta.dateTo', m.dateTo) + pin('TIME', 'meta.timeTo', m.timeTo, 0.6) + '</div>';
    b += sec('OPERATIONS PERSONNEL');
    if (!d.ops.length) b += note('None read.');
    d.ops.forEach(function (o, i) { b += '<div style="margin-bottom:8px">' + pin(o.label.toUpperCase(), 'ops.' + i + '.value', o.value) + '</div>'; });
    b += sec('RESOURCES', d.res.length + ' · ' + sum + ' personnel') + d.res.map(rcard).join('');
    b += sec('WORK ASSIGNMENTS') + pta('', 'work', d.work, 5) + sec('SPECIAL INSTRUCTIONS') + pta('', 'special', d.special, 6);
    b += sec('COMMUNICATIONS', state.rows.length + ' channels') + (state.rows.length ? state.rows.map(card).join('') : note('None read.'));
    b += sec('PREPARED BY') + '<div style="display:flex;gap:8px">' + pin('NAME', 'foot.prepared', d.foot.prepared, 1.4) + pin('POSITION', 'foot.position', d.foot.position, 0.8) + pin('COUNT', 'foot.count', d.foot.count, 0.7, 1) + '</div>';
    b += btn('inc-save', 'Save this division', 'go') + btn('inc-redo', 'Scan a different photo', '') +
      note('Frequencies are never changed automatically. Amber/red items are things the app could not confirm — check them against the printed form. Channels from this sheet are saved as a “DIV” zone; where one differs from the ICS-205 you will see it flagged, not merged.');
    var body = shell('Check the division sheet', b, null);
    wire(body); wire204(body);
  }
  function setPath(o, path, v) {
    var p = path.split('.'), k = p.pop(), t = o; p.forEach(function (x) { t = t[x]; });
    t[k] = v;
  }
  function reRes(i, field) {
    var d = state.d, r = d.res[i];
    var nr = C.buildResource({ id: r.id, als: r.als, leader: r.leader, pers: r.personnel, req: r.request, hours: r.hours, loc: r.loc });
    [['id', 'id-disagree'], ['leader', 'leader-disagree'], ['request', 'request-disagree']].forEach(function (k) {
      if (field !== k[0] && r.alts && r.alts[k[0]] && r.alts[k[0]].length) { nr.alts[k[0]] = r.alts[k[0]]; nr.flags.push(k[1]); }
    });
    nr.ok = false; d.res[i] = nr;
  }
  function keep(fn) { var el = document.getElementById('cg-inc-body'), y = el ? el.scrollTop : 0; fn(); review(); el = document.getElementById('cg-inc-body'); if (el) el.scrollTop = y; }
  function wire204(body) {
    var d = state.d;
    body.querySelectorAll('[data-p]').forEach(function (e) {
      e.onchange = function () {
        var path = e.getAttribute('data-p'); setPath(d, path, e.value.trim());
        var m = path.match(/^res\.(\d+)\.(\w+)$/);
        if (m) keep(function () { reRes(+m[1], m[2]); });
      };
    });
    body.querySelectorAll('[data-ropen]').forEach(function (e) { e.onclick = function () { var i = +e.getAttribute('data-ropen'); keep(function () { d.openRes = d.openRes === i ? -1 : i; }); }; });
    body.querySelectorAll('[data-als]').forEach(function (e) { e.onclick = function () { var i = +e.getAttribute('data-als'); keep(function () { d.res[i].als = !d.res[i].als; }); }; });
    body.querySelectorAll('[data-rok]').forEach(function (e) { e.onclick = function () { var i = +e.getAttribute('data-rok'); keep(function () { d.res[i].ok = !d.res[i].ok; }); }; });
    body.querySelectorAll('[data-rdel]').forEach(function (e) { e.onclick = function () { keep(function () { d.res.splice(+e.getAttribute('data-rdel'), 1); d.openRes = -1; }); }; });
    body.querySelectorAll('[data-rsg]').forEach(function (e) {
      e.onclick = function () {
        var p = e.getAttribute('data-rsg').split('|'), i = +p[0], f = p[1], v = p.slice(2).join('|');
        keep(function () { d.res[i][f] = v; reRes(i, f); });
      };
    });
  }

  function sortZones(list) {
    var rank = function (z) { return z.incKind === 'ics204' ? 0 : z.incident ? 1 : 2; };
    return list.map(function (z, i) { return [z, i]; }).sort(function (a, b) { return rank(a[0]) - rank(b[0]) || a[1] - b[1]; }).map(function (p) { return p[0]; });
  }
  function slimRow(r) { return { ch: r.ch, name: r.name, func: r.func, assigned: r.assigned, rx: r.rx, rxTone: r.rxTone, tx: r.tx, txTone: r.txTone, mode: r.mode, notes: r.notes }; }
  function mismatch(inc, name) { // saved incident vs the one on the sheet in hand
    if (!inc || !inc.meta || !inc.meta.incident || !name || C.sameIncident(inc.meta.incident, name)) return false;
    return !confirm('This phone has “' + inc.meta.incident + '”, but this sheet says “' + name + '”.\n\nReplace everything saved for “' + inc.meta.incident + '”?');
  }
  function save204() {
    var d = state.d, m = d.meta;
    if (!m.division) { alert('Enter the division letter (DIV) first.'); return; }
    var inc = loadInc(), wipe = false;
    if (inc && inc.meta && inc.meta.incident && m.incident && !C.sameIncident(inc.meta.incident, m.incident)) { if (mismatch(inc, m.incident)) return; wipe = true; inc = null; }
    var key = m.division.toUpperCase();
    try {
      var zone = C.buildZone(m, state.rows, { kind: 'ics204', divKey: key });
      var ov = loadOv(); ov.ADDZ = ov.ADDZ || {};
      var list = (ov.ADDZ.HOME || []).filter(function (z) { return wipe ? !z.incident : !(z.incKind === 'ics204' && z.divKey === key); });
      list.unshift(zone); ov.ADDZ.HOME = sortZones(list);
      localStorage.setItem(OVKEY, JSON.stringify(ov));
      var div = { key: key, meta: { division: m.division, divName: m.divName, branch: m.branch, dateFrom: m.dateFrom, timeFrom: m.timeFrom, dateTo: m.dateTo, timeTo: m.timeTo },
        ops: d.ops, work: d.work, special: d.special, foot: d.foot, savedAt: Date.now(),
        res: d.res.map(function (r) { return { id: r.id, als: r.als, leader: r.leader, personnel: r.personnel, request: r.request, hours: r.hours, loc: r.loc, chk: !!r.ok }; }),
        comms: state.rows.map(function (r) { var o = slimRow(r); o.warn = !r.ok && worst(r) > 0; if (r.hint205) o.diff205 = r.hint205; return o; }) };
      inc = inc || { meta: { incident: m.incident, zone: '', dateFrom: m.dateFrom, timeFrom: m.timeFrom, dateTo: m.dateTo, timeTo: m.timeTo }, rows: [], savedAt: Date.now() };
      if (!inc.meta.incident) inc.meta.incident = m.incident;
      inc.divs = (inc.divs || []).filter(function (x) { return x.key !== key; }).concat([div]).sort(function (a, b) { return a.key < b.key ? -1 : 1; });
      localStorage.setItem(INCKEY, JSON.stringify(inc));
    } catch (e) { alert('Could not save (storage blocked).'); return; }
    shell('Saved', '<div style="font-size:14px;line-height:1.6;color:#ECEEF1">Saved Division ' + esc(m.division) + (m.divName ? ' · ' + esc(m.divName) : '') + ': ' + d.res.length + ' resources and ' + state.rows.filter(function (r) { return r.rx || r.tx; }).length + ' channels. Its channels are under <b>Channels</b> as “ZONE DIV”.</div>' +
      btn('inc-view', 'Open the division screen', 'go') + btn('inc-ok', 'Open Channels', ''), null);
    document.getElementById('inc-view').onclick = function () { var i = (loadInc().divs || []).map(function (x) { return x.key; }).indexOf(key); divView(i); };
    document.getElementById('inc-ok').onclick = function () { try { sessionStorage.setItem('cg_open_tab', 'channels'); } catch (e) {} location.reload(); };
  }

  function divView(i) {
    var inc = loadInc(), dv = inc && inc.divs && inc.divs[i]; if (!dv) return home();
    var m = dv.meta, line = function (a, b) { return '<div style="display:flex;gap:10px;padding:5px 0;border-bottom:1px solid #1c2226"><div style="flex:0 0 38%;font:600 12px Helvetica,Arial,sans-serif;color:#7A828C">' + esc(a) + '</div><div style="flex:1;font:500 13px Helvetica,Arial,sans-serif;color:#ECEEF1">' + esc(b) + '</div></div>'; };
    var b = '<div style="font:700 17px Helvetica,Arial,sans-serif;color:#ECEEF1">Division ' + esc(m.division) + (m.divName ? ' · ' + esc(m.divName) : '') + '</div>' +
      '<div style="font:500 12px Helvetica,Arial,sans-serif;color:#7A828C;margin-top:3px">' + esc(inc.meta.incident || '') + (m.branch ? ' · Branch ' + esc(m.branch) : '') + '<br>' + esc(m.dateFrom || '') + ' ' + esc(m.timeFrom || '') + ' to ' + esc(m.dateTo || '') + ' ' + esc(m.timeTo || '') + (opEnded(m) ? ' <b style="color:#FFB23E">· period has ended</b>' : '') + '</div>';
    if (dv.ops && dv.ops.length) { b += sec('OVERHEAD · OPERATIONS PERSONNEL'); dv.ops.forEach(function (o) { b += line(o.label, o.value); }); }
    var groups = C.groupRes(dv.res), tot = C.totalPeople(dv.res);
    b += sec('RESOURCES', dv.res.length + ' · ' + tot + ' personnel' + (dv.foot && dv.foot.count ? ' (form: ' + esc(dv.foot.count) + ')' : ''));
    groups.forEach(function (g) {
      b += '<div style="font:700 11px Helvetica,Arial,sans-serif;letter-spacing:.06em;color:#9AA3AE;margin:10px 0 4px">' + esc(g.title.toUpperCase()) + ' · ' + g.items.length + ' · ' + g.people + ' pers</div>';
      g.items.forEach(function (r) {
        b += '<div style="padding:7px 0;border-bottom:1px solid #1c2226"><div style="font:700 14px Helvetica,Arial,sans-serif;color:#ECEEF1">' + esc(r.id) + (r.als ? ' <span style="font:700 10px Helvetica,Arial,sans-serif;background:#6b2a2d;color:#ffb3b3;border-radius:4px;padding:1px 5px">ALS</span>' : '') + '</div>' +
          '<div style="font:500 12px Helvetica,Arial,sans-serif;color:#B8C0C8;margin-top:1px">' + esc(r.leader) + ' · ' + esc(r.personnel) + ' pers · ' + esc(r.request) + '<br>' + esc(r.hours) + ' · ' + esc(r.loc) + '</div></div>';
      });
    });
    if (dv.work) b += sec('WORK ASSIGNMENTS') + '<div style="font:500 14px/1.5 Helvetica,Arial,sans-serif;color:#ECEEF1;white-space:pre-wrap">' + esc(dv.work) + '</div>';
    if (dv.special) b += sec('SPECIAL INSTRUCTIONS') + '<div style="font:500 14px/1.5 Helvetica,Arial,sans-serif;color:#ECEEF1;white-space:pre-wrap">' + esc(dv.special) + '</div>';
    b += sec('COMMUNICATIONS', (dv.comms || []).length + ' channels');
    (dv.comms || []).forEach(function (r) {
      var t = function (x) { return x && x !== 'None' ? ' ' + x : ''; };
      b += '<div style="padding:7px 0;border-bottom:1px solid #1c2226"><div style="font:700 14px Helvetica,Arial,sans-serif;color:#ECEEF1"><span style="font-family:\'Spline Sans Mono\',monospace;color:#7A828C">' + esc(r.ch) + '</span> ' + esc(r.name) + ' <span style="font-weight:400;color:#7A828C">· ' + esc(r.func) + '</span>' + (r.warn ? ' <span style="color:#FFB23E" title="Not checked against the form">⚠</span>' : '') + '</div>' +
        '<div style="font:500 12px \'Spline Sans Mono\',monospace;color:#B8C0C8;margin-top:2px">RX ' + esc(r.rx) + esc(t(r.rxTone)) + ' · TX ' + esc(r.tx) + esc(t(r.txTone)) + '</div>' +
        (r.notes ? '<div style="font-size:12px;color:#828B97;margin-top:1px">' + esc(r.notes) + '</div>' : '') +
        (r.diff205 ? '<div style="font-size:12px;color:#FFD07A;margin-top:2px">≠ ICS-205 has ' + esc(r.diff205) + ' — confirm which is right</div>' : '') + '</div>';
    });
    if (dv.foot && (dv.foot.prepared || dv.foot.date)) b += note('Prepared by ' + esc([dv.foot.prepared, dv.foot.position].filter(Boolean).join(' ')) + (dv.foot.date ? ' · ' + esc(dv.foot.date) + ' ' + esc(dv.foot.time || '') : ''));
    b += btn('dv-ch', 'Show channels in Channels tab', 'go') + btn('dv-scan', 'Rescan this division', '') + btn('dv-del', 'Remove this division', 'warn') + btn('dv-back', 'Back', '');
    var body = shell('Division ' + m.division, b, home);
    body.querySelector('#dv-ch').onclick = function () { try { sessionStorage.setItem('cg_open_tab', 'channels'); } catch (e) {} location.reload(); };
    body.querySelector('#dv-scan').onclick = pick;
    body.querySelector('#dv-back').onclick = home;
    body.querySelector('#dv-del').onclick = function () { if (confirm('Remove Division ' + m.division + ' from this phone?')) removeDiv(dv.key); };
  }
  function removeDiv(key) {
    try {
      var ov = loadOv();
      if (ov.ADDZ && ov.ADDZ.HOME) { ov.ADDZ.HOME = ov.ADDZ.HOME.filter(function (z) { return !(z.incKind === 'ics204' && z.divKey === key); }); if (!ov.ADDZ.HOME.length) delete ov.ADDZ.HOME; if (!Object.keys(ov.ADDZ).length) delete ov.ADDZ; }
      if (Object.keys(ov).length) localStorage.setItem(OVKEY, JSON.stringify(ov)); else localStorage.removeItem(OVKEY);
      var inc = loadInc(); inc.divs = (inc.divs || []).filter(function (x) { return x.key !== key; });
      if (!inc.divs.length && !(inc.rows && inc.rows.length)) localStorage.removeItem(INCKEY); else localStorage.setItem(INCKEY, JSON.stringify(inc));
    } catch (e) {}
    location.reload();
  }

  // test hook (headless tests call the pipeline directly)
  window.__cgIncident = { open: home, scanImage: scanImage, analyze: analyze, vsegs: vsegs, hsegs: hsegs, find204: find204, binarize: binarize, grayOf: grayOf, loadToCanvas: loadToCanvas, detectGrid: detectGrid, state: state, setKnown: function (k) { known = k; } };
  window.__cgOpenIncident = home;
})();
