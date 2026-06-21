'use strict';
// Standalone PLC + Camera tool. Pure Node.js (no external deps, no Node-RED).
//   node server.js          -> http://localhost:3000
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const mc = require('./lib/mc');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const START_TIME = Date.now();
let HUNG = false; // demo: when true the server keeps its port open but stops responding (simulated freeze)

// ---- Reliability Dashboard: real port_watchdog.py wiring --------------------
const WD_DIR = path.join(__dirname, 'watchdog');
const WD_SCRIPT = path.join(WD_DIR, 'port_watchdog.py');
const WD_CONFIG = path.join(WD_DIR, 'watchdog.dashboard.json');
// "live" protection config the daemon + the Heal-All button use (recovers :3000)
const WD_CONFIG_LIVE = process.env.WD_CONFIG_LIVE || path.join(WD_DIR, 'watchdog.config.json');
const WD_INCIDENTS = path.join(__dirname, 'logs', 'watchdog_incidents.jsonl');
const PRESETS_FILE = path.join(__dirname, 'plc-presets.json');
const PYTHON = process.env.PYTHON || 'python';
const DEMO_PORT = 3010; // the crash-demo target service (separate from this server)

// ---- locate the bundled ffmpeg (./tools/**/ffmpeg.exe), else fall back to PATH ----
function findFfmpeg() {
    try {
        const stack = [path.join(__dirname, 'tools')];
        while (stack.length) {
            const dir = stack.pop();
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
            for (const ent of entries) {
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) { stack.push(full); }
                else if (ent.name.toLowerCase() === 'ffmpeg.exe' || ent.name.toLowerCase() === 'ffmpeg') { return full; }
            }
        }
    } catch (e) { /* ignore */ }
    return 'ffmpeg';
}
const FFMPEG = findFfmpeg();

// ---- helpers ----------------------------------------------------------------
function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        let tooBig = false;
        req.on('data', (c) => {
            data += c;
            if (data.length > 1e6) { tooBig = true; req.destroy(); }
        });
        req.on('end', () => {
            if (tooBig) { reject(new Error('body too large')); return; }
            try { resolve(data ? JSON.parse(data) : {}); }
            catch (e) { reject(new Error('invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

function pingHost(ip) {
    return new Promise((resolve) => {
        const host = String(ip || '').trim();
        if (!/^[a-zA-Z0-9_.-]+$/.test(host)) { resolve({ ok: false, text: 'invalid IP/host' }); return; }
        execFile('ping', ['-n', '2', '-w', '1000', host], { windowsHide: true }, (err, stdout, stderr) => {
            const out = (stdout || '') + (stderr || '');
            const ok = /TTL=/i.test(out);
            const m = out.match(/Average = (\d+ms)/i) || out.match(/time[=<]\s*(\d+\s*ms)/i);
            const text = ok ? ('online' + (m ? ' (' + m[1].replace(/\s/g, '') + ')' : '')) : 'no reply';
            resolve({ ok, text });
        });
    });
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
};

function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    // prevent path traversal
    const safe = path.normalize(rel).replace(/^(\.\.[\/\\])+/, '');
    const file = path.join(PUBLIC, safe);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        res.end(buf);
    });
}

// ---- camera live stream (RTSP -> MJPEG via ffmpeg) --------------------------
function cameraStream(req, res, query) {
    const target = String(query.url || '');
    const useTcp = query.tcp !== '0';
    if (!/^rtsp:\/\//i.test(target)) { res.writeHead(400); res.end('Bad or missing rtsp url'); return; }

    res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Connection': 'close'
    });

    const args = [];
    if (useTcp) { args.push('-rtsp_transport', 'tcp'); }
    // input options: low-latency + tolerate the camera's flaky HEVC stream
    args.push('-fflags', '+nobuffer+genpts+discardcorrupt', '-err_detect', 'ignore_err', '-rtsp_flags', 'prefer_tcp');
    args.push('-i', target);
    // output: drop audio, re-encode to MJPEG multipart at a steady frame rate
    args.push('-an', '-f', 'mpjpeg', '-q:v', '6', '-r', '12', 'pipe:1');

    let ff;
    try { ff = spawn(FFMPEG, args, { windowsHide: true }); }
    catch (e) { try { res.end(); } catch (_) {} return; }

    ff.stdout.pipe(res);
    ff.stderr.on('data', () => { /* ffmpeg progress on stderr; ignore */ });
    const cleanup = () => { try { ff.kill('SIGKILL'); } catch (e) {} };
    req.on('close', cleanup);
    res.on('close', cleanup);
    ff.on('error', () => { try { res.end(); } catch (e) {} });
    ff.on('exit', () => { try { res.end(); } catch (e) {} });
}

// ---- camera snapshot (one JPEG frame via ffmpeg) ----------------------------
function cameraSnapshot(req, res, query) {
    const target = String(query.url || '');
    const useTcp = query.tcp !== '0';
    if (!/^rtsp:\/\//i.test(target)) { res.writeHead(400); res.end('bad rtsp url'); return; }
    const args = [];
    if (useTcp) { args.push('-rtsp_transport', 'tcp'); }
    args.push('-i', target, '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', 'pipe:1');
    let ff; const buf = [];
    try { ff = spawn(FFMPEG, args, { windowsHide: true }); }
    catch (e) { res.writeHead(500); res.end('ffmpeg spawn failed'); return; }
    const killer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (_) {} }, 15000);
    ff.stdout.on('data', (d) => buf.push(d));
    ff.stderr.on('data', () => {});
    ff.on('error', () => { clearTimeout(killer); if (!res.headersSent) { res.writeHead(500); res.end('ffmpeg error'); } });
    ff.on('close', () => {
        clearTimeout(killer);
        const img = Buffer.concat(buf);
        if (img.length && !res.headersSent) {
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': img.length });
            res.end(img);
        } else if (!res.headersSent) { res.writeHead(502); res.end('no frame'); }
    });
    req.on('close', () => { try { ff.kill('SIGKILL'); } catch (e) {} });
}

// ---- watchdog CLI helpers (the dashboard drives the REAL python engine) -----
function runWatchdog(args, timeoutMs, configPath) {
    return new Promise((resolve) => {
        let out = '', err = '', done = false, child;
        try { child = spawn(PYTHON, [WD_SCRIPT, ...args, '--config', configPath || WD_CONFIG], { cwd: WD_DIR, windowsHide: true }); }
        catch (e) { resolve({ ok: false, error: String(e.message || e), stdout: '', stderr: '' }); return; }
        const t = setTimeout(() => { if (!done) { try { child.kill('SIGKILL'); } catch (_) {} } }, timeoutMs || 60000);
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => { if (done) return; done = true; clearTimeout(t); resolve({ ok: false, error: String(e.message || e), stdout: out, stderr: err }); });
        child.on('close', (code) => { if (done) return; done = true; clearTimeout(t); resolve({ ok: true, code, stdout: out, stderr: err }); });
    });
}

// The watchdog prints diagnostics on stderr and the final JSON on stdout; be lenient.
function parseLooseJson(s) {
    if (!s) return null;
    try { return JSON.parse(String(s).trim()); } catch (e) { /* fall through */ }
    const lines = String(s).trim().split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch (e) {} }
    return null;
}

async function fetchJson(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 2000);
    try { const r = await fetch(url, { signal: ctrl.signal }); clearTimeout(t); return r.ok ? await r.json() : null; }
    catch (e) { clearTimeout(t); return null; }
}

async function waitHealth(url, ms) {
    const deadline = Date.now() + (ms || 12000);
    while (Date.now() < deadline) {
        const j = await fetchJson(url, 1500);
        if (j) return j;
        await new Promise((r) => setTimeout(r, 400));
    }
    return null;
}

// One real crash -> self-heal cycle against the demo-service (keeps THIS server up).
async function watchdogDemoCrash(modeRaw) {
    const mode = (modeRaw === 'hang') ? 'hang' : 'exit';
    const health = 'http://127.0.0.1:' + DEMO_PORT + '/api/health';
    // 1) ensure the demo service is alive (the watchdog launches it if it is down)
    let before = await fetchJson(health, 1500);
    if (!before) { await runWatchdog(['--recover-all'], 45000); before = await waitHealth(health, 15000); }
    const beforePid = before ? before.pid : null;
    // 2) crash it the way the user chose
    try { await fetch('http://127.0.0.1:' + DEMO_PORT + '/api/crash?mode=' + mode, { method: 'POST' }); } catch (e) {}
    await new Promise((r) => setTimeout(r, mode === 'hang' ? 900 : 1800));
    // 3) run ONE real recovery cycle (same code path the 24x7 daemon runs each poll)
    const r = await runWatchdog(['--recover-all', '--json'], 60000);
    const snap = parseLooseJson(r.stdout);
    let incident = null;
    if (snap && Array.isArray(snap.actions)) {
        incident = snap.actions.find((a) => a.service === 'demo-service') || snap.actions[0] || null;
    }
    // 4) confirm the replacement is serving
    const after = await waitHealth(health, 15000);
    return {
        ok: !!(incident && incident.status === 'recovered'),
        mode, beforePid, afterPid: after ? after.pid : null,
        incident, error: incident ? null : ('watchdog ran but returned no incident' + (r.stderr ? (': ' + r.stderr.slice(-300)) : ''))
    };
}

// ---- PLC live monitor (poll registers -> history + chart + alarms + CSV) ----
const plcMon = { active: false, timer: null, cfg: null, history: [], alarmMin: null, alarmMax: null, lastError: '' };

async function plcMonSample() {
    const cfg = plcMon.cfg; if (!cfg) { return; }
    const t = new Date().toISOString();
    let values = null, error = '';
    if (cfg.simulate) {
        const base = Date.now() / 3000;
        values = [];
        for (let i = 0; i < cfg.count; i++) {
            const v = Math.round(2048 + 1400 * Math.sin(base + i * 0.7) + (Math.random() * 200 - 100));
            values.push(Math.max(0, Math.min(4095, v)));
        }
    } else {
        try {
            const r = await mc.request({ ip: cfg.ip, port: cfg.port, frame: cfg.frame, device: cfg.device, address: cfg.address, count: cfg.count, mode: 'read' });
            if (r && r.ok && Array.isArray(r.values)) { values = r.values; }
            else { error = (r && (r.status || r.text)) || 'read failed'; }
        } catch (e) { error = e.message || 'read error'; }
    }
    plcMon.lastError = error;
    plcMon.history.push({ t, values, error });
    if (plcMon.history.length > 600) { plcMon.history.shift(); }
    if (values) {
        try {
            const csv = path.join(__dirname, 'logs', 'plc-monitor.csv');
            if (!fs.existsSync(path.dirname(csv))) { fs.mkdirSync(path.dirname(csv), { recursive: true }); }
            if (!fs.existsSync(csv)) {
                fs.writeFileSync(csv, ['time'].concat(values.map((_, i) => cfg.device + (Number(cfg.address) + i))).join(',') + '\n');
            }
            fs.appendFileSync(csv, [t].concat(values).join(',') + '\n');
        } catch (e) { /* ignore csv errors */ }
    }
}

function plcMonStart(cfg) {
    plcMonStop();
    plcMon.cfg = cfg;
    plcMon.history = [];
    plcMon.alarmMin = (cfg.alarmMin === '' || cfg.alarmMin == null) ? null : Number(cfg.alarmMin);
    plcMon.alarmMax = (cfg.alarmMax === '' || cfg.alarmMax == null) ? null : Number(cfg.alarmMax);
    plcMon.active = true;
    const iv = Math.max(250, Number(cfg.interval) || 1000);
    plcMonSample();
    plcMon.timer = setInterval(plcMonSample, iv);
}

function plcMonStop() {
    if (plcMon.timer) { clearInterval(plcMon.timer); plcMon.timer = null; }
    plcMon.active = false;
}

function plcMonData() {
    const min = plcMon.alarmMin, max = plcMon.alarmMax;
    const latest = plcMon.history.length ? plcMon.history[plcMon.history.length - 1] : null;
    const alarms = [];
    if (latest && latest.values) {
        latest.values.forEach((v, i) => {
            const lo = (min != null && v < min), hi = (max != null && v > max);
            if (lo || hi) { alarms.push({ index: i, value: v, kind: lo ? 'LOW' : 'HIGH' }); }
        });
    }
    return { active: plcMon.active, cfg: plcMon.cfg, lastError: plcMon.lastError, alarmMin: min, alarmMax: max, history: plcMon.history.slice(-180), latest, alarms };
}

// ---- reliability report (analytics over the incident log) -------------------
function buildReport(cb) {
    fs.readFile(WD_INCIDENTS, 'utf8', (e, txt) => {
        const recs = [];
        if (!e && txt) { txt.trim().split(/\r?\n/).forEach((l) => { if (l) { try { recs.push(JSON.parse(l)); } catch (_) {} } }); }
        const bySvc = {};
        let firstAt = null, lastAt = null;
        const durs = [];
        recs.forEach((r) => {
            const s = bySvc[r.service] || (bySvc[r.service] = { service: r.service, incidents: 0, recovered: 0, alerts: 0, failed: 0, durations: [], lastStatus: '', lastAt: '' });
            s.incidents++;
            if (r.status === 'recovered') { s.recovered++; if (typeof r.recovery_duration_s === 'number') { s.durations.push(r.recovery_duration_s); durs.push(r.recovery_duration_s); } }
            else if (r.status === 'alert_only') { s.alerts++; }
            else if (/escalat|failed/.test(r.status || '')) { s.failed++; }
            s.lastStatus = r.status; s.lastAt = r.detected_at;
            if (r.detected_at && (!firstAt || r.detected_at < firstAt)) { firstAt = r.detected_at; }
            if (r.detected_at && (!lastAt || r.detected_at > lastAt)) { lastAt = r.detected_at; }
        });
        const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
        const services = Object.keys(bySvc).map((k) => {
            const s = bySvc[k];
            return { service: s.service, incidents: s.incidents, recovered: s.recovered, alerts: s.alerts, failed: s.failed, mttr: Number(avg(s.durations).toFixed(2)), lastStatus: s.lastStatus, lastAt: s.lastAt };
        });
        cb({
            totalIncidents: recs.length,
            totalRecovered: recs.filter((r) => r.status === 'recovered').length,
            totalAlerts: recs.filter((r) => r.status === 'alert_only').length,
            totalFailed: recs.filter((r) => /escalat|failed/.test(r.status || '')).length,
            mttrAvg: Number(avg(durs).toFixed(2)), mttrMin: durs.length ? Math.min.apply(null, durs) : 0, mttrMax: durs.length ? Math.max.apply(null, durs) : 0,
            firstAt, lastAt, services, recent: recs.slice(-15).reverse()
        });
    });
}

// ---- request router ---------------------------------------------------------
const server = http.createServer(async (req, res) => {
    if (HUNG) { return; } // simulated freeze: accept the socket but never respond (health checks time out)
    const u = url.parse(req.url, true);
    const p = u.pathname;
    try {
        if (p === '/api/ping') {
            const r = await pingHost(u.query.ip);
            sendJson(res, 200, r);
        } else if (p === '/api/plc' && req.method === 'POST') {
            const body = await readBody(req);
            const r = await mc.request(body);
            sendJson(res, 200, r);
        } else if (p === '/api/devices') {
            sendJson(res, 200, Object.keys(mc.DEV).reduce((o, k) => (o[k] = mc.DEV[k].type, o), {}));
        } else if (p === '/api/health') {
            // Lightweight liveness probe. The watchdog uses this as health_url,
            // and the Watchdog tab polls it to detect PID changes after a heal.
            sendJson(res, 200, {
                ok: true, pid: process.pid, port: PORT,
                uptimeSec: Math.round((Date.now() - START_TIME) / 1000),
                startedAt: new Date(START_TIME).toISOString()
            });
        } else if (p === '/api/crash' && req.method === 'POST') {
            // Self-heal TEST. Reply first, then fail this process.
            //   mode=exit (default): process.exit -> port closes (hard crash)
            //   mode=hang: keep the port open but stop responding (freeze)
            // Either way the watchdog should kill the owner and revive the port
            // with a NEW PID within a few seconds.
            const mode = String(u.query.mode || 'exit').toLowerCase();
            if (mode === 'hang') {
                sendJson(res, 200, {
                    ok: true, pid: process.pid, mode: 'hang',
                    msg: 'freezing (port stays open, stops responding) — watchdog should kill + revive port ' + PORT
                });
                HUNG = true;
            } else {
                sendJson(res, 200, {
                    ok: true, pid: process.pid, mode: 'exit',
                    msg: 'crashing in 300ms — watchdog should revive port ' + PORT
                });
                setTimeout(() => process.exit(1), 300);
            }
        } else if (p === '/api/report') {
            buildReport((rep) => sendJson(res, 200, rep));
        } else if (p === '/api/plc/monitor/start' && req.method === 'POST') {
            const body = await readBody(req);
            plcMonStart({
                ip: String(body.ip || '').trim(), port: Number(body.port) || 5007, frame: body.frame || '3E',
                device: body.device || 'D', address: (body.address != null ? body.address : '0'),
                count: Math.max(1, Math.min(32, Number(body.count) || 4)),
                interval: Number(body.interval) || 1000, simulate: !!body.simulate,
                alarmMin: body.alarmMin, alarmMax: body.alarmMax
            });
            sendJson(res, 200, { ok: true, active: true });
        } else if (p === '/api/plc/monitor/stop' && req.method === 'POST') {
            plcMonStop();
            sendJson(res, 200, { ok: true, active: false });
        } else if (p === '/api/plc/monitor/data') {
            sendJson(res, 200, plcMonData());
        } else if (p === '/api/plc/presets' && req.method === 'GET') {
            fs.readFile(PRESETS_FILE, 'utf8', (e, txt) => {
                let arr = []; if (!e) { try { arr = JSON.parse(txt) || []; } catch (_) {} }
                sendJson(res, 200, { presets: arr });
            });
        } else if (p === '/api/plc/presets' && req.method === 'POST') {
            const body = await readBody(req);
            let arr = []; try { arr = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')) || []; } catch (_) {}
            if (body.delete) { arr = arr.filter((x) => x.name !== body.delete); }
            else if (body.name) {
                const item = { name: String(body.name), device: body.device || 'D', address: String(body.address == null ? '0' : body.address), values: Array.isArray(body.values) ? body.values : [] };
                arr = arr.filter((x) => x.name !== item.name); arr.push(item);
            }
            try { fs.writeFileSync(PRESETS_FILE, JSON.stringify(arr, null, 2)); }
            catch (e) { sendJson(res, 200, { ok: false, error: e.message }); return; }
            sendJson(res, 200, { ok: true, presets: arr });
        } else if (p === '/watchdog/scan') {
            // live health of every configured service (real `--scan --json`)
            const r = await runWatchdog(['--scan', '--json'], 30000);
            const snap = parseLooseJson(r.stdout);
            sendJson(res, 200, snap || { services: [], error: 'scan failed', stderr: (r.stderr || '').slice(-300) });
        } else if (p === '/watchdog/incidents') {
            const limit = Math.min(100, Math.max(1, Number(u.query.limit) || 15));
            fs.readFile(WD_INCIDENTS, 'utf8', (e, txt) => {
                if (e) { sendJson(res, 200, { incidents: [] }); return; }
                const lines = txt.trim().split(/\r?\n/).filter(Boolean);
                const recs = [];
                for (let i = lines.length - 1; i >= 0 && recs.length < limit; i--) {
                    try { recs.push(JSON.parse(lines[i])); } catch (_) {}
                }
                sendJson(res, 200, { incidents: recs });
            });
        } else if (p === '/watchdog/listener-code') {
            fs.readFile(WD_SCRIPT, 'utf8', (e, txt) => {
                if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('watchdog source not found'); return; }
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(txt);
            });
        } else if (p === '/watchdog/demo-crash' && req.method === 'POST') {
            const out = await watchdogDemoCrash(u.query.mode);
            sendJson(res, 200, out);
        } else if (p === '/watchdog/ensure' && req.method === 'POST') {
            // bring any down recover:true services up (used when the dashboard opens)
            const r = await runWatchdog(['--recover-all', '--json'], 45000);
            sendJson(res, 200, parseLooseJson(r.stdout) || { ok: false, stderr: (r.stderr || '').slice(-300) });
        } else if (p === '/watchdog/recover-all' && req.method === 'POST') {
            // "Heal All Now": force-recover every DOWN service in the live protection
            // config. A healthy service (e.g. THIS server, since it just served you) is
            // skipped, so it never kills the port it is answering on.
            const r = await runWatchdog(['--recover-all', '--json'], 70000, WD_CONFIG_LIVE);
            const snap = parseLooseJson(r.stdout) || {};
            const actions = Array.isArray(snap.actions) ? snap.actions : [];
            const recovered = actions.filter((a) => a && a.status === 'recovered');
            sendJson(res, 200, {
                ok: true,
                scanned: snap.scanned,
                recoveredCount: recovered.length,
                actionCount: actions.length,
                actions,
                error: snap.actions ? undefined : ('watchdog returned no actions' + (r.stderr ? (': ' + r.stderr.slice(-200)) : ''))
            });
        } else if (p === '/camera/snapshot') {
            cameraSnapshot(req, res, u.query);
        } else if (p === '/camera/stream') {
            cameraStream(req, res, u.query);
        } else if (req.method === 'GET') {
            serveStatic(req, res, p);
        } else {
            res.writeHead(404); res.end('Not found');
        }
    } catch (e) {
        sendJson(res, 400, { ok: false, status: e.message || 'error' });
    }
});

server.listen(PORT, () => {
    console.log('PLC + Camera tool running at  http://localhost:' + PORT);
    console.log('ffmpeg: ' + FFMPEG);
});
