#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Autonomous Port Watchdog & Process Self-Healing  ==  Windows-safe
=================================================================

Continuously monitors critical listening ports (FastAPI / Flask / RTSP /
ffmpeg / websocket / AI inference / DB) and recovers ONLY the affected
process when it crashes, freezes, stops listening, or goes silent.

Design guarantees (production-safe):
  * NEVER reboots the machine or restarts unrelated processes.
  * Kills ONLY the PID that owns the failed port, and only if it matches the
    service's `proc_match` fingerprint (squatter guard) and is not a protected
    system process.
  * Cooldown + retry-window + circuit-breaker + per-service file-lock stop
    infinite restart loops, duplicate recoveries, and simultaneous conflicts.
  * `recover:false` services (databases) are monitored + alerted only, never
    killed.
  * State (breaker, cooldown, restart history, PID history, leak samples) is
    persisted to disk so the engine behaves identically whether it runs as a
    long-lived daemon OR is invoked one-shot per cycle by n8n.

CLI (n8n drives these; --daemon runs standalone):
  python port_watchdog.py --scan  [--json]            # health of every service
  python port_watchdog.py --recover <name> [--reason r] [--json]
  python port_watchdog.py --recover-all [--json]      # scan + heal all unhealthy
  python port_watchdog.py --validate <name> [--json]
  python port_watchdog.py --predict [--json]          # predictive crash scan
  python port_watchdog.py --status [--json]           # last snapshot
  python port_watchdog.py --reset <name>              # clear breaker/cooldown
  python port_watchdog.py --daemon                    # continuous loop
"""

import argparse
import base64
import json
import os
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone

import urllib.request
import urllib.error

try:
    import psutil
except ImportError:  # pragma: no cover
    psutil = None

# --------------------------------------------------------------------------- #
# Paths / constants
# --------------------------------------------------------------------------- #
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CONFIG = os.path.join(ROOT, "tools", "watchdog.config.json")
LOG_DIR = os.path.join(ROOT, "logs")
STATE_FILE = os.path.join(LOG_DIR, "watchdog_state.json")
STATUS_FILE = os.path.join(LOG_DIR, "watchdog_status.json")
INCIDENT_LOG = os.path.join(LOG_DIR, "watchdog_incidents.jsonl")

IS_WIN = os.name == "nt"
# Windows CreateProcess flags so the restarted service is fully detached and
# survives the watchdog process exiting / being recycled.
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000

# Never terminate these even if they somehow own a watched port.
PROTECTED_NAMES = {
    "system", "system idle process", "registry", "wininit.exe", "services.exe",
    "csrss.exe", "smss.exe", "lsass.exe", "winlogon.exe", "svchost.exe",
}
PROTECTED_PIDS = {0, 4}

JSON_MODE = False  # when True, ONLY the final JSON object goes to stdout


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def now() -> float:
    return time.time()


def iso(ts: float = None) -> str:
    return datetime.fromtimestamp(ts if ts is not None else now(),
                                  tz=timezone.utc).isoformat()


def log(*a):
    """Diagnostics -> stderr, so --json stdout stays machine-parseable."""
    print(*a, file=sys.stderr, flush=True)


def emit(obj):
    """Final machine-readable result -> stdout."""
    print(json.dumps(obj, default=str, ensure_ascii=False), flush=True)


def _ensure_dirs():
    os.makedirs(LOG_DIR, exist_ok=True)


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, obj):
    _ensure_dirs()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2, default=str)
    os.replace(tmp, path)


def _load_dotenv():
    """Load KEY=VALUE from a project .env (if present) into os.environ without
    overwriting existing vars. Keeps secrets (SMTP_PASS etc.) out of the JSON."""
    for path in (os.path.join(ROOT, ".env"), os.path.join(ROOT, "tools", ".env")):
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip().strip('"').strip("'")
                    if k and k not in os.environ:
                        os.environ[k] = v
        except Exception:
            pass


def load_config(path):
    _load_dotenv()
    cfg = load_json(path, None)
    if cfg is None:
        log(f"[watchdog] FATAL: cannot read config {path}")
        sys.exit(3)
    cfg.setdefault("global", {})
    cfg.setdefault("services", [])
    g = cfg["global"]
    g.setdefault("http_timeout_s", 3.0)
    g.setdefault("tcp_timeout_s", 2.0)
    g.setdefault("latency_warn_ms", 1500)
    g.setdefault("poll_interval_s", 10)
    g.setdefault("default_cooldown_s", 60)
    g.setdefault("max_restarts_per_window", 3)
    g.setdefault("restart_window_s", 600)
    g.setdefault("breaker_cooldown_s", 900)
    g.setdefault("boot_grace_s", 4)
    g.setdefault("boot_timeout_s", 30)
    g.setdefault("graceful_kill_s", 6)
    g.setdefault("port_free_timeout_s", 8)
    g.setdefault("validation_retries", 6)
    g.setdefault("validation_interval_s", 2.0)
    g.setdefault("alert_webhook", "")
    g.setdefault("smtp", {})
    sm = g["smtp"]
    sm.setdefault("enabled", False)
    sm.setdefault("host", "smtp.office365.com")
    sm.setdefault("port", 587)
    sm.setdefault("starttls", True)
    sm.setdefault("on", "critical")            # "critical" = escalations only; "all" = every recovery
    sm.setdefault("subject_prefix", "[MES Watchdog]")
    # secrets from env / .env override the JSON (so the password isn't committed)
    e = os.environ
    if e.get("SMTP_HOST"):
        sm["host"] = e["SMTP_HOST"]
    if e.get("SMTP_PORT"):
        sm["port"] = int(e["SMTP_PORT"])
    if e.get("SMTP_USER"):
        sm["user"] = e["SMTP_USER"]
        sm["from"] = sm.get("from") or e["SMTP_USER"]
    if e.get("SMTP_FROM"):
        sm["from"] = e["SMTP_FROM"]
    if e.get("SMTP_PASS"):
        sm["password"] = e["SMTP_PASS"]
        sm["enabled"] = True
    if e.get("SMTP_ON"):
        sm["on"] = e["SMTP_ON"]
    if e.get("NOTIFY_EMAIL"):
        sm["to"] = [x.strip() for x in e["NOTIFY_EMAIL"].split(",") if x.strip()]
    if not sm.get("to") and sm.get("user"):
        sm["to"] = [sm["user"]]                 # default recipient: send to self
    g.setdefault("predictive", {})
    p = g["predictive"]
    p.setdefault("enabled", True)
    p.setdefault("samples", 6)
    p.setdefault("ram_growth_mb", 400)
    p.setdefault("cpu_sustained_pct", 92)
    p.setdefault("thread_ceiling", 1200)
    p.setdefault("handle_ceiling", 8000)
    p.setdefault("high_prob", 0.75)
    return cfg


# --------------------------------------------------------------------------- #
# State (breaker / cooldown / restart history / leak samples)
# --------------------------------------------------------------------------- #
def load_state():
    return load_json(STATE_FILE, {"services": {}, "updated_at": iso()})


def save_state(state):
    state["updated_at"] = iso()
    save_json(STATE_FILE, state)


def svc_state(state, name):
    s = state["services"].setdefault(name, {})
    s.setdefault("restart_history", [])
    s.setdefault("breaker", {"open": False, "until": 0, "reason": ""})
    s.setdefault("last_restart_at", 0)
    s.setdefault("restart_count_total", 0)
    s.setdefault("pid_history", [])
    s.setdefault("samples", [])
    s.setdefault("last_status", "unknown")
    return s


def append_incident(rec):
    _ensure_dirs()
    with open(INCIDENT_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")


# --------------------------------------------------------------------------- #
# Port / PID introspection
# --------------------------------------------------------------------------- #
def pids_on_port(port, host=None):
    """Return PIDs that hold a LISTEN socket on `port` (Windows-safe)."""
    found = []
    if psutil is not None:
        try:
            for c in psutil.net_connections(kind="inet"):
                if not c.laddr:
                    continue
                if c.laddr.port != port:
                    continue
                if c.status not in (psutil.CONN_LISTEN, "LISTEN", "NONE"):
                    continue
                if c.pid:
                    found.append(c.pid)
        except (psutil.AccessDenied, PermissionError):
            found = _pids_on_port_netstat(port)
        except Exception:
            found = _pids_on_port_netstat(port)
    else:
        found = _pids_on_port_netstat(port)
    return sorted(set(found))


def _pids_on_port_netstat(port):
    """Fallback: parse `netstat -ano` (no admin needed)."""
    pids = set()
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True,
                             text=True, timeout=8).stdout
        needle = f":{port} "
        for line in out.splitlines():
            if "LISTEN" in line.upper() and needle in line:
                parts = line.split()
                if parts and parts[-1].isdigit():
                    pids.add(int(parts[-1]))
    except Exception:
        pass
    return list(pids)


def proc_info(pid):
    info = {"pid": pid, "exists": False, "name": "", "cmdline": "",
            "status": "", "cpu": 0.0, "rss_mb": 0.0, "threads": 0,
            "handles": 0, "create_time": 0}
    if psutil is None:
        info["exists"] = True
        return info
    try:
        p = psutil.Process(pid)
        with p.oneshot():
            info["exists"] = True
            info["name"] = p.name()
            try:
                info["cmdline"] = " ".join(p.cmdline())
            except Exception:
                info["cmdline"] = info["name"]
            try:
                info["status"] = p.status()
            except Exception:
                pass
            try:
                info["rss_mb"] = round(p.memory_info().rss / 1048576.0, 1)
            except Exception:
                pass
            try:
                info["threads"] = p.num_threads()
            except Exception:
                pass
            try:
                info["handles"] = p.num_handles() if IS_WIN else 0
            except Exception:
                pass
            try:
                info["create_time"] = p.create_time()
            except Exception:
                pass
    except psutil.NoSuchProcess:
        pass
    except Exception:
        pass
    return info


def cpu_sample(pid, interval=0.15):
    if psutil is None:
        return 0.0
    try:
        return psutil.Process(pid).cpu_percent(interval=interval)
    except Exception:
        return 0.0


def pids_by_match(match):
    """PIDs whose name/cmdline contains `match` -- for port-less services
    (ffmpeg, `python collector.py`) watched in process-presence mode."""
    out = []
    if not match or psutil is None:
        return out
    ml = match.lower()
    self_pid = os.getpid()
    for p in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            if p.info["pid"] == self_pid:
                continue
            nm = p.info.get("name") or ""
            cl = " ".join(p.info.get("cmdline") or [])
            if ml in (nm + " " + cl).lower():
                out.append(p.info["pid"])
        except Exception:
            continue
    return sorted(set(out))


# --------------------------------------------------------------------------- #
# Health probes
# --------------------------------------------------------------------------- #
def tcp_open(host, port, timeout):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def _is_local(host):
    return (host or "").lower() in ("127.0.0.1", "localhost", "::1", "0.0.0.0", "")


def rtsp_check(host, port, timeout):
    """RTSP OPTIONS probe -> True if the camera responds (200/401/etc = alive)."""
    try:
        with socket.create_connection((host, port), timeout=timeout) as s:
            s.sendall((f"OPTIONS rtsp://{host}:{port} RTSP/1.0\r\n"
                       "CSeq: 1\r\nUser-Agent: port-watchdog\r\n\r\n").encode())
            resp = s.recv(256).decode("utf-8", "replace")
        return "RTSP/1.0" in resp
    except Exception:
        return False


def http_health(url, timeout):
    """Return (ok, status_code, latency_ms, snippet)."""
    t0 = now()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "port-watchdog"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(256)
            ms = round((now() - t0) * 1000, 1)
            return (200 <= r.status < 400, r.status, ms,
                    body.decode("utf-8", "replace")[:120])
    except urllib.error.HTTPError as e:
        ms = round((now() - t0) * 1000, 1)
        return (False, e.code, ms, "")
    except Exception as e:
        ms = round((now() - t0) * 1000, 1)
        return (False, 0, ms, type(e).__name__)


def ws_check(url, timeout):
    """Minimal RFC6455 handshake probe -> True if server returns 101."""
    try:
        scheme, rest = url.split("://", 1)
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        port = int(port or (443 if scheme == "wss" else 80))
        path = "/" + path
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        with socket.create_connection((host, port), timeout=timeout) as s:
            s.sendall(req.encode())
            resp = s.recv(256).decode("utf-8", "replace")
        return "101" in resp.split("\r\n", 1)[0]
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# Scan + predict
# --------------------------------------------------------------------------- #
def scan_service(svc, state, cfg):
    """Return a health dict for one service and refresh its leak samples."""
    g = cfg["global"]
    name = svc["name"]
    host = svc.get("host", "127.0.0.1")
    port = svc["port"]
    st = svc_state(state, name)

    proc_mode = not port                      # port:0 => watch by process presence
    active_port = port
    if proc_mode:
        listening = None
        pids = pids_by_match(svc.get("proc_match"))
        owner = pids[0] if pids else None
    else:
        active_port, listening, pids, owner = _scan_active(svc, g)  # failover-aware

    remote = svc.get("remote", not _is_local(host))   # camera/DB on the LAN => no local pid
    heartbeat, http_status, latency_ms, snippet = (None, None, None, "")
    if svc.get("rtsp"):                               # camera: RTSP OPTIONS probe
        t0 = now()
        ok = bool(listening and rtsp_check(host, active_port, g["tcp_timeout_s"]))
        heartbeat, http_status, latency_ms = ok, (200 if ok else 0), round((now() - t0) * 1000, 1)
    else:
        hurl = _health_url(svc, active_port) if not proc_mode else svc.get("health_url")
        if hurl:
            heartbeat, http_status, latency_ms, snippet = http_health(hurl, g["http_timeout_s"])

    ws_ok = None
    if svc.get("ws_url") or svc.get("ws_path"):
        ws_ok = ws_check(_ws_url(svc, active_port), g["tcp_timeout_s"])

    # metrics + predictive sampling on the owning process
    metrics, prediction = {}, {}
    if owner:
        m = proc_info(owner)
        m["cpu"] = cpu_sample(owner)
        metrics = {"pid": owner, "cpu": m["cpu"], "rss_mb": m["rss_mb"],
                   "threads": m["threads"], "handles": m["handles"],
                   "status": m["status"], "name": m["name"]}
        prediction = _update_and_predict(st, m, cfg)

    # ---- classify health ------------------------------------------------- #
    healthy, reason = True, "ok"
    if proc_mode:
        if owner is None:
            healthy, reason = False, "process_missing"      # ffmpeg/collector died
        elif heartbeat is False and http_status == 0:
            healthy, reason = False, "heartbeat_timeout"
    elif not listening:
        healthy, reason = False, ("unreachable" if remote else "port_closed")
    elif heartbeat is False and http_status == 0:
        healthy, reason = False, "heartbeat_timeout"        # hung / silent
    elif heartbeat is False and http_status and http_status >= 400:
        healthy, reason = False, f"heartbeat_http_{http_status}"  # app broken
    elif owner is None and not remote:                      # remote devices have no local pid
        healthy, reason = False, "no_owner_pid"             # zombie listener
    elif latency_ms is not None and latency_ms > g["latency_warn_ms"]:
        healthy, reason = True, "high_latency"              # degraded, not down

    # squatter / fingerprint mismatch
    fp = svc.get("proc_match")
    owner_match = True
    if owner and fp:
        owner_match = fp.lower() in (metrics.get("name", "") + " " +
                                     proc_info(owner).get("cmdline", "")).lower()

    st["last_status"] = reason if not healthy else (
        "degraded" if reason == "high_latency" else "healthy")

    return {
        "name": name, "port": active_port, "configured_port": port,
        "failed_over": bool(active_port and active_port != port), "host": host,
        "type": svc.get("type", "http"), "critical": svc.get("critical", True),
        "recover": svc.get("recover", True),
        "listening": listening, "pids": pids, "owner_pid": owner,
        "owner_match": owner_match,
        "heartbeat": heartbeat, "http_status": http_status,
        "latency_ms": latency_ms, "ws_ok": ws_ok,
        "healthy": healthy, "degraded": reason == "high_latency",
        "reason": reason, "metrics": metrics, "prediction": prediction,
        "breaker_open": st["breaker"]["open"],
        "checked_at": iso(),
    }


def _update_and_predict(st, m, cfg):
    """Roll a small metric window and estimate crash probability."""
    p = cfg["global"]["predictive"]
    if not p.get("enabled", True):
        return {}
    st["samples"].append({"t": now(), "cpu": m.get("cpu", 0.0),
                          "rss_mb": m.get("rss_mb", 0.0),
                          "threads": m.get("threads", 0),
                          "handles": m.get("handles", 0)})
    st["samples"] = st["samples"][-max(3, p["samples"]):]
    s = st["samples"]
    if len(s) < 3:
        return {"crash_probability": 0.0, "signals": [], "samples": len(s)}

    rss = [x["rss_mb"] for x in s]
    cpu = [x["cpu"] for x in s]
    thr = [x["threads"] for x in s]
    hnd = [x["handles"] for x in s]

    signals, prob = [], 0.0
    ram_growth = max(rss) - min(rss)
    # monotonic-ish climb = leak
    climbing = sum(1 for i in range(1, len(rss)) if rss[i] >= rss[i - 1] - 2)
    if ram_growth >= p["ram_growth_mb"] and climbing >= len(rss) - 1:
        signals.append(f"ram_leak(+{round(ram_growth)}MB)")
        prob += 0.45
    cpu_avg = sum(cpu) / len(cpu)
    if cpu_avg >= p["cpu_sustained_pct"]:
        signals.append(f"cpu_sustained({round(cpu_avg)}%)")
        prob += 0.35
    if max(thr) >= p["thread_ceiling"]:
        signals.append(f"thread_storm({max(thr)})")
        prob += 0.3
    if max(hnd) >= p["handle_ceiling"]:
        signals.append(f"handle_leak({max(hnd)})")
        prob += 0.3

    prob = round(min(prob, 0.99), 2)
    return {"crash_probability": prob, "signals": signals,
            "ram_growth_mb": round(ram_growth, 1), "cpu_avg": round(cpu_avg, 1),
            "samples": len(s), "high": prob >= p["high_prob"]}


# --------------------------------------------------------------------------- #
# Kill / launch / validate
# --------------------------------------------------------------------------- #
def safe_kill(pids, proc_match, graceful_s):
    """Terminate the port owner(s) gracefully then forcefully. Guarded."""
    out = {"killed": [], "skipped": []}
    self_pid = os.getpid()
    for pid in pids:
        if pid in PROTECTED_PIDS or pid == self_pid:
            out["skipped"].append({"pid": pid, "why": "protected/self"})
            continue
        info = proc_info(pid)
        nm = (info.get("name") or "").lower()
        if nm in PROTECTED_NAMES:
            out["skipped"].append({"pid": pid, "why": f"protected({nm})"})
            continue
        if proc_match and proc_match.lower() not in (
                nm + " " + info.get("cmdline", "")).lower():
            out["skipped"].append({"pid": pid, "why": "fingerprint_mismatch"})
            continue
        if psutil is None:
            try:
                subprocess.run(["taskkill", "/PID", str(pid), "/F", "/T"],
                               capture_output=True, timeout=10)
                out["killed"].append(pid)
            except Exception as e:
                out["skipped"].append({"pid": pid, "why": str(e)})
            continue
        try:
            p = psutil.Process(pid)
            children = []
            try:
                children = p.children(recursive=True)
            except Exception:
                pass
            p.terminate()
            gone, alive = psutil.wait_procs([p], timeout=graceful_s)
            if alive:
                for q in alive:
                    try:
                        q.kill()
                    except Exception:
                        pass
            # reap worker children (uvicorn/ffmpeg spawn helpers)
            for ch in children:
                try:
                    if ch.is_running():
                        ch.kill()
                except Exception:
                    pass
            out["killed"].append(pid)
        except psutil.NoSuchProcess:
            out["killed"].append(pid)  # already dead == success
        except Exception as e:
            out["skipped"].append({"pid": pid, "why": str(e)})
    return out


def wait_port_free(host, port, timeout):
    deadline = now() + timeout
    while now() < deadline:
        if not tcp_open(host, port, 1.0):
            return True
        time.sleep(0.4)
    return False


# --------------------------------------------------------------------------- #
# Port-failover helpers (opt-in per service via "alt_ports")
# --------------------------------------------------------------------------- #
def _candidate_ports(svc):
    """Primary port first, then any standby ports. (Just [port] if no alts.)"""
    out, seen = [], set()
    for p in [svc.get("port")] + list(svc.get("alt_ports", []) or []):
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _subst_port(val, port):
    return val.replace("{port}", str(port)) if isinstance(val, str) and port else val


def _health_url(svc, port):
    """Health URL for a specific port (so failover checks the right port)."""
    host = svc.get("host", "127.0.0.1")
    if svc.get("health_path"):
        return f"http://{host}:{port}{svc['health_path']}"
    hu = svc.get("health_url")
    return hu.replace("{port}", str(port)) if (hu and "{port}" in hu) else hu


def _ws_url(svc, port):
    host = svc.get("host", "127.0.0.1")
    if svc.get("ws_path"):
        return f"ws://{host}:{port}{svc['ws_path']}"
    wu = svc.get("ws_url")
    return wu.replace("{port}", str(port)) if (wu and "{port}" in wu) else wu


def _port_parameterizable(svc):
    """True if the restart command can actually be told a NEW port — via a
    {port} placeholder in argv/cmd, or a port_env. Failover is only real when
    the service can bind the standby port; otherwise it's a no-op."""
    r = svc.get("restart") or {}
    if r.get("port_env"):
        return True
    if any("{port}" in str(a) for a in (r.get("argv") or [])):
        return True
    return "{port}" in (r.get("cmd") or "")


def _pick_launch_port(svc, g):
    """Relaunch on the primary if it can be freed, else the first free standby.
    Standbys are used ONLY if the service can receive a new port (port_env or
    {port} in the command) — otherwise failover would launch on the same stuck
    port and validate would chase the wrong process."""
    host = svc.get("host", "127.0.0.1")
    primary = svc.get("port")
    if not primary:
        return None
    alts = svc.get("alt_ports") or []
    if alts and not _port_parameterizable(svc):
        log(f"[watchdog] {svc['name']}: alt_ports set but restart cmd has no "
            "{port}/port_env — can't move ports, ignoring standbys.")
        alts = []
    wait = svc.get("failover_after_s", g["port_free_timeout_s"]) if alts \
        else g["port_free_timeout_s"]
    if wait_port_free(host, primary, wait):
        return primary
    for alt in alts:
        if not tcp_open(host, alt, 1.0):          # standby is free
            return alt
    return primary                                # nothing free -> try primary anyway


def _scan_active(svc, g):
    """Which candidate port is currently live (failover-aware). Prefers the
    port whose owner matches the service fingerprint. Returns
    (active_port, listening, pids, owner)."""
    host = svc.get("host", "127.0.0.1")
    fp = (svc.get("proc_match") or "").lower()
    first = None
    for p in _candidate_ports(svc):
        if not tcp_open(host, p, g["tcp_timeout_s"]):
            continue
        pids = pids_on_port(p, host)
        owner = pids[0] if pids else None
        if first is None:
            first = (p, pids, owner)
        if owner and fp:
            info = proc_info(owner)
            if fp in ((info.get("name") or "") + " " + (info.get("cmdline") or "")).lower():
                return p, True, pids, owner       # fingerprint match wins
    return (first[0], True, first[1], first[2]) if first else (svc.get("port"), False, [], None)


def launch(svc, port=None):
    """Start the service detached (optionally on a chosen port for failover).
    Substitutes {port} in argv/env and sets WATCHDOG_PORT. Returns
    (launcher_pid, error|None)."""
    r = svc.get("restart") or {}
    if port is None:
        port = svc.get("port")
    argv = r.get("argv")
    if not argv:
        cmd = r.get("cmd")
        if not cmd:
            return None, "no restart command configured"
        if r.get("shell"):
            argv = ["cmd", "/c", cmd] if IS_WIN else ["/bin/sh", "-c", cmd]
        else:
            import shlex
            argv = shlex.split(cmd, posix=not IS_WIN)

    if port:                                   # port-failover: bind where we chose
        argv = [_subst_port(a, port) for a in argv]

    cwd = r.get("cwd") or ROOT
    if not os.path.isabs(cwd):
        cwd = os.path.join(ROOT, cwd)
    env = dict(os.environ)
    env.update({k: _subst_port(str(v), port) for k, v in (r.get("env") or {}).items()})
    if port:
        env["WATCHDOG_PORT"] = str(port)
        if r.get("port_env"):                  # service reads its port from this env var
            env[r["port_env"]] = str(port)

    logf = r.get("log") or os.path.join(LOG_DIR, f"{svc['name']}.watchdog.log")
    if not os.path.isabs(logf):
        logf = os.path.join(ROOT, logf)
    _ensure_dirs()
    out = open(logf, "a", encoding="utf-8", errors="replace")
    out.write(f"\n===== watchdog restart {iso()} :: {' '.join(map(str, argv))} =====\n")
    out.flush()

    flags = 0
    if IS_WIN:
        flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    try:
        kw = dict(cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                  stdout=out, stderr=subprocess.STDOUT, close_fds=True)
        if IS_WIN:
            kw["creationflags"] = flags
        else:
            kw["start_new_session"] = True
        p = subprocess.Popen([str(a) for a in argv], **kw)
        return p.pid, None
    except Exception as e:
        return None, f"launch failed: {e}"


def validate(svc, cfg, exclude_pids, ports=None, prefer_port=None):
    """Poll until a new instance is healthy on ONE of the candidate ports
    (primary or a standby). Checks `prefer_port` (where we actually launched)
    FIRST. Returns a validation dict including the working `port` + `failed_over`."""
    g = cfg["global"]
    host = svc.get("host", "127.0.0.1")
    proc_mode = not svc.get("port")
    cands = ports if ports is not None else _candidate_ports(svc)
    if prefer_port and prefer_port in cands:        # confirm where we launched it
        cands = [prefer_port] + [c for c in cands if c != prefer_port]
    deadline = now() + g["boot_timeout_s"]
    time.sleep(g["boot_grace_s"])
    last = {"passed": False}
    tries = 0
    excl = set(exclude_pids)
    while now() < deadline and tries < g["validation_retries"]:
        tries += 1
        active, new_pid = None, None
        listening = None if proc_mode else False
        hb, code, ms, ws_ok = True, 200, 0, None
        if proc_mode:
            pids = [p for p in pids_by_match(svc.get("proc_match")) if p not in excl]
            new_pid = pids[0] if pids else None
            hurl = _health_url(svc, svc.get("port") or 0)
            if hurl:
                hb, code, ms, _ = http_health(hurl, g["http_timeout_s"])
        else:
            for p in cands:                                  # find the new listener
                if not tcp_open(host, p, g["tcp_timeout_s"]):
                    continue
                pp = [x for x in pids_on_port(p, host) if x not in excl]
                if not pp:
                    continue
                active, listening, new_pid = p, True, pp[0]
                hurl = _health_url(svc, p)
                if hurl:
                    hb, code, ms, _ = http_health(hurl, g["http_timeout_s"])
                if svc.get("ws_url") or svc.get("ws_path"):
                    ws_ok = ws_check(_ws_url(svc, p), g["tcp_timeout_s"])
                break
        cpu = cpu_sample(new_pid) if new_pid else 0.0
        rss = proc_info(new_pid)["rss_mb"] if new_pid else 0.0
        cpu_ok = cpu < 99.0
        ram_ok = (svc.get("max_rss_mb", 0) == 0) or (rss <= svc["max_rss_mb"])
        port_ok = (listening is None) or listening
        passed = bool(port_ok and new_pid and hb and
                      (ws_ok is not False) and cpu_ok and ram_ok)
        last = {"passed": passed, "listening": listening, "new_pid": new_pid,
                "port": active, "failed_over": bool(active and active != svc.get("port")),
                "heartbeat": hb, "http_status": code, "latency_ms": ms,
                "ws_ok": ws_ok, "cpu": cpu, "rss_mb": rss,
                "cpu_ok": cpu_ok, "ram_ok": ram_ok, "tries": tries}
        if passed:
            return last
        time.sleep(g["validation_interval_s"])
    return last


# --------------------------------------------------------------------------- #
# Recovery (with cooldown / retry-window / breaker / lock)
# --------------------------------------------------------------------------- #
class _Lock:
    """Best-effort per-service file lock to prevent simultaneous recoveries."""
    def __init__(self, name):
        self.path = os.path.join(LOG_DIR, f".lock-{name}")
        self.ok = False

    def __enter__(self):
        _ensure_dirs()
        try:
            if os.path.exists(self.path):
                age = now() - os.path.getmtime(self.path)
                if age < 180:          # a fresh lock => someone else is healing
                    return self
                os.remove(self.path)   # stale lock
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            self.ok = True
        except FileExistsError:
            self.ok = False
        except Exception:
            self.ok = True  # never block recovery on lock errors
        return self

    def __exit__(self, *a):
        if self.ok:
            try:
                os.remove(self.path)
            except Exception:
                pass


def recover_service(svc, state, cfg, reason="manual", scan=None):
    """Kill -> clear -> restart -> validate one service, with all guards."""
    g = cfg["global"]
    name = svc["name"]
    st = svc_state(state, name)
    t_detected = now()

    base = {"id": f"wd-{int(t_detected)}-{name}", "service": name,
            "port": svc["port"], "reason": reason, "detected_at": iso(t_detected),
            "crashed_pid": (scan or {}).get("owner_pid"),
            "replacement_pid": None, "retry_count": 0,
            "recovery_duration_s": 0, "validation": {}, "escalated": False,
            "breaker_open": st["breaker"]["open"]}

    if not svc.get("recover", True):
        base.update(status="alert_only",
                    note="recover:false (monitored, not auto-restarted)")
        _finalize(base, st, state)
        return base

    # ---- circuit breaker ------------------------------------------------- #
    br = st["breaker"]
    if br["open"]:
        if now() < br["until"]:
            base.update(status="skipped_breaker_open", escalated=True,
                        note=f"breaker open until {iso(br['until'])}: {br['reason']}")
            _finalize(base, st, state)
            return base
        br["open"] = False            # half-open: allow one trial

    # ---- cooldown (anti-duplicate / anti-flap) --------------------------- #
    if st["last_restart_at"] and (now() - st["last_restart_at"]) < svc.get(
            "cooldown_s", g["default_cooldown_s"]):
        base.update(status="skipped_cooldown",
                    note=f"cooled down, last restart {round(now()-st['last_restart_at'])}s ago")
        _finalize(base, st, state)
        return base

    # ---- retry window -> trip breaker on flapping ------------------------ #
    win = g["restart_window_s"]
    st["restart_history"] = [t for t in st["restart_history"] if now() - t < win]
    if len(st["restart_history"]) >= g["max_restarts_per_window"]:
        br.update(open=True, until=now() + g["breaker_cooldown_s"],
                  reason=f"{len(st['restart_history'])} restarts in {win}s")
        base.update(status="escalated_breaker_tripped", escalated=True,
                    note=br["reason"])
        _finalize(base, st, state)
        send_alert(cfg, _alert_text(base, svc), critical=True)
        return base

    # ---- do the recovery under a lock ------------------------------------ #
    with _Lock(name) as lock:
        if not lock.ok:
            base.update(status="skipped_locked",
                        note="another recovery already in progress")
            _finalize(base, st, state)
            return base

        host = svc.get("host", "127.0.0.1")
        if svc.get("port"):
            crashed = sorted({p for cp in _candidate_ports(svc)
                              for p in pids_on_port(cp, host)})
        else:
            crashed = pids_by_match(svc.get("proc_match"))
        base["crashed_pid"] = crashed[0] if crashed else base["crashed_pid"]

        # 1) kill the stuck/old owner(s)
        kill = safe_kill(crashed, svc.get("proc_match"), g["graceful_kill_s"])
        base["killed"] = kill["killed"]
        base["kill_skipped"] = kill["skipped"]

        # 2) pick where to relaunch: primary if it frees, else a standby port
        if svc.get("port"):
            launch_port = _pick_launch_port(svc, g)
            base["launch_port"] = launch_port
            base["port_freed"] = (launch_port == svc["port"])
            base["failed_over"] = launch_port != svc["port"]
        else:
            launch_port = None
            base["port_freed"] = True

        # 3) relaunch (detached) on the chosen port
        launcher_pid, err = launch(svc, port=launch_port)
        base["launcher_pid"] = launcher_pid
        if err:
            base.update(status="failed_launch", note=err, escalated=True)
            st["restart_history"].append(now())
            _finalize(base, st, state)
            send_alert(cfg, _alert_text(base, svc), critical=True)
            return base

        # 4) validate the new instance — check the port we launched on FIRST
        v = validate(svc, cfg, exclude_pids=crashed, prefer_port=launch_port)
        base["validation"] = v
        base["retry_count"] = v.get("tries", 0)
        base["replacement_pid"] = v.get("new_pid")
        base["active_port"] = v.get("port")
        if v.get("failed_over"):
            base["failed_over"] = True

        st["restart_history"].append(now())
        st["last_restart_at"] = now()
        st["restart_count_total"] += 1
        st["pid_history"] = (st["pid_history"] + [
            {"pid": base["crashed_pid"], "role": "crashed", "at": iso(t_detected)},
            {"pid": v.get("new_pid"), "role": "replacement", "at": iso()},
        ])[-20:]

        if v.get("passed"):
            base.update(status="recovered")
        else:
            base.update(status="recovery_validation_failed", escalated=True)

    base["recovered_at"] = iso()
    base["recovery_duration_s"] = round(now() - t_detected, 2)
    _finalize(base, st, state)
    send_alert(cfg, _alert_text(base, svc),
               critical=base.get("escalated", False))
    return base


def _finalize(rec, st, state):
    st["last_incident"] = {"status": rec["status"], "at": rec["detected_at"],
                           "reason": rec["reason"]}
    save_state(state)
    append_incident(rec)


# --------------------------------------------------------------------------- #
# Alerting (Slack/webhook; n8n also alerts independently)
# --------------------------------------------------------------------------- #
def _alert_text(rec, svc):
    icon = {"recovered": "✅", "skipped_cooldown": "⏸️",
            "skipped_breaker_open": "🛑", "escalated_breaker_tripped": "🚨",
            "recovery_validation_failed": "❗", "failed_launch": "❗",
            "alert_only": "👁️"}.get(rec["status"], "⚠️")
    name = svc["name"]
    crashed_port = rec.get("port") or svc.get("port")
    recov_port = rec.get("active_port") or crashed_port
    cpid = rec.get("crashed_pid")
    npid = rec.get("replacement_pid")
    dur = rec.get("recovery_duration_s", 0)
    cp = f" (pid {cpid} down)" if cpid else ""
    st = rec["status"]

    if st == "recovered":
        if rec.get("failed_over") and recov_port and recov_port != crashed_port:
            story = (f"Port {crashed_port} ke lag gaye{cp} aur woh port stuck tha "
                     f"— PORT {recov_port} ne lagne se bacha liya! Service ab :{recov_port} pe "
                     f"live (pid {npid}), {dur}s mein. (failover)")
        else:
            story = (f"Port {crashed_port} ke lag gaye{cp} — usi port :{crashed_port} "
                     f"pe naya process (pid {npid}) chadha ke {dur}s mein bacha liya.")
    elif st == "escalated_breaker_tripped":
        story = (f"Port {crashed_port} baar-baar gir raha — breaker trip ho gaya! "
                 f"Auto-recovery rok diya (loop se bachne ke liye). MANUAL intervention chahiye.")
    elif st == "recovery_validation_failed":
        story = (f"Port {crashed_port} crash hua (pid {cpid}); relaunch (pid {npid}) toh hua "
                 f"par validate nahi hua. Check karo!")
    elif st == "failed_launch":
        story = (f"Port {crashed_port} crash hua (pid {cpid}) par relaunch hi fail ho gaya. "
                 f"MANUAL chahiye!")
    elif st == "skipped_breaker_open":
        story = f"Port {crashed_port} down hai par breaker abhi open — recovery skip kiya."
    elif st == "alert_only":
        story = f"Port {crashed_port} down ({name}) — monitor-only mode, auto-restart nahi."
    else:
        story = f"Port {crashed_port} -> {st} (reason {rec.get('reason')})."

    return f"{icon} [Port Watchdog] {name}: {story}"


def send_alert(cfg, text, critical=False):
    log(("[ALERT*] " if critical else "[ALERT] ") + text)
    # 1) Slack / generic webhook
    url = cfg["global"].get("alert_webhook")
    if url:
        try:
            payload = {"text": ("<!here> " if critical else "") + text}
            req = urllib.request.Request(
                url, data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=5).read()
        except Exception as e:
            log(f"[ALERT] webhook failed: {type(e).__name__}")
    # 2) Email (Office 365 / any SMTP) — on critical, or every alert if on=="all"
    sm = cfg["global"].get("smtp") or {}
    if sm.get("enabled") and (critical or sm.get("on", "critical") == "all"):
        subject = ("CRITICAL — " if critical else "") + \
            text.split("] ", 1)[-1].split(" (", 1)[0].strip()
        send_email(cfg, subject or "service alert", text)


def send_email(cfg, subject, body):
    """Send an alert email (Office 365 / any SMTP). Returns True on success."""
    sm = cfg["global"].get("smtp") or {}
    if not sm.get("enabled"):
        return False
    host = sm.get("host", "smtp.office365.com")
    port = int(sm.get("port", 587))
    to = sm.get("to") or []
    if isinstance(to, str):
        to = [to]
    if not to:
        log("[EMAIL] no recipients configured")
        return False
    try:
        import smtplib
        import ssl
        from email.message import EmailMessage
        msg = EmailMessage()
        msg["Subject"] = f"{sm.get('subject_prefix', '[MES Watchdog]')} {subject}"
        msg["From"] = sm.get("from") or sm.get("user") or "watchdog@localhost"
        msg["To"] = ", ".join(to)
        msg.set_content(body + "\n\n-- MES Port Watchdog (autonomous self-healing)")
        ctx = ssl.create_default_context()
        timeout = sm.get("timeout_s", 12)
        if sm.get("ssl"):                        # implicit TLS (port 465)
            with smtplib.SMTP_SSL(host, port, timeout=timeout, context=ctx) as s:
                if sm.get("user"):
                    s.login(sm["user"], sm.get("password", ""))
                s.send_message(msg)
        else:                                    # STARTTLS (port 587 — Office 365)
            with smtplib.SMTP(host, port, timeout=timeout) as s:
                s.ehlo()
                if sm.get("starttls", True):
                    s.starttls(context=ctx)
                    s.ehlo()
                if sm.get("user"):
                    s.login(sm["user"], sm.get("password", ""))
                s.send_message(msg)
        log(f"[EMAIL] sent '{subject}' -> {to}")
        return True
    except Exception as e:
        log(f"[EMAIL] failed: {type(e).__name__}: {e}")
        return False


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
def _services(cfg, only=None):
    out = []
    for s in cfg["services"]:
        if not s.get("enabled", True):
            continue
        if only and s["name"] != only:
            continue
        out.append(s)
    return out


def cmd_scan(cfg, only=None, write_status=True):
    state = load_state()
    results = [scan_service(s, state, cfg) for s in _services(cfg, only)]
    save_state(state)
    unhealthy = [r for r in results if not r["healthy"]]
    at_risk = [r for r in results if r.get("prediction", {}).get("high")]
    snap = {"checked_at": iso(), "total": len(results),
            "healthy": len(results) - len(unhealthy),
            "unhealthy": [r["name"] for r in unhealthy],
            "at_risk": [r["name"] for r in at_risk], "services": results}
    if write_status:
        save_json(STATUS_FILE, snap)
    return snap


def cmd_recover(cfg, name, reason="manual"):
    state = load_state()
    svc = next((s for s in _services(cfg) if s["name"] == name), None)
    if not svc:
        return {"ok": False, "error": "unknown_service", "service": name}
    scan = scan_service(svc, state, cfg)
    save_state(state)
    rec = recover_service(svc, state, cfg, reason=reason, scan=scan)
    rec["ok"] = rec["status"] in ("recovered", "alert_only")
    return rec


def cmd_recover_all(cfg):
    snap = cmd_scan(cfg)
    state = load_state()
    actions = []
    for r in snap["services"]:
        svc = next((s for s in _services(cfg) if s["name"] == r["name"]), None)
        if not svc:
            continue
        recoverable = svc.get("recover", True)
        if not r["healthy"] and recoverable:
            actions.append(recover_service(svc, state, cfg, reason=r["reason"], scan=r))
        elif not r["healthy"] and not recoverable:
            # monitor-only service DOWN -> alert ONCE per down-episode (no auto-restart)
            st = svc_state(state, r["name"])
            if not st.get("alerted_down"):
                st["alerted_down"] = True
                save_state(state)
                rec = {"id": f"wd-{int(now())}-{r['name']}", "service": r["name"],
                       "port": r["port"], "active_port": r["port"], "reason": r["reason"],
                       "status": "alert_only", "crashed_pid": r.get("owner_pid"),
                       "replacement_pid": None, "detected_at": iso(),
                       "recovery_duration_s": 0, "retry_count": 0}
                append_incident(rec)
                send_alert(cfg, _alert_text(rec, svc), critical=True)
                actions.append(rec)
        elif r["healthy"] and not recoverable:
            st = svc_state(state, r["name"])
            if st.get("alerted_down"):              # came back up -> re-arm the alert
                st["alerted_down"] = False
                save_state(state)
        elif r.get("prediction", {}).get("high") and svc.get("predictive_restart"):
            actions.append(recover_service(svc, state, cfg, reason="predictive_crash", scan=r))
    return {"checked_at": iso(), "scanned": snap["total"],
            "recovered": [a for a in actions if a.get("status") == "recovered"],
            "actions": actions}


def cmd_validate(cfg, name):
    svc = next((s for s in _services(cfg) if s["name"] == name), None)
    if not svc:
        return {"ok": False, "error": "unknown_service"}
    v = validate(svc, cfg, exclude_pids=[])
    v["ok"] = v.get("passed", False)
    v["service"] = name
    return v


def cmd_status(cfg):
    snap = load_json(STATUS_FILE, None)
    if snap is None:
        snap = cmd_scan(cfg)
    return snap


def cmd_predict(cfg):
    snap = cmd_scan(cfg)
    return {"checked_at": snap["checked_at"], "at_risk": snap["at_risk"],
            "predictions": [{"name": r["name"], **r["prediction"]}
                            for r in snap["services"] if r.get("prediction")]}


def cmd_reset(cfg, name):
    state = load_state()
    st = svc_state(state, name)
    st["breaker"] = {"open": False, "until": 0, "reason": ""}
    st["restart_history"] = []
    st["last_restart_at"] = 0
    save_state(state)
    return {"ok": True, "service": name, "note": "breaker + cooldown cleared"}


def cmd_test_email(cfg):
    sm = cfg["global"].get("smtp") or {}
    if not sm.get("enabled"):
        return {"ok": False, "error": "smtp.enabled is false",
                "fix": "set smtp.enabled=true + smtp.password (O365 app password) in the config"}
    ok = send_email(cfg, "test alert",
                    "If you can read this, the MES Port Watchdog SMTP email alerts work. "
                    "Crashes, recoveries and escalations will land here. ✅")
    return {"ok": ok, "sent_to": sm.get("to"), "via": f"{sm.get('host')}:{sm.get('port')}",
            "note": "check inbox (and spam)" if ok else "see stderr for the SMTP error"}


def cmd_daemon(cfg):
    g = cfg["global"]
    log(f"[watchdog] daemon up :: {len(_services(cfg))} services :: "
        f"poll {g['poll_interval_s']}s :: pid {os.getpid()}")
    while True:
        try:
            res = cmd_recover_all(cfg)
            snap = load_json(STATUS_FILE, {})
            hb = (f"[{datetime.now().strftime('%H:%M:%S')}] "
                  f"healthy={snap.get('healthy')}/{snap.get('total')} "
                  f"unhealthy={snap.get('unhealthy')} at_risk={snap.get('at_risk')}")
            if res["actions"]:
                hb += f" :: actions={[ (a['service'], a['status']) for a in res['actions'] ]}"
            log(hb)
        except KeyboardInterrupt:
            log("[watchdog] stopped")
            return
        except Exception as e:
            log(f"[watchdog] loop error: {type(e).__name__}: {e}")
        time.sleep(g["poll_interval_s"])


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def main():
    global JSON_MODE
    ap = argparse.ArgumentParser(description="Autonomous Port Watchdog")
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--scan", action="store_true")
    ap.add_argument("--recover", metavar="SERVICE")
    ap.add_argument("--recover-all", action="store_true")
    ap.add_argument("--validate", metavar="SERVICE")
    ap.add_argument("--predict", action="store_true")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--reset", metavar="SERVICE")
    ap.add_argument("--test-email", action="store_true")
    ap.add_argument("--daemon", action="store_true")
    ap.add_argument("--service", help="limit --scan to one service")
    ap.add_argument("--reason", default="manual")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    JSON_MODE = args.json

    if psutil is None:
        log("[watchdog] WARNING: psutil not installed -> falling back to "
            "netstat/taskkill. `pip install psutil` for full features.")

    cfg = load_config(args.config)
    _ensure_dirs()

    if args.daemon:
        cmd_daemon(cfg)
        return

    if args.scan:
        res = cmd_scan(cfg, only=args.service)
    elif args.recover:
        res = cmd_recover(cfg, args.recover, reason=args.reason)
    elif args.recover_all:
        res = cmd_recover_all(cfg)
    elif args.validate:
        res = cmd_validate(cfg, args.validate)
    elif args.predict:
        res = cmd_predict(cfg)
    elif args.status:
        res = cmd_status(cfg)
    elif args.reset:
        res = cmd_reset(cfg, args.reset)
    elif args.test_email:
        res = cmd_test_email(cfg)
    else:
        ap.print_help()
        return

    if JSON_MODE:
        emit(res)
    else:
        _print_human(res)

    # exit code: 2 if anything unhealthy/failed (so n8n IF can branch on it)
    bad = False
    if isinstance(res, dict):
        if res.get("unhealthy"):
            bad = True
        if res.get("status") and res["status"] not in (
                "recovered", "alert_only", "healthy"):
            bad = True
        if res.get("ok") is False:
            bad = True
    sys.exit(2 if bad else 0)


def _print_human(res):
    if "services" in res:   # scan/status snapshot
        print(f"\n  PORT WATCHDOG :: {res['checked_at']}")
        print(f"  healthy {res['healthy']}/{res['total']}   "
              f"unhealthy={res['unhealthy']}   at_risk={res['at_risk']}")
        print("  " + "-" * 78)
        for r in res["services"]:
            flag = "OK " if r["healthy"] else "DOWN"
            if r.get("degraded"):
                flag = "SLOW"
            pr = r.get("prediction", {})
            risk = f"  risk={pr.get('crash_probability')}" if pr.get("crash_probability") else ""
            print(f"   [{flag}] {r['name']:<18} :{r['port']:<6} "
                  f"pid={r['owner_pid']}  hb={r['heartbeat']} "
                  f"{r['latency_ms']}ms  reason={r['reason']}{risk}")
            if pr.get("signals"):
                print(f"           predictive: {pr['signals']}")
        print()
    else:
        print(json.dumps(res, indent=2, default=str, ensure_ascii=False))


if __name__ == "__main__":
    main()
