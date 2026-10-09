/* Comm Guide — ICS-205 core logic (pure functions, no DOM).
   Turns noisy OCR cell text into validated radio channel rows.
   Nothing here invents data: values are either what the form says, or an obvious repair
   (flagged) backed by the tone table, the radio bands, or a channel already in the app.
   Loaded in the browser as window.CGInc and in node (tests) via require(). */
(function (root) {
  'use strict';

  // Standard CTCSS tones (Hz). A tone read from a form must be one of these.
  var CTCSS = ['67.0','69.3','71.9','74.4','77.0','79.7','82.5','85.4','88.5','91.5','94.8','97.4','100.0','103.5',
    '107.2','110.9','114.8','118.8','123.0','127.3','131.8','136.5','141.3','146.2','151.4','156.7','159.8','162.2',
    '165.5','167.9','171.3','173.8','177.3','179.9','183.5','186.2','189.9','192.8','196.6','199.5','203.5','206.5',
    '210.7','218.1','225.7','229.1','233.6','241.8','250.3','254.1'];
  // CAL FIRE tone numbers confirmed by the app's own tone table; more are learned from the sheet itself.
  var BASE_TNUM = { 1:'110.9', 2:'123.0', 3:'131.8', 4:'136.5', 5:'146.2', 6:'156.7', 7:'167.9', 8:'103.5',
    9:'100.0', 10:'107.2', 11:'114.8', 12:'127.3', 13:'141.3', 14:'151.4', 15:'162.2', 16:'192.8' };

  var COLS = ['ch','func','name','assigned','rx','rxTone','tx','txTone','mode','notes'];

  function digitsFix(s) { // common OCR look-alikes inside numeric text
    return String(s || '').replace(/[Oo]/g,'0').replace(/[lI|!]/g,'1').replace(/[Ss]/g,'5').replace(/B/g,'8');
  }

  // ---------- frequency ----------
  function parseFreq(raw) {
    var s = String(raw || '').trim();
    var out = { value: '', flags: [] };
    if (!s) return out;
    var d = s.replace(/[^0-9]/g, '');
    if (d.length === 7) out.value = d.slice(0,3) + '.' + d.slice(3);
    else if (d.length === 6) { out.value = d.slice(0,3) + '.' + d.slice(3) + '0'; out.flags.push('freq-short'); }
    else if (d.length === 8 && /^\d{3}\.\d{4}$/.test(s.replace(/\s/g,''))) out.value = s.replace(/\s/g,'');
    else { out.value = s; out.flags.push('freq-format'); return out; }
    return out;
  }
  function freqProblems(v) { // returns list of flags for a well-formed freq string
    var f = [], n = parseFloat(v);
    if (!/^\d{3}\.\d{4}$/.test(v)) return ['freq-format'];
    var inBand = (n >= 136 && n <= 174) || (n >= 406 && n <= 512) || (n >= 30 && n <= 50) || (n >= 806 && n <= 870);
    if (!inBand) f.push('freq-band');
    // radio channel spacing: 2.5 kHz steps
    var steps = Math.round(n / 0.0025);
    if (Math.abs(steps * 0.0025 - n) > 0.00006) f.push('freq-step');
    return f;
  }

  // ---------- tones ----------
  function hzFromDigits(txt) {
    var m = String(txt).match(/(\d{2,3})\.(\d)/);
    if (m) return m[1] + '.' + m[2];
    var d = String(txt).replace(/[^0-9]/g, '');
    if (d.length === 4) return d.slice(0,3) + '.' + d.slice(3);
    if (d.length === 3) return d.slice(0,2) + '.' + d.slice(2);
    return null;
  }
  function parseToneRaw(raw) {
    var s = String(raw || '').trim();
    if (!s) return { empty: true, num: null, hz: null, none: false, raw: s };
    var t = s.replace(/\s+/g, ' ');
    if (/^[0O][.,]?[0O]?$/.test(t)) return { empty: false, num: null, hz: null, none: true, raw: s };
    var num = null, rest = t;
    var m = t.match(/[\(\[{]?\s*[Tt7]?\s*(\d{1,2})\s*[\)\]}]/); // "(T14)" or "(r14)" style
    var mt = t.match(/[\(\[{]\s*[A-Za-z]?\s*(\d{1,2})\s*[\)\]}]/);
    if (mt) { num = parseInt(mt[1], 10); rest = t.replace(mt[0], ' '); }
    else if (m && /[Tt]/.test(t)) { num = parseInt(m[1], 10); rest = t.replace(m[0], ' '); }
    var hz = hzFromDigits(digitsFix(rest));
    return { empty: false, num: num, hz: hz, none: false, raw: s };
  }
  // Learn T-number <-> Hz pairs that this sheet uses consistently (majority vote).
  function learnToneMap(parsedTones, extra) {
    var votes = {}, map = {}, k;
    for (k in BASE_TNUM) map[k] = BASE_TNUM[k];
    if (extra) for (k in extra) map[k] = extra[k];
    parsedTones.forEach(function (p) {
      if (p && p.num != null && p.hz && CTCSS.indexOf(p.hz) >= 0) {
        votes[p.num] = votes[p.num] || {};
        votes[p.num][p.hz] = (votes[p.num][p.hz] || 0) + 1;
      }
    });
    for (k in votes) {
      if (map[k]) continue; // never override the app's known table
      var best = null, bc = 0, hz;
      for (hz in votes[k]) if (votes[k][hz] > bc) { best = hz; bc = votes[k][hz]; }
      if (best) map[k] = best;
    }
    return map;
  }
  function resolveTone(p, map) {
    var out = { num: p.num, hz: p.hz, none: p.none, flags: [] };
    if (p.empty) return out;
    if (p.none) return out;
    var hzOk = p.hz && CTCSS.indexOf(p.hz) >= 0;
    var mapHz = (p.num != null) ? map[p.num] : null;
    if (hzOk && mapHz && mapHz !== p.hz) { out.flags.push('tone-mismatch'); }
    else if (hzOk && p.num == null) { /* Hz only: fine */ }
    else if (!hzOk && mapHz) { out.hz = mapHz; out.flags.push('tone-fixed'); }
    else if (!hzOk && !mapHz) { out.flags.push('tone-unreadable'); }
    return out;
  }

  // ---------- known channels (statewide load already in the app) ----------
  function normName(n) { return String(n || '').toUpperCase().replace(/[\s\-_.]/g, ''); }
  function buildKnown(RADIO) {
    var byName = {}, freqs = {};
    ((RADIO && RADIO.UNITS) || []).forEach(function (u) {
      (u.channels || []).forEach(function (c) {
        if (!c || !c.name) return;
        var k = normName(c.name);
        (byName[k] = byName[k] || []).push({ rx: c.rx, tx: c.tx, rxT: c.rxT || '' });
        if (c.rx) freqs[c.rx] = 1;
        if (c.tx) freqs[c.tx] = 1;
      });
    });
    return { byName: byName, freqs: Object.keys(freqs), set: freqs };
  }
  function hamming1(a, b) {
    if (a.length !== b.length) return false;
    var d = 0;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i] && ++d > 1) return false;
    return d === 1;
  }
  function snapAll(v, known) {
    return known.freqs.filter(function (f) { return hamming1(f, v); });
  }

  // ---------- one row ----------
  function cleanText(s) { return String(s || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').replace(/^(?:\S{0,2}\s*[|\[\]]+\s*)+/, '').replace(/^[\s|_\[\]]+|[\s|_\[\]]+$/g, '').trim(); }

  function buildRows(cells, known, learnedMap) {
    // cells: array of {ch,func,name,assigned,rx,rxTone,tx,txTone,mode,notes} raw OCR strings (+ optional conf)
    var parsed = cells.map(function (c) { return { rx: parseToneRaw(c.rxTone), tx: parseToneRaw(c.txTone) }; });
    var tmap = learnToneMap([].concat(parsed.map(function (p) { return p.rx; }), parsed.map(function (p) { return p.tx; })), learnedMap);
    return cells.map(function (c, i) {
      var flags = [], notes = [];
      var chNum = parseInt(digitsFix(String(c.ch || '').replace(/[^0-9OolISB|]/g, '')), 10);
      var row = { ch: isNaN(chNum) ? (c.pos || '') : chNum, func: cleanText(c.func), name: cleanText(c.name), assigned: cleanText(c.assigned),
        rx: '', rxTone: '', tx: '', txTone: '', mode: cleanText(c.mode).toUpperCase().slice(0, 1), notes: cleanText(c.notes), flags: [], fieldFlags: {} };
      function flag(field, code) { if (row.flags.indexOf(code) < 0) row.flags.push(code); (row.fieldFlags[field] = row.fieldFlags[field] || []).push(code); }

      row.suggest = {};
      row.rxDis = !!c.rxDis; row.txDis = !!c.txDis; row.rxAlts = c.rxAlts || []; row.txAlts = c.txAlts || [];
      ['rx', 'tx'].forEach(function (k) {
        var pf = parseFreq(digitsFix(c[k]));
        var v = pf.value;
        pf.flags.forEach(function (f) { flag(k, f); });
        var probs = v ? freqProblems(v) : [];
        probs.forEach(function (f) { flag(k, f); });
        row[k] = v;
        row[k + 'Ok'] = !!v && !probs.length;
      });
      // Never change a frequency on our own. Offer tap-to-apply suggestions for ones that look wrong.
      ['rx', 'tx'].forEach(function (k) {
        var other = k === 'rx' ? 'tx' : 'rx';
        if (!row[k] || row[k + 'Ok']) return;
        var sg = snapAll(row[k], known).slice(0, 3);
        if (row[other + 'Ok'] && sg.indexOf(row[other]) < 0) sg.push(row[other]);
        if (sg.length) row.suggest[k] = sg;
      });
      // readings from the three image variants that disagreed (or differ from the winner) become suggestions
      ['rx', 'tx'].forEach(function (k) {
        var alts = c[k + 'Alts'] || [], extra = [];
        alts.forEach(function (a) { var p = parseFreq(digitsFix(a)).value; if (p && p !== row[k] && !freqProblems(p).length && extra.indexOf(p) < 0) extra.push(p); });
        if (c[k + 'Dis']) {
          var winKnown = known.set && known.set[row[k]];
          var altKnown = alts.some(function (a) { var p = parseFreq(digitsFix(a)).value; return known.set && known.set[p]; });
          flag(k, winKnown && !altKnown ? 'freq-disagree-known' : 'freq-disagree');
        }
        if (extra.length) { row.suggest[k] = (row.suggest[k] || []).concat(extra.filter(function (e) { return (row.suggest[k] || []).indexOf(e) < 0; })); }
      });
      if (row.rxOk && row.txOk && hamming1(row.rx, row.tx)) { flag('rx', 'rx-tx-1digit'); flag('tx', 'rx-tx-1digit'); row.suggest.rx = [row.tx]; row.suggest.tx = [row.rx]; }
      if (!row.rx && !row.tx && (row.name || row.func)) flag('rx', 'freq-missing');

      [['rxTone', parsed[i].rx], ['txTone', parsed[i].tx]].forEach(function (pair) {
        var r = resolveTone(pair[1], tmap);
        r.flags.forEach(function (f) { flag(pair[0], f); });
        row[pair[0]] = r.none ? 'None' : (r.hz || '');
        row[pair[0] + 'Num'] = r.num;
      });

      if (!row.rxTone && row.txTone && row.txTone !== 'None' && (row.rx || row.tx)) { flag('rxTone', 'tone-missing'); row.suggest.rxTone = [row.txTone]; }
      if (!row.txTone && row.rxTone && row.rxTone !== 'None' && (row.rx || row.tx)) { flag('txTone', 'tone-missing'); row.suggest.txTone = [row.rxTone]; }

      // cross-check against the statewide load already in the app
      var kn = known.byName[normName(row.name)];
      if (kn && kn.length && row.rx) {
        var same = kn.some(function (k) { return k.rx === row.rx && (!row.tx || k.tx === row.tx); });
        if (!same) { flag('name', 'differs-from-load'); row.loadHint = kn[0].rx + ' / ' + kn[0].tx; }
        else row.matchesLoad = true;
      }
      if (c.conf != null && c.conf < 55) flag('name', 'low-confidence');
      if (row.mode && 'ADM'.indexOf(row.mode) < 0) flag('mode', 'mode-odd');
      return row;
    });
  }

  // ---------- header / footer text (from a plain OCR block) ----------
  function parseHeader(text) {
    var t = String(text || '');
    var out = { incident: '', zone: '', dateFrom: '', timeFrom: '', dateTo: '', timeTo: '', prepared: '', preparedTime: '' };
    var lines = t.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    for (var i = 0; i < lines.length; i++) {
      if (/incident\s*name/i.test(lines[i])) {
        var a = lines[i + 1] || '', b = lines[i + 2] || '';
        out.incident = cleanText(a.split(/Date|\|/i)[0]);
        out.zone = cleanText(b.split(/Time|\|/i)[0]);
        break;
      }
    }
    var m;
    if ((m = t.match(/Date\s*From:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i))) out.dateFrom = m[1];
    if ((m = t.match(/Date\s*To:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i))) out.dateTo = m[1];
    if ((m = t.match(/Time\s*From:?\s*(\d{3,4})/i))) out.timeFrom = m[1];
    if ((m = t.match(/Time\s*To:?\s*(\d{3,4})/i))) out.timeTo = m[1];
    return out;
  }
  function parseFooter(text) {
    var t = String(text || ''), out = { prepared: '', special: '' }, m;
    if ((m = t.match(/Name:\s*([A-Za-z][A-Za-z .'\-]{2,40})/))) out.prepared = cleanText(m[1]);
    var i = t.search(/Special\s*Instructions/i);
    if (i >= 0) {
      var rest = t.slice(i).split(/\r?\n/).slice(1).map(cleanText).filter(Boolean);
      var sp = [];
      for (var k = 0; k < rest.length; k++) { if (/^6\.|Prepared by/i.test(rest[k])) break; sp.push(rest[k]); }
      out.special = sp.join(' ');
    }
    return out;
  }


  // ---------- ICS-204 pieces ----------
  function parseIncidentName(text) {
    var lines = String(text || '').split(/\r?\n/).map(cleanText).filter(Boolean);
    lines = lines.filter(function (l) { return !/incident\s*name/i.test(l) && !/operations\s*personnel/i.test(l); });
    return cleanText(lines.join(' ').replace(/^\d\.\s*/, ''));
  }
  function parseBranchDiv(text) {
    var out = { branch: '', division: '', divName: '' }, lines = String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean), m;
    lines.forEach(function (l) {
      if ((m = l.match(/Page\s*\d+\s*of\s*\d+\s*(.*)$/i))) { out.divName = cleanText(m[1]); return; }
      if (/branch/i.test(l) || /division/i.test(l)) return;
      if (out.division) return;
      var t = l.replace(/[^A-Za-z0-9|\s]/g, ' ').trim();
      if ((m = t.match(/^([A-Za-z0-9|]{1,3})\s+([A-Za-z0-9]{1,3})$/))) { out.branch = m[1].replace('|', 'I'); out.division = m[2]; }
      else if ((m = t.match(/^([A-Za-z0-9]{1,2})$/))) out.division = m[1]; // the branch mark was dropped; the letter is the division
    });
    return out;
  }
  var OPS_LABELS = [['Operations Section Chief', /Operations\s*Sec\w*\s*Chi\w*/i], ['Night Ops', /Night\s*Ops/i], ['Branch Director', /Branch\s*Director/i],
    ['Branch Safety', /Branch\s*Safety/i], ['Division/Group Supervisor', /Division\s*\/?\s*Group\s*Supervisor/i], ['Air Attack', /Air\s*Attack/i]];
  function parseOps(text) {
    var t = String(text || '').replace(/[\r\n]+/g, ' '), hits = [];
    OPS_LABELS.forEach(function (L) { var m = L[1].exec(t); if (m) hits.push({ label: L[0], at: m.index, end: m.index + m[0].length }); });
    hits.sort(function (a, b) { return a.at - b.at; });
    return hits.map(function (h, i) {
      var v = t.slice(h.end, i + 1 < hits.length ? hits[i + 1].at : t.length).replace(/^[^A-Za-z0-9(]+/, '').replace(/[\s|]+$/, '');
      return { label: h.label, value: cleanText(v) };
    }).filter(function (o) { return o.value; });
  }
  function parseHoursLoc(raw) {
    var s = cleanText(raw), m = s.match(/^(\d{3,4})\s*[-–—~]\s*(\d{3,4})\s*(.*)$/);
    if (m) return { hours: m[1] + '-' + m[2], loc: cleanText(m[3]) };
    return { hours: '', loc: s };
  }
  function fixReq(raw) {
    var req = cleanText(raw).toUpperCase().replace(/\s+/g, '').replace(/^[-\u2013]+/, ''), fixed = false;
    if (/^0[0O]*-?\d/.test(req)) { var odd = /^0[0O]+/.test(req); req = 'O' + req.replace(/^[0O]+/, '').replace(/^(?!-)/, '-'); fixed = odd; } // the letter slot is never a digit (a lone 0 -> O is routine)
    else if (/^[A-Z]\d/.test(req)) { req = req[0] + '-' + req.slice(1); fixed = true; }                        // missing hyphen
    return { v: req, fixed: fixed };
  }
  function alnum(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function altsOf(win, alts, norm) { // readings that really differ from the winner (punctuation-only differences don't count)
    var w = norm(win), out = [];
    (alts || []).forEach(function (a) { var t = cleanText(a); if (t && norm(t) !== w && out.indexOf(t) < 0) out.push(t); });
    return out;
  }
  function buildResource(c) { // c: raw strings {id,als,leader,pers,req,hl|hours,loc} (+ idAlts, leaderAlts, reqAlts)
    var hl = c.hl != null ? parseHoursLoc(c.hl) : { hours: cleanText(c.hours), loc: cleanText(c.loc) };
    var fr = fixReq(c.req);
    var r = { id: cleanText(c.id), als: !!c.als, leader: cleanText(c.leader).replace(/^[^A-Za-z]+/, ''), personnel: cleanText(c.pers).replace(/[^0-9]/g, ''),
      request: fr.v, hours: hl.hours, loc: cleanText(hl.loc).replace(/[^A-Za-z0-9)]+$/, ''), flags: [], alts: {} };
    r.alts.id = altsOf(r.id, c.idAlts, alnum);
    r.alts.leader = altsOf(r.leader, c.leaderAlts, alnum);
    r.alts.request = altsOf(r.request, (c.reqAlts || []).map(function (a) { return fixReq(a).v; }).filter(function (a) { return /^[A-Z]-\d{1,6}$/.test(a); }), alnum);
    if (r.alts.id.length) r.flags.push('id-disagree');
    if (r.alts.leader.length) r.flags.push('leader-disagree');
    if (r.alts.request.length) r.flags.push('request-disagree');
    if (!r.personnel || parseInt(r.personnel, 10) > 99) r.flags.push('personnel');
    if (!/^[A-Z]-\d{1,6}$/.test(r.request)) r.flags.push('request'); else if (fr.fixed) r.flags.push('request-fixed');
    if (!/^\d{4}-\d{4}$/.test(r.hours)) r.flags.push('hours');
    return r;
  }
  // Request-number letter tells the kind of resource (NWCG convention): E equipment, C crew, O overhead, A aircraft, S supplies.
  var RTYPE = { E: 'Engines & equipment', C: 'Crews', O: 'Overhead', A: 'Aircraft', S: 'Supplies' };
  function resType(r) { var m = String(r.request || '').match(/^([A-Z])/); return m && RTYPE[m[1]] ? m[1] : '?'; }
  function groupRes(list) {
    var order = ['O', 'C', 'E', 'A', 'S', '?'], g = {};
    list.forEach(function (r) { (g[resType(r)] = g[resType(r)] || []).push(r); });
    return order.filter(function (k) { return g[k]; }).map(function (k) {
      var n = g[k].reduce(function (a, r) { return a + (parseInt(r.personnel, 10) || 0); }, 0);
      return { key: k, title: RTYPE[k] || 'Other', items: g[k], people: n };
    });
  }
  function totalPeople(list) { return list.reduce(function (a, r) { return a + (parseInt(r.personnel, 10) || 0); }, 0); }
  function parseFoot204(text) {
    var t = String(text || ''), out = { prepared: '', position: '', date: '', time: '', count: '' }, m;
    if ((m = t.match(/Name:\s*([^\n]*)/i))) {
      var nm = cleanText(m[1].split(/Signature|Date\/?Time/i)[0]), mm = nm.match(/^(.*?)\s+([A-Z]{2,6})$/);
      if (mm) { out.prepared = cleanText(mm[1]); out.position = mm[2]; } else out.prepared = nm;
    }
    if ((m = t.match(/Date\s*\/?\s*Time:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(\d{3,4})?/i))) { out.date = m[1]; out.time = m[2] || ''; }
    if ((m = t.match(/Personnel\s*Count:?\s*(\d{1,5})/i))) out.count = m[1];
    return out;
  }
  function sameIncident(a, b) {
    var x = String(a || '').toLowerCase().replace(/[^a-z0-9]/g, ''), y = String(b || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!x || !y) return true;
    return x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0 || x.slice(0, 5) === y.slice(0, 5);
  }
  // 204 channel vs the same-named channel on the 205: report any difference, never merge.
  function cross205(row, rows205) {
    var k = normName(row.name), hit = null;
    (rows205 || []).forEach(function (r) { if (!hit && normName(r.name) === k) hit = r; });
    if (!hit || !row.rx) return null;
    var same = hit.rx === row.rx && (!row.tx || !hit.tx || hit.tx === row.tx) && (hit.rxTone || 'None') === (row.rxTone || 'None') && (hit.txTone || 'None') === (row.txTone || 'None');
    if (same) return null;
    return hit.rx + (hit.rxTone && hit.rxTone !== 'None' ? ' ' + hit.rxTone : '') + ' / ' + (hit.tx || hit.rx) + (hit.txTone && hit.txTone !== 'None' ? ' ' + hit.txTone : '');
  }

  // ---------- zone for the app's existing ADDZ feature ----------
  function buildZone(meta, rows, opt) {
    opt = opt || {};
    var is204 = opt.kind === 'ics204', src = is204 ? 'ICS-204' : 'ICS-205';
    var name = is204 ? [meta.incident, 'Div ' + [meta.division, meta.divName].filter(Boolean).join(' ')].filter(Boolean).join(' · ') : ([meta.incident, meta.zone].filter(Boolean).join(' · ') || 'Incident');
    var op = '';
    if (meta.dateFrom) op = 'Op period ' + meta.dateFrom + (meta.timeFrom ? ' ' + meta.timeFrom : '') + (meta.dateTo ? ' to ' + meta.dateTo + (meta.timeTo ? ' ' + meta.timeTo : '') : '') + ' · from ' + src;
    else op = 'From ' + src;
    return {
      zone: is204 ? 'DIV' : 'INC', name: name, sub: op, color: is204 ? '#FFC53D' : '#FF8A3D', incident: true, incKind: opt.kind || 'ics205', divKey: opt.divKey || '',
      channels: rows.filter(function (r) { return r.rx || r.tx; }).map(function (r) {
        var note = [r.func, r.assigned, r.notes].filter(Boolean).join(' · ');
        if (r.txTone && r.txTone !== r.rxTone) note += (note ? ' · ' : '') + 'TX tone ' + r.txTone;
        if (r.mode && r.mode !== 'A') note += (note ? ' · ' : '') + 'Mode ' + r.mode;
        return { pos: r.ch === '' ? '' : String(r.ch), name: r.name || ('CH ' + r.ch), rx: r.rx || r.tx, tx: r.tx || r.rx,
          rxT: r.rxTone || 'None', note: note };
      })
    };
  }

  var api = { CTCSS: CTCSS, COLS: COLS, parseFreq: parseFreq, freqProblems: freqProblems, parseToneRaw: parseToneRaw, learnToneMap: learnToneMap,
    resolveTone: resolveTone, buildKnown: buildKnown, buildRows: buildRows, parseHeader: parseHeader, parseFooter: parseFooter, buildZone: buildZone, normName: normName,
    parseIncidentName: parseIncidentName, parseBranchDiv: parseBranchDiv, parseOps: parseOps, parseHoursLoc: parseHoursLoc, buildResource: buildResource,
    groupRes: groupRes, totalPeople: totalPeople, parseFoot204: parseFoot204, sameIncident: sameIncident, cross205: cross205, cleanText: cleanText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CGInc = api;
})(typeof window !== 'undefined' ? window : globalThis);
