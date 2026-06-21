'use strict';
// Front-end for the standalone PLC + Camera tool. Talks to server.js over fetch.

// ---- tiny DOM helpers -------------------------------------------------------
const $ = (id) => document.getElementById(id);
function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

// ---- tab switching ----------------------------------------------------------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === name));
  });
});

// ============================================================================
// CAMERA
// ============================================================================
const camIp = $('cam-ip');
const camRtsp = $('cam-rtsp');
const camTcp = $('cam-tcp');
const camVideo = $('cam-video');
const camPlaceholder = $('cam-placeholder');
const camStart = $('cam-start');
const camStop = $('cam-stop');
const camUser = $('cam-user');
const camPass = $('cam-pass');
const camPort = $('cam-port');
const camStream = $('cam-stream');

// Compose rtsp://user:pass@ip:port/h264/ch1/<main|sub>/av_stream from the fields.
$('cam-build').addEventListener('click', () => {
  const ip = camIp.value.trim() || '192.168.10.115';
  const port = (camPort.value || '554').toString().trim();
  const u = camUser.value.trim();
  const cred = u ? (encodeURIComponent(u) + (camPass.value ? ':' + encodeURIComponent(camPass.value) : '') + '@') : '';
  const which = (camStream.value === 'main') ? 'main' : 'sub';
  camRtsp.value = 'rtsp://' + cred + ip + ':' + port + '/h264/ch1/' + which + '/av_stream';
});

// If the URL has no inline credentials, inject them from the user/pass fields.
function withCreds(rtsp) {
  if (/^rtsp:\/\/[^/@]*@/i.test(rtsp)) { return rtsp; } // already has user:pass@
  const u = camUser.value.trim();
  if (!u) { return rtsp; }
  const cred = encodeURIComponent(u) + (camPass.value ? ':' + encodeURIComponent(camPass.value) : '') + '@';
  return rtsp.replace(/^(rtsp:\/\/)/i, '$1' + cred);
}

// Ping the camera.
$('cam-ping').addEventListener('click', async () => {
  const st = $('cam-ping-status');
  setStatus(st, 'pinging...', 'busy');
  try {
    const r = await fetch('/api/ping?ip=' + encodeURIComponent(camIp.value.trim()));
    const j = await r.json();
    setStatus(st, j.text || (j.ok ? 'online' : 'no reply'), j.ok ? 'ok' : 'bad');
  } catch (e) {
    setStatus(st, 'error: ' + e.message, 'bad');
  }
});

let camWatchdog = null;

function stopLiveView() {
  if (camWatchdog) { clearTimeout(camWatchdog); camWatchdog = null; }
  camVideo.classList.remove('live');
  camVideo.removeAttribute('src'); // closes the MJPEG connection -> ffmpeg exits
  camPlaceholder.textContent = 'Live view stopped';
  camPlaceholder.style.display = '';
  camStart.disabled = false;
  camStop.disabled = true;
}

function startLiveView() {
  const rtsp = withCreds(camRtsp.value.trim());
  if (!/^rtsp:\/\//i.test(rtsp)) {
    camPlaceholder.textContent = 'Enter a valid rtsp:// URL first';
    return;
  }
  camPlaceholder.textContent = 'Connecting to stream...';
  camPlaceholder.style.display = '';
  const src = '/camera/stream?url=' + encodeURIComponent(rtsp) +
    '&tcp=' + (camTcp.checked ? '1' : '0') + '&t=' + Date.now();

  if (camWatchdog) { clearTimeout(camWatchdog); }
  camWatchdog = setTimeout(() => {
    if (!camVideo.classList.contains('live')) {
      camPlaceholder.textContent = 'No video after 15s Ã¢â‚¬â€ check creds / path / network';
    }
  }, 15000);

  camVideo.onload = () => {
    if (camWatchdog) { clearTimeout(camWatchdog); camWatchdog = null; }
    camVideo.classList.add('live');
    camPlaceholder.style.display = 'none';
  };
  camVideo.onerror = () => {
    if (camWatchdog) { clearTimeout(camWatchdog); camWatchdog = null; }
    camPlaceholder.textContent = 'Stream failed (check URL / camera / ffmpeg)';
    camVideo.classList.remove('live');
    camStart.disabled = false;
    camStop.disabled = true;
  };
  camVideo.src = src;
  camStart.disabled = true;
  camStop.disabled = false;
}

camStart.addEventListener('click', startLiveView);
camStop.addEventListener('click', stopLiveView);

// ============================================================================
// PLC
// ============================================================================
const plcDevice = $('plc-device');
const plcCount = $('plc-count');
const plcValues = $('plc-values');
const plcStatus = $('plc-status');
const plcResult = $('plc-result');
const plcResultText = $('plc-result-text');
const plcResultHex = $('plc-result-hex');

let deviceTypes = {}; // { D:'word', M:'bit', ... }

// Populate the device dropdown (bit vs word optgroups) from /api/devices.
async function loadDevices() {
  try {
    const r = await fetch('/api/devices');
    deviceTypes = await r.json();
  } catch (e) {
    // fall back to a sensible built-in list if the server call fails
    deviceTypes = {
      X: 'bit', Y: 'bit', M: 'bit', L: 'bit', F: 'bit', B: 'bit', SM: 'bit', SB: 'bit',
      D: 'word', W: 'word', R: 'word', ZR: 'word', SD: 'word', SW: 'word', Z: 'word', TN: 'word', CN: 'word'
    };
  }
  const bit = [], word = [];
  Object.keys(deviceTypes).forEach((k) => (deviceTypes[k] === 'bit' ? bit : word).push(k));

  const mkGroup = (label, list) => {
    const og = document.createElement('optgroup');
    og.label = label;
    list.forEach((k) => {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = k + ' (' + deviceTypes[k] + ')';
      og.appendChild(o);
    });
    return og;
  };

  plcDevice.innerHTML = '';
  if (word.length) { plcDevice.appendChild(mkGroup('Word devices', word)); }
  if (bit.length) { plcDevice.appendChild(mkGroup('Bit devices', bit)); }
  plcDevice.value = 'D';
}

// Parse the "write values" field. Accepts comma/space separated; 0x prefix = hex.
function parseValues(str) {
  return String(str || '')
    .split(/[\s,]+/)
    .filter((t) => t.length)
    .map((t) => {
      const n = /^0x/i.test(t) ? parseInt(t, 16) : parseInt(t, 10);
      if (isNaN(n)) { throw new Error('bad value: ' + t); }
      return n;
    });
}

function plcBody(mode) {
  const body = {
    ip: $('plc-ip').value.trim(),
    port: Number($('plc-port').value) || 5007,
    frame: $('plc-frame').value,
    device: plcDevice.value,
    address: $('plc-addr').value.trim(),
    mode: mode
  };
  if (mode === 'write') { body.values = parseValues(plcValues.value); }
  else { body.count = Number(plcCount.value) || 1; }
  return body;
}

// Devices addressed in hex (mirrors HEX_ADDR in lib/mc.js).
const HEX_DEV = new Set(['X', 'Y', 'B', 'W', 'SB', 'SW', 'DX', 'DY']);

function baseAddrNum(device, addrStr) {
  const s = String(addrStr == null ? '0' : addrStr).trim();
  if (/^0x/i.test(s)) { return parseInt(s, 16); }
  if (HEX_DEV.has(device)) { return parseInt(s, 16); }
  return parseInt(s, 10);
}

function fmtRowAddr(device, baseNum, i) {
  const n = baseNum + i;
  return device + (HEX_DEV.has(device) ? n.toString(16).toUpperCase() : n.toString(10));
}

const toHex16 = (v) => '0x' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const toBin16 = (v) => (v & 0xFFFF).toString(2).padStart(16, '0').replace(/(.{4})(?=.)/g, '$1 ');
function toAscii16(v) {
  const ch = (c) => (c >= 0x20 && c <= 0x7E) ? String.fromCharCode(c) : '.';
  return ch(v & 0xFF) + ch((v >> 8) & 0xFF); // low byte = first char (MELSEC order)
}

// Build a per-register table. Word devices get Decimal/Hex/Binary/ASCII columns;
// bit devices get Value + State.
function buildValueTable(values, body) {
  const isBit = deviceTypes[body.device] === 'bit';
  const base = baseAddrNum(body.device, body.address);
  const heads = isBit ? ['Address', 'Value', 'State'] : ['Address', 'Decimal', 'Hex', 'Binary', 'ASCII'];

  const table = document.createElement('table');
  table.className = 'vtable';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  heads.forEach((h) => { const th = document.createElement('th'); th.textContent = h; htr.appendChild(th); });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  values.forEach((v, i) => {
    const tr = document.createElement('tr');
    const cells = isBit
      ? [fmtRowAddr(body.device, base, i), String(v), v ? 'ON' : 'OFF']
      : [fmtRowAddr(body.device, base, i), String(v), toHex16(v), toBin16(v), toAscii16(v)];
    cells.forEach((text, ci) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (!isBit && ci >= 2) { td.className = 'mono'; }
      if (isBit && ci === 2) { td.className = v ? 'on' : 'off'; }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

function showResult(j, body) {
  plcResult.hidden = false;
  plcResultText.innerHTML = '';
  if (j.ok && body && body.mode === 'read' && Array.isArray(j.values) && j.values.length) {
    plcResultText.appendChild(buildValueTable(j.values, body));
  } else {
    plcResultText.textContent = j.text || j.status || '';
  }
  plcResultHex.textContent = j.hex ? ('hex: ' + j.hex) : '';
}

async function plcSend(mode) {
  let body;
  try { body = plcBody(mode); }
  catch (e) { setStatus(plcStatus, e.message, 'bad'); return; }

  setStatus(plcStatus, mode + 'ing...', 'busy');
  try {
    const r = await fetch('/api/plc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    setStatus(plcStatus, j.ok ? 'OK' : (j.status || 'failed'), j.ok ? 'ok' : 'bad');
    showResult(j, body);
  } catch (e) {
    setStatus(plcStatus, 'error: ' + e.message, 'bad');
  }
}

$('plc-ping').addEventListener('click', async () => {
  setStatus(plcStatus, 'pinging...', 'busy');
  try {
    const r = await fetch('/api/ping?ip=' + encodeURIComponent($('plc-ip').value.trim()));
    const j = await r.json();
    setStatus(plcStatus, j.text || (j.ok ? 'online' : 'no reply'), j.ok ? 'ok' : 'bad');
  } catch (e) {
    setStatus(plcStatus, 'error: ' + e.message, 'bad');
  }
});

$('plc-read').addEventListener('click', () => plcSend('read'));
$('plc-write').addEventListener('click', () => plcSend('write'));

// Disable the count field when writing makes more sense to drive via values.
plcDevice.addEventListener('change', () => {
  const t = deviceTypes[plcDevice.value];
  plcValues.placeholder = (t === 'bit')
    ? 'bit: 1,0,1'
    : 'word: 100, 0x1F, 4096';
});

loadDevices();

// ============================================================================
// WATCHDOG  (crash -> self-heal test)
// ============================================================================
const wdState = $('wd-state');
const wdPid = $('wd-pid');
const wdUptime = $('wd-uptime');
const wdHeals = $('wd-heals');
const wdCrash = $('wd-crash');
const wdHeal = $('wd-heal');
const wdStatus = $('wd-status');
const wdLogEl = $('wd-log');

let wdLastPid = null;     // last PID we saw alive
let wdHealCount = 0;      // how many times the PID changed (= auto-heals observed)
let wdWasDown = false;    // were we DOWN on the previous poll?
let wdLogLines = [];      // newest-first

function wdLog(msg) {
  const t = new Date().toLocaleTimeString();
  wdLogLines.unshift({ t, msg });
  wdLogLines = wdLogLines.slice(0, 40);
  wdLogEl.innerHTML = '';
  wdLogLines.forEach((l) => {
    const d = document.createElement('div');
    const ts = document.createElement('span');
    ts.className = 't'; ts.textContent = l.t;
    d.appendChild(ts);
    d.appendChild(document.createTextNode(' ' + l.msg)); // textContent path = XSS-safe
    wdLogEl.appendChild(d);
  });
}

function fmtUptime(s) {
  s = Math.max(0, Math.round(s || 0));
  if (s < 60) { return s + 's'; }
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) { return m + 'm ' + r + 's'; }
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

async function wdPoll() {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch('/api/health?t=' + Date.now(), { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(to);
    if (!r.ok) { throw new Error('http ' + r.status); }
    const j = await r.json();

    // server is UP
    wdState.textContent = 'UP'; wdState.className = 'v up';
    wdPid.textContent = j.pid != null ? j.pid : 'Ã¢â‚¬â€';
    wdUptime.textContent = fmtUptime(j.uptimeSec);

    if (wdWasDown) { wdLog('server back UP (pid ' + j.pid + ')'); wdWasDown = false; }
    if (wdLastPid !== null && j.pid !== wdLastPid) {
      wdHealCount += 1;
      wdHeals.textContent = String(wdHealCount);
      wdLog('auto-healed Ã¢â‚¬â€ new pid ' + j.pid + ' (was ' + wdLastPid + ')');
    }
    wdLastPid = j.pid;
  } catch (e) {
    // server is DOWN / not responding
    wdState.textContent = 'DOWN'; wdState.className = 'v down';
    wdUptime.textContent = 'Ã¢â‚¬â€';
    if (!wdWasDown) {
      wdWasDown = true;
      wdLog('server DOWN Ã¢â‚¬â€ no response' + (wdLastPid ? ' (pid ' + wdLastPid + ' gone)' : ''));
    }
  }
}

wdCrash.addEventListener('click', async () => {
  const hang = $('wd-hang') && $('wd-hang').checked;
  const mode = hang ? 'hang' : 'exit';
  setStatus(wdStatus, 'crashing...', 'busy');
  wdLog('crash requested' + (wdLastPid ? ' (pid ' + wdLastPid + ')' : '') +
    (hang ? ' Ã¢â‚¬â€ freezing server (hang)' : ' Ã¢â‚¬â€ killing server process (exit)'));
  wdCrash.disabled = true;
  try {
    await fetch('/api/crash?mode=' + mode, { method: 'POST' });
  } catch (e) { /* the process dies mid-response; failure is expected */ }
  setStatus(wdStatus, 'killed Ã¢â‚¬â€ waiting for watchdog to revive...', 'busy');
  setTimeout(() => {
    wdCrash.disabled = false;
    setStatus(wdStatus, '', '');
  }, 5000);
});

// "Heal All Now" Ã¢â‚¬â€ force the watchdog to recover every crashed port right now
// (does not wait for the daemon's next poll). Healthy services are skipped.
wdHeal.addEventListener('click', async () => {
  setStatus(wdStatus, 'healing all down ports...', 'busy');
  wdLog('Heal All requested Ã¢â‚¬â€ running watchdog --recover-all');
  wdHeal.disabled = true;
  try {
    const r = await fetch('/watchdog/recover-all', { method: 'POST' });
    const j = await r.json();
    if (j.error && !j.actionCount) {
      setStatus(wdStatus, j.error, 'bad'); wdLog('heal: ' + j.error);
    } else {
      const recs = (j.actions || []).filter((a) => a.status === 'recovered');
      if (recs.length) {
        recs.forEach((a) => wdLog('healed ' + a.service + ' :' + (a.active_port || a.port) +
          ' Ã¢â€ â€™ pid ' + a.replacement_pid + ' (' + a.recovery_duration_s + 's)'));
        setStatus(wdStatus, 'Ã¢Å“â€¦ healed ' + recs.length + ' service(s)', 'ok');
      } else {
        setStatus(wdStatus, 'all services already healthy', 'ok');
        wdLog('heal: nothing to recover Ã¢â‚¬â€ all healthy');
      }
    }
  } catch (e) {
    setStatus(wdStatus, 'heal error: ' + e.message, 'bad');
    wdLog('heal error: ' + e.message);
  }
  wdHeal.disabled = false;
});

// Poll liveness every second (cheap local call; keeps the heal counter accurate
// even while you're on another tab when the restart happens).
wdPoll();
setInterval(wdPoll, 3000);

// ============================================================================
// RELIABILITY REPORT
// ============================================================================
const repWindow = $('rep-window'), repSvc = $('rep-svc'), repRecent = $('rep-recent');
let repData = null;
const fmtT = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 19) : 'Ã¢â‚¬â€');

async function loadReport() {
  try {
    const r = await fetch('/api/report?t=' + Date.now(), { cache: 'no-store' });
    const j = await r.json(); repData = j;
    $('rep-total').textContent = j.totalIncidents;
    $('rep-heals').textContent = j.totalRecovered;
    $('rep-mttr').textContent = (j.mttrAvg || 0) + 's';
    $('rep-alerts').textContent = j.totalAlerts;
    repWindow.textContent = j.firstAt ? ('since ' + fmtT(j.firstAt)) : 'no data yet';
    repSvc.innerHTML = '';
    if (!j.services.length) { repSvc.innerHTML = '<div class="muted">no incidents yet</div>'; }
    else {
      const tbl = document.createElement('table'); tbl.className = 'vtable';
      const thead = document.createElement('thead'); const htr = document.createElement('tr');
      ['Service', 'Incidents', 'Auto-heals', 'Alerts', 'Failed', 'MTTR', 'Last'].forEach((h) => { const th = document.createElement('th'); th.textContent = h; htr.appendChild(th); });
      thead.appendChild(htr); tbl.appendChild(thead);
      const tb = document.createElement('tbody');
      j.services.forEach((s) => {
        const tr = document.createElement('tr');
        [s.service, s.incidents, s.recovered, s.alerts, s.failed, (s.mttr || 0) + 's', fmtT(s.lastAt)].forEach((c, i) => {
          const td = document.createElement('td'); td.textContent = c; if (i >= 1 && i <= 5) { td.className = 'mono'; } tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
      tbl.appendChild(tb); repSvc.appendChild(tbl);
    }
    repRecent.innerHTML = '';
    if (!j.recent.length) { repRecent.innerHTML = '<div class="muted">no incidents yet</div>'; }
    else j.recent.forEach((i) => {
      const row = document.createElement('div'); row.className = 'feed-row';
      const ok = i.status === 'recovered';
      const dot = document.createElement('span'); dot.className = 'fdot ' + (ok ? 'up' : (i.status === 'alert_only' ? 'slow' : 'down'));
      const txt = document.createElement('span');
      txt.textContent = fmtT(i.detected_at).slice(11) + '  ' + i.service + '  Ã‚Â·  ' + (i.reason || '') + '  Ã‚Â·  pid ' +
        (i.crashed_pid != null ? i.crashed_pid : 'Ã¢â‚¬â€') + 'Ã¢â€ â€™' + (i.replacement_pid != null ? i.replacement_pid : 'Ã¢â‚¬â€') +
        '  Ã‚Â·  ' + (i.recovery_duration_s != null ? i.recovery_duration_s + 's' : '') + '  Ã‚Â·  ' + i.status;
      row.appendChild(dot); row.appendChild(txt); repRecent.appendChild(row);
    });
  } catch (e) { repWindow.textContent = 'report error: ' + e.message; }
}
function repDownloadCsv() {
  if (!repData) { return; }
  let csv = 'service,incidents,auto_heals,alerts,failed,mttr_s,last_status,last_at\n';
  repData.services.forEach((s) => { csv += [s.service, s.incidents, s.recovered, s.alerts, s.failed, s.mttr, s.lastStatus, s.lastAt].join(',') + '\n'; });
  csv += '\nrecent_incidents\ntime,service,reason,crashed_pid,new_pid,duration_s,status\n';
  repData.recent.forEach((i) => { csv += [i.detected_at, i.service, i.reason, i.crashed_pid, i.replacement_pid, i.recovery_duration_s, i.status].join(',') + '\n'; });
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'reliability-report.csv'; a.click(); URL.revokeObjectURL(a.href);
}
$('rep-refresh').addEventListener('click', loadReport);
$('rep-csv').addEventListener('click', repDownloadCsv);
document.querySelector('.tab[data-tab="report"]').addEventListener('click', loadReport);

// ============================================================================
// PLC PRESETS / RECIPES
// ============================================================================
const plcPresetList = $('plc-preset-list');
let _presets = [];
async function loadPresets() {
  try {
    const j = await (await fetch('/api/plc/presets?t=' + Date.now(), { cache: 'no-store' })).json();
    _presets = j.presets || [];
    plcPresetList.innerHTML = '<option value="">Ã¢â‚¬â€ select preset Ã¢â‚¬â€</option>';
    _presets.forEach((p) => {
      const o = document.createElement('option'); o.value = p.name;
      o.textContent = p.name + ' (' + p.device + p.address + ' Ãƒâ€”' + p.values.length + ')';
      plcPresetList.appendChild(o);
    });
  } catch (e) {}
}
$('plc-preset-load').addEventListener('click', () => {
  const name = plcPresetList.value; if (!name) { return; }
  const p = _presets.find((x) => x.name === name); if (!p) { return; }
  plcDevice.value = p.device; $('plc-addr').value = p.address; plcValues.value = p.values.join(', ');
  setStatus(plcStatus, 'preset "' + name + '" loaded Ã¢â‚¬â€ Write dabao to apply', 'ok');
});
$('plc-preset-save').addEventListener('click', async () => {
  let values; try { values = parseValues(plcValues.value); } catch (e) { setStatus(plcStatus, 'bad values: ' + e.message, 'bad'); return; }
  if (!values.length) { setStatus(plcStatus, 'pehle Write values bharo', 'bad'); return; }
  const name = prompt('Preset ka naam:'); if (!name) { return; }
  await fetch('/api/plc/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, device: plcDevice.value, address: $('plc-addr').value.trim(), values: values }) });
  await loadPresets(); plcPresetList.value = name; setStatus(plcStatus, 'preset "' + name + '" saved', 'ok');
});
$('plc-preset-del').addEventListener('click', async () => {
  const name = plcPresetList.value; if (!name) { return; }
  await fetch('/api/plc/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: name }) });
  await loadPresets(); setStatus(plcStatus, 'preset "' + name + '" deleted', 'ok');
});
loadPresets();

// ============================================================================
// REPORT — live heal-time trend graph (dark)
// ============================================================================
async function repDrawGraph() {
  const svg = document.getElementById('rep-graph'); if (!svg) { return; }
  let recs = [];
  try { recs = ((await (await fetch('/watchdog/incidents?limit=80&t=' + Date.now(), { cache: 'no-store' })).json()).incidents) || []; } catch (e) { return; }
  const series = recs.filter((r) => r.status === 'recovered' && typeof r.recovery_duration_s === 'number').reverse().map((r) => r.recovery_duration_s);
  const NS = 'http://www.w3.org/2000/svg', W = 640, H = 220, pad = 30;
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) { e.setAttribute(k, attrs[k]); } return e; };
  while (svg.firstChild) { svg.removeChild(svg.firstChild); }
  if (!series.length) {
    const t = mk('text', { x: W / 2, y: H / 2, fill: '#64748b', 'font-size': '13', 'text-anchor': 'middle' });
    t.textContent = 'no heal data yet — Watchdog tab se Crash dabake dekho';
    svg.appendChild(t); return;
  }
  const mx = Math.max.apply(null, series.concat([1]));
  const xs = (i) => (series.length === 1 ? W / 2 : pad + (W - 2 * pad) * (i / (series.length - 1)));
  const ys = (v) => H - pad - (H - 2 * pad) * (v / mx);
  // gradient
  const defs = mk('defs', {});
  const lg = mk('linearGradient', { id: 'repGrad', x1: '0', y1: '0', x2: '0', y2: '1' });
  lg.appendChild(mk('stop', { offset: '0%', 'stop-color': '#22d3ee', 'stop-opacity': '0.45' }));
  lg.appendChild(mk('stop', { offset: '100%', 'stop-color': '#22d3ee', 'stop-opacity': '0' }));
  defs.appendChild(lg); svg.appendChild(defs);
  // grid + y labels (seconds)
  for (let g = 0; g <= 4; g++) {
    const yv = mx * g / 4, yy = ys(yv);
    svg.appendChild(mk('line', { x1: pad, x2: W - pad, y1: yy, y2: yy, stroke: '#1f2937', 'stroke-width': '1' }));
    const lbl = mk('text', { x: 4, y: yy + 3, fill: '#64748b', 'font-size': '10' }); lbl.textContent = yv.toFixed(1) + 's'; svg.appendChild(lbl);
  }
  const pts = series.map((v, i) => ({ x: xs(i), y: ys(v) }));
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
  const area = 'M' + pts[0].x.toFixed(1) + ' ' + (H - pad) + ' ' + pts.map((p) => 'L' + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ') + ' L' + pts[pts.length - 1].x.toFixed(1) + ' ' + (H - pad) + ' Z';
  svg.appendChild(mk('path', { d: area, fill: 'url(#repGrad)', stroke: 'none' }));
  svg.appendChild(mk('path', { d: line, fill: 'none', stroke: '#22d3ee', 'stroke-width': '2' }));
  pts.forEach((p, i) => { const last = i === pts.length - 1; svg.appendChild(mk('circle', { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: (last ? 4 : 2.2), fill: (last ? '#34d399' : '#22d3ee') })); });
  const lastV = series[series.length - 1];
  const lt = mk('text', { x: W - pad, y: Math.max(14, ys(lastV) - 8), fill: '#34d399', 'font-size': '12', 'text-anchor': 'end', 'font-weight': '700' });
  lt.textContent = lastV + 's'; svg.appendChild(lt);
  const cap = mk('text', { x: pad, y: 14, fill: '#94a3b8', 'font-size': '10.5' }); cap.textContent = series.length + ' recoveries — heal time (s)'; svg.appendChild(cap);
}
$('rep-refresh').addEventListener('click', repDrawGraph);
document.querySelector('.tab[data-tab="report"]').addEventListener('click', repDrawGraph);
repDrawGraph();
setInterval(() => { if (document.getElementById('report').classList.contains('active')) { repDrawGraph(); } }, 5000);

// ============================================================================
// Watchdog 3D dog mascot — reacts to health (UP = happy, DOWN = alert)
// ============================================================================
setInterval(() => {
  const st = document.getElementById('wd-state'), stage = document.getElementById('dog-stage');
  if (!st || !stage) { return; }
  const down = st.textContent.trim() === 'DOWN';
  stage.classList.toggle('alert', down);
  stage.classList.toggle('happy', !down);
}, 1000);

// Load the Doberman image, chroma-key out the green screen (incl. fringe/halo),
// auto-crop tightly to the dog (no leftover background), and show it big.
(function initDogMascot() {
  const canvas = document.getElementById('dog-canvas');
  const fb = document.getElementById('dog-fallback');
  if (!canvas) { return; }
  const ctx = canvas.getContext('2d');
  const img = new Image();
  let triedJpg = false;
  img.onload = function () {
    // 1) draw at good resolution on an offscreen canvas
    const maxW = 560;
    const s = Math.min(1, maxW / img.width);
    const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
    const off = document.createElement('canvas'); off.width = w; off.height = h;
    const octx = off.getContext('2d');
    octx.drawImage(img, 0, 0, w, h);
    let minX = w, minY = h, maxX = 0, maxY = 0, found = false;
    try {
      const id = octx.getImageData(0, 0, w, h), d = id.data;
      // 2) remove green background + green halo/fringe + de-spill kept edges
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (g > 78 && g >= r * 1.18 && g >= b * 1.18) { d[i + 3] = 0; }                  // green screen
        else if (g > r + 16 && g > b + 8) { d[i + 3] = 0; }                               // residual green halo
        else if (g > r && g > b) { const m = Math.max(r, b); if (g > m) { d[i + 1] = m; } } // de-spill fringe
      }
      octx.putImageData(id, 0, 0);
      // 3) bounding box of the remaining (dog) pixels
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (d[(y * w + x) * 4 + 3] > 24) { found = true; if (x < minX) { minX = x; } if (x > maxX) { maxX = x; } if (y < minY) { minY = y; } if (y > maxY) { maxY = y; } }
        }
      }
    } catch (e) { /* same-origin, won't taint */ }
    if (!found) { minX = 0; minY = 0; maxX = w - 1; maxY = h - 1; }
    const pad = 8;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    // 4) visible canvas = tightly-cropped dog (no background margins) -> fills big
    canvas.width = bw; canvas.height = bh;
    ctx.clearRect(0, 0, bw, bh);
    ctx.drawImage(off, minX, minY, bw, bh, 0, 0, bw, bh);
    canvas.style.display = 'block';
    if (fb) { fb.style.display = 'none'; }
  };
  img.onerror = function () {
    if (!triedJpg) { triedJpg = true; img.src = '/dog.jpg?t=' + Date.now(); return; }
    canvas.style.display = 'none';
    if (fb) { fb.style.display = ''; }
  };
  img.src = '/dog.png?t=' + Date.now();
})();

