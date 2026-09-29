#!/usr/bin/env python3
"""Office server for Pharmacy Ledger (Linux desktop).

Serves the app and keeps a master copy of every record so phones, tablets and
PCs on the same network work as ONE system. Only the Python 3 standard
library is needed.

    python3 server.py                      # http://localhost:8765, reachable on the LAN
    python3 server.py --key MySecret       # devices must enter the same sync key
    python3 server.py --port 9000 --data ~/pharmacy-data

Each device still keeps its own offline copy and keeps working if the
server is off; it catches up on the next sync.
"""
import argparse
import json
import os
import socket
import sqlite3
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
COLLECTIONS = ("items", "suppliers", "batches", "receipts", "txns", "dispenses")
PUBLIC = ("/", "/index.html", "/manifest.webmanifest", "/sw.js")
PUBLIC_DIRS = ("/js/", "/css/", "/icons/")
MAX_BODY = 64 * 1024 * 1024


class Store:
    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS records (
                   coll TEXT NOT NULL, id TEXT NOT NULL, updated_at TEXT NOT NULL,
                   seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (coll, id))"""
        )
        self.db.execute("CREATE INDEX IF NOT EXISTS records_seq ON records(seq)")
        self.db.commit()

    def sync(self, incoming, since):
        """Store newer records (last updatedAt wins) and return everything past `since`."""
        with self.lock, self.db:
            seq = self.db.execute("SELECT COALESCE(MAX(seq), 0) FROM records").fetchone()[0]
            for coll in COLLECTIONS:
                for rec in incoming.get(coll) or []:
                    if not isinstance(rec, dict) or not isinstance(rec.get("id"), str):
                        continue
                    upd = str(rec.get("updatedAt") or "")
                    row = self.db.execute(
                        "SELECT updated_at FROM records WHERE coll=? AND id=?", (coll, rec["id"])
                    ).fetchone()
                    if row and row[0] >= upd:
                        continue
                    seq += 1
                    self.db.execute(
                        "INSERT OR REPLACE INTO records (coll, id, updated_at, seq, data) VALUES (?,?,?,?,?)",
                        (coll, rec["id"], upd, seq, json.dumps(rec, separators=(",", ":"))),
                    )
            out = {c: [] for c in COLLECTIONS}
            for coll, data in self.db.execute(
                "SELECT coll, data FROM records WHERE seq > ? ORDER BY seq", (since,)
            ):
                out[coll].append(json.loads(data))
            return seq, out

    def counts(self):
        with self.lock:
            return dict(self.db.execute("SELECT coll, COUNT(*) FROM records GROUP BY coll").fetchall())


def make_handler(store, key):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(APP_DIR), **kw)

        def log_message(self, fmt, *args):
            if "/api/" in self.path and not self.path.startswith("/api/ping"):
                super().log_message(fmt, *args)

        def send_json(self, obj, status=HTTPStatus.OK):
            body = json.dumps(obj, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def authorised(self):
            return not key or self.headers.get("X-Sync-Key", "") == key

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/api/ping":
                return self.send_json({"app": "pharmacy-ledger", "keyRequired": bool(key), "authorised": self.authorised()})
            if path == "/api/status":
                if not self.authorised():
                    return self.send_json({"error": "Wrong sync key"}, HTTPStatus.FORBIDDEN)
                return self.send_json({"records": store.counts(), "database": str(store.path)})
            # Serve only the app's own files – never the database or anything else on disk.
            if path in PUBLIC or path.startswith(PUBLIC_DIRS):
                return super().do_GET()
            self.send_error(HTTPStatus.NOT_FOUND)

        def do_HEAD(self):
            self.do_GET()

        def do_POST(self):
            if self.path.split("?", 1)[0] != "/api/sync":
                return self.send_error(HTTPStatus.NOT_FOUND)
            if not self.authorised():
                return self.send_json({"error": "Wrong sync key"}, HTTPStatus.FORBIDDEN)
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                return self.send_json({"error": "Bad request size"}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            try:
                body = json.loads(self.rfile.read(length))
                since = int(body.get("since") or 0)
                seq, records = store.sync(body.get("records") or {}, since)
            except (ValueError, TypeError, AttributeError) as e:
                return self.send_json({"error": f"Bad sync request: {e}"}, HTTPStatus.BAD_REQUEST)
            self.send_json({"seq": seq, "records": records})

    return Handler


def lan_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    default_data = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "pharmacy-ledger"
    p = argparse.ArgumentParser(description="Pharmacy Ledger office server")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--host", default="0.0.0.0", help="0.0.0.0 = reachable from other devices; 127.0.0.1 = this PC only")
    p.add_argument("--data", type=Path, default=default_data, help=f"folder for the database (default {default_data})")
    p.add_argument("--key", default=os.environ.get("PHARMACY_SYNC_KEY", ""), help="shared sync key devices must enter")
    a = p.parse_args()

    store = Store(a.data.expanduser() / "server.db")
    httpd = ThreadingHTTPServer((a.host, a.port), make_handler(store, a.key))
    print(f"Pharmacy Ledger server – database: {store.path}")
    print(f"  On this PC:      http://localhost:{a.port}")
    ip = lan_address()
    if ip and a.host != "127.0.0.1":
        print(f"  Other devices:   http://{ip}:{a.port}  (same Wi-Fi/LAN)")
    print("  Sync key:        " + ("required" if a.key else "none (anyone on the network can sync – consider --key)"))
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
