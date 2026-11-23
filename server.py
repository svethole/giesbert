#!/usr/bin/env python3
"""Giesbert – kleines Backend ohne Zusatzpakete.

Liefert die Weboberfläche aus ./public aus und stellt eine JSON-Schnittstelle
unter /api/ bereit. Pflanzen und Bilder liegen in einer SQLite-Datei.

Aufruf:
    python3 server.py                                  # startet auf 127.0.0.1:8097
    python3 server.py --port 9000 --db /pfad/zu/giesbert.db

Der Server lauscht absichtlich nur auf 127.0.0.1. Zugriffsschutz (Passwort)
und HTTPS übernimmt nginx davor.
"""

import argparse
import html
import json
import mimetypes
import os
import re
import sqlite3
import threading
import urllib.parse
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).resolve().parent
PUBLIC = BASE / "public"
DB_PATH = BASE / "data" / "giesbert.db"
WRITE_LOCK = threading.Lock()
MAX_JSON = 2 * 1024 * 1024        # 2 MB für JSON-Anfragen (Import)
MAX_IMAGE = 8 * 1024 * 1024       # 8 MB pro Bild
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
# Wikimedia bittet darum, dass sich Programme mit einem eigenen User-Agent ausweisen.
USER_AGENT = os.environ.get(
    "GIESBERT_USER_AGENT",
    "Giesbert/1.0 (selbst gehostete Giess-Erinnerung; python-urllib)",
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS plants (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    latin           TEXT NOT NULL DEFAULT '',
    family          TEXT NOT NULL DEFAULT '',
    nickname        TEXT NOT NULL DEFAULT '',
    hint            TEXT NOT NULL DEFAULT '',
    water_summer    INTEGER NOT NULL,            -- Gießabstand Sommer (Tage)
    water_winter    INTEGER NOT NULL,            -- Gießabstand Winter (Tage)
    fertilize_days  INTEGER NOT NULL DEFAULT 0,  -- Düngeabstand (Tage), 0 = nie
    auto            INTEGER NOT NULL DEFAULT 1,  -- Intervall folgt der Jahreszeit
    factor          REAL    NOT NULL DEFAULT 1,  -- eigene Anpassung (bei auto)
    custom          INTEGER,                     -- fester Abstand (ohne auto)
    last_watered    TEXT,                        -- JJJJ-MM-TT
    snooze_until    TEXT,
    last_fertilized TEXT,
    fert_hint       INTEGER NOT NULL DEFAULT 1,
    added           TEXT NOT NULL,
    deleted_at      TEXT,                        -- Papierkorb (für „Rückgängig“)
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS images (
    plant_id   TEXT PRIMARY KEY REFERENCES plants(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('auto', 'own')),
    mime       TEXT NOT NULL,
    data       BLOB NOT NULL,
    credit     TEXT NOT NULL DEFAULT '{}',       -- JSON: Urheber, Lizenz, Quelle
    version    INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS waterings (
    id       INTEGER PRIMARY KEY,
    plant_id TEXT NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    date     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_waterings_plant ON waterings(plant_id, date);
"""

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ID_RE = re.compile(r"^[a-z0-9]{6,40}$")


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------- Datenbank ----------

def connect():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    return con


@contextmanager
def db(write=False):
    con = connect()
    try:
        if write:
            with WRITE_LOCK:
                yield con
                con.commit()
        else:
            yield con
    finally:
        con.close()


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db(write=True) as con:
        con.executescript(SCHEMA)
        # Papierkorb nach 30 Tagen endgültig leeren
        cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S")
        con.execute("DELETE FROM plants WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,))


def plant_to_json(row, image_row=None):
    image = None
    if image_row is not None:
        image = {"kind": image_row["kind"], "v": image_row["version"], "credit": json.loads(image_row["credit"] or "{}")}
    return {
        "id": row["id"], "name": row["name"], "latin": row["latin"], "family": row["family"],
        "nickname": row["nickname"], "hint": row["hint"],
        "base": {"s": row["water_summer"], "w": row["water_winter"], "f": row["fertilize_days"]},
        "auto": bool(row["auto"]), "factor": row["factor"], "custom": row["custom"],
        "lastWatered": row["last_watered"], "snoozeUntil": row["snooze_until"],
        "lastFertilized": row["last_fertilized"], "fertHint": bool(row["fert_hint"]),
        "added": row["added"], "image": image,
    }


def list_plants(con):
    images = {r["plant_id"]: r for r in con.execute("SELECT plant_id, kind, version, credit FROM images")}
    rows = con.execute("SELECT * FROM plants WHERE deleted_at IS NULL ORDER BY added, rowid")
    return [plant_to_json(r, images.get(r["id"])) for r in rows]


def get_plant(con, pid, include_deleted=False):
    row = con.execute("SELECT * FROM plants WHERE id = ?", (pid,)).fetchone()
    if row is None or (row["deleted_at"] and not include_deleted):
        raise ApiError(HTTPStatus.NOT_FOUND, "Pflanze nicht gefunden")
    img = con.execute("SELECT plant_id, kind, version, credit FROM images WHERE plant_id = ?", (pid,)).fetchone()
    return plant_to_json(row, img)


# ---------- Prüfung der Eingaben ----------

def v_text(value, field, maxlen=120, required=False):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field}: Text erwartet")
    value = value.strip()
    if required and not value:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} fehlt")
    if len(value) > maxlen:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} ist zu lang")
    return value


def v_date(value, field, allow_none=True):
    if value in (None, ""):
        if allow_none:
            return None
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} fehlt")
    if not isinstance(value, str) or not DATE_RE.match(value):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field}: Datum im Format JJJJ-MM-TT erwartet")
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field}: ungültiges Datum")
    return value


def v_int(value, field, lo, hi, allow_none=False):
    if value is None and allow_none:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field}: ganze Zahl erwartet")
    value = int(value)
    if not lo <= value <= hi:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field}: Wert außerhalb von {lo}–{hi}")
    return value


def v_plant(data):
    if not isinstance(data, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Pflanze: Objekt erwartet")
    pid = data.get("id")
    if not isinstance(pid, str) or not ID_RE.match(pid):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Ungültige Pflanzen-ID")
    base = data.get("base") or {}
    factor = data.get("factor", 1)
    if isinstance(factor, bool) or not isinstance(factor, (int, float)) or not 0.05 <= factor <= 50:
        raise ApiError(HTTPStatus.BAD_REQUEST, "factor: Zahl zwischen 0,05 und 50 erwartet")
    return {
        "id": pid,
        "name": v_text(data.get("name"), "Name", required=True),
        "latin": v_text(data.get("latin"), "Lateinischer Name"),
        "family": v_text(data.get("family"), "Familie"),
        "nickname": v_text(data.get("nickname"), "Spitzname", 60),
        "hint": v_text(data.get("hint"), "Tipp", 300),
        "water_summer": v_int(base.get("s"), "Gießabstand Sommer", 1, 365),
        "water_winter": v_int(base.get("w"), "Gießabstand Winter", 1, 365),
        "fertilize_days": v_int(base.get("f", 0), "Düngeabstand", 0, 365),
        "auto": 1 if data.get("auto", True) else 0,
        "factor": float(factor),
        "custom": v_int(data.get("custom"), "Fester Gießabstand", 1, 365, allow_none=True),
        "last_watered": v_date(data.get("lastWatered"), "Zuletzt gegossen"),
        "snooze_until": v_date(data.get("snoozeUntil"), "Erinnern ab"),
        "last_fertilized": v_date(data.get("lastFertilized"), "Zuletzt gedüngt"),
        "fert_hint": 1 if data.get("fertHint", True) else 0,
        "added": v_date(data.get("added"), "Hinzugefügt", allow_none=False),
    }


COLUMNS = ["name", "latin", "family", "nickname", "hint", "water_summer", "water_winter",
           "fertilize_days", "auto", "factor", "custom", "last_watered", "snooze_until",
           "last_fertilized", "fert_hint", "added"]


def upsert_plant(con, p):
    old = con.execute("SELECT last_watered FROM plants WHERE id = ?", (p["id"],)).fetchone()
    cols = ", ".join(["id"] + COLUMNS)
    marks = ", ".join("?" for _ in range(len(COLUMNS) + 1))
    updates = ", ".join(f"{c} = excluded.{c}" for c in COLUMNS)
    con.execute(
        f"INSERT INTO plants ({cols}) VALUES ({marks}) "
        f"ON CONFLICT(id) DO UPDATE SET {updates}, deleted_at = NULL, updated_at = datetime('now')",
        [p["id"]] + [p[c] for c in COLUMNS],
    )
    # Gieß-Verlauf mitschreiben (nur neue Daten)
    if p["last_watered"] and (old is None or old["last_watered"] != p["last_watered"]):
        exists = con.execute("SELECT 1 FROM waterings WHERE plant_id = ? AND date = ?",
                             (p["id"], p["last_watered"])).fetchone()
        if not exists:
            con.execute("INSERT INTO waterings (plant_id, date) VALUES (?, ?)", (p["id"], p["last_watered"]))


# ---------- Bilder ----------

def save_image(con, pid, kind, mime, data, credit):
    con.execute(
        "INSERT INTO images (plant_id, kind, mime, data, credit, version) VALUES (?, ?, ?, ?, ?, 1) "
        "ON CONFLICT(plant_id) DO UPDATE SET kind = excluded.kind, mime = excluded.mime, data = excluded.data, "
        "credit = excluded.credit, version = images.version + 1",
        (pid, kind, mime, sqlite3.Binary(data), json.dumps(credit, ensure_ascii=False)),
    )


def sniff_image(data):
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def http_get(url, limit=MAX_IMAGE):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=15) as res:
        data = res.read(limit + 1)
        if len(data) > limit:
            raise ApiError(HTTPStatus.BAD_GATEWAY, "Bild ist zu groß")
        return data


def wiki_api(host, **params):
    params.update(format="json", formatversion="2")
    url = f"https://{host}/w/api.php?" + urllib.parse.urlencode(params)
    return json.loads(http_get(url, 2 * 1024 * 1024).decode("utf-8"))


def strip_html(text):
    return html.unescape(re.sub(r"<[^>]+>", "", text or "")).strip()


def page_image(host, title):
    """Dateiname des Hauptbilds eines Wikipedia-Artikels (oder None)."""
    data = wiki_api(host, action="query", prop="pageimages", piprop="name", redirects="1", titles=title)
    for page in data.get("query", {}).get("pages", []):
        if page.get("pageimage"):
            return page["pageimage"]
    return None


def commons_search(term):
    data = wiki_api("commons.wikimedia.org", action="query", list="search", srnamespace="6",
                    srsearch=f"filetype:bitmap {term}", srlimit="5")
    for hit in data.get("query", {}).get("search", []):
        title = hit.get("title", "")
        if re.search(r"\.(jpe?g|png|webp)$", title, re.I) and not re.search(r"map|karte|distribution|range", title, re.I):
            return title.split(":", 1)[1]
    return None


def image_info(host, filename):
    data = wiki_api(host, action="query", prop="imageinfo", iiprop="url|extmetadata|mime",
                    iiurlwidth="800", titles=f"File:{filename}")
    for page in data.get("query", {}).get("pages", []):
        for info in page.get("imageinfo", []):
            meta = info.get("extmetadata", {})
            return {
                "url": info.get("thumburl") or info.get("url"),
                "page": info.get("descriptionurl", ""),
                "artist": strip_html(meta.get("Artist", {}).get("value", ""))[:200],
                "license": strip_html(meta.get("LicenseShortName", {}).get("value", ""))[:80],
            }
    return None


def find_wiki_image(latin, names):
    """Sucht ein passendes Foto: erst Wikipedia-Artikel (lateinisch, dann deutsch), sonst Commons-Suche."""
    attempts = []
    if latin:
        attempts += [("de.wikipedia.org", latin), ("en.wikipedia.org", latin)]
    attempts += [("de.wikipedia.org", n) for n in names if n]
    for host, title in attempts:
        try:
            filename = page_image(host, title)
        except Exception:
            continue
        if filename and re.search(r"\.(jpe?g|png|webp)$", filename, re.I):
            info = image_info(host, filename)
            if info and info["url"]:
                return info
    term = latin or (names[0] if names else "")
    if term:
        filename = commons_search(term)
        if filename:
            return image_info("commons.wikimedia.org", filename)
    return None


def fetch_auto_image(con, pid):
    plant = get_plant(con, pid)
    if plant["image"] and plant["image"]["kind"] == "own":
        raise ApiError(HTTPStatus.CONFLICT, "Die Pflanze hat schon ein eigenes Foto")
    try:
        info = find_wiki_image(plant["latin"], [plant["name"]])
    except ApiError:
        raise
    except Exception:
        raise ApiError(HTTPStatus.BAD_GATEWAY, "Wikipedia ist gerade nicht erreichbar")
    if not info:
        raise ApiError(HTTPStatus.NOT_FOUND, "Kein passendes Bild gefunden")
    try:
        data = http_get(info["url"])
    except ApiError:
        raise
    except Exception:
        raise ApiError(HTTPStatus.BAD_GATEWAY, "Bild konnte nicht geladen werden")
    mime = sniff_image(data)
    if not mime:
        raise ApiError(HTTPStatus.BAD_GATEWAY, "Unbekanntes Bildformat")
    credit = {"source": "Wikimedia Commons", "artist": info["artist"], "license": info["license"], "page": info["page"]}
    return mime, data, credit


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    server_version = "Giesbert/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("GIESBERT_DEBUG"):
            super().log_message(fmt, *args)

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, limit):
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Anfrage ist zu groß")
        return self.rfile.read(length) if length else b""

    def read_json(self):
        raw = self.read_body(MAX_JSON)
        try:
            return json.loads(raw.decode("utf-8") or "null")
        except (ValueError, UnicodeDecodeError):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Ungültiges JSON")

    def handle_api(self, method):
        path = urllib.parse.urlparse(self.path).path
        parts = [p for p in path.split("/") if p][1:]  # ohne "api"
        try:
            result = self.route(method, parts)
            if result is not None:
                self.send_json(HTTPStatus.OK, result)
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except Exception as e:  # pragma: no cover
            self.log_error("Fehler: %r", e)
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Interner Fehler"})

    def route(self, method, parts):
        if parts == ["plants"] and method == "GET":
            with db() as con:
                return {"plants": list_plants(con)}
        if parts == ["plants"] and method == "POST":
            p = v_plant(self.read_json())
            with db(write=True) as con:
                upsert_plant(con, p)
                return get_plant(con, p["id"])
        if parts == ["export"] and method == "GET":
            with db() as con:
                return {"version": 2, "exported": datetime.now().isoformat(timespec="seconds"), "plants": list_plants(con)}
        if parts == ["import"] and method == "POST":
            data = self.read_json()
            if not isinstance(data, dict) or not isinstance(data.get("plants"), list):
                raise ApiError(HTTPStatus.BAD_REQUEST, "Unbekanntes Dateiformat")
            plants = [v_plant(p) for p in data["plants"]]
            with db(write=True) as con:
                for p in plants:
                    upsert_plant(con, p)
                return {"plants": list_plants(con), "imported": len(plants)}
        if len(parts) >= 2 and parts[0] == "plants":
            pid = parts[1]
            if not ID_RE.match(pid):
                raise ApiError(HTTPStatus.NOT_FOUND, "Pflanze nicht gefunden")
            rest = parts[2:]
            if not rest:
                if method == "PUT":
                    data = self.read_json()
                    if isinstance(data, dict):
                        data["id"] = pid
                    p = v_plant(data)
                    with db(write=True) as con:
                        upsert_plant(con, p)
                        return get_plant(con, pid)
                if method == "DELETE":
                    with db(write=True) as con:
                        get_plant(con, pid)
                        con.execute("UPDATE plants SET deleted_at = datetime('now') WHERE id = ?", (pid,))
                    return {"ok": True}
            if rest == ["restore"] and method == "POST":
                with db(write=True) as con:
                    get_plant(con, pid, include_deleted=True)
                    con.execute("UPDATE plants SET deleted_at = NULL WHERE id = ?", (pid,))
                    return get_plant(con, pid)
            if rest == ["image"]:
                return self.route_image(method, pid)
            if rest == ["image", "auto"] and method == "POST":
                with db() as con:
                    mime, data, credit = fetch_auto_image(con, pid)
                with db(write=True) as con:
                    save_image(con, pid, "auto", mime, data, credit)
                    return get_plant(con, pid)
            if rest == ["waterings"] and method == "GET":
                with db() as con:
                    get_plant(con, pid)
                    rows = con.execute("SELECT date FROM waterings WHERE plant_id = ? ORDER BY date DESC LIMIT 100", (pid,))
                    return {"dates": [r["date"] for r in rows]}
        raise ApiError(HTTPStatus.NOT_FOUND, "Unbekannte Adresse")

    def route_image(self, method, pid):
        if method == "GET":
            with db() as con:
                row = con.execute("SELECT mime, data, version FROM images WHERE plant_id = ?", (pid,)).fetchone()
            if row is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Kein Bild")
            data = bytes(row["data"])
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", row["mime"])
            self.send_header("Content-Length", str(len(data)))
            # Die URL enthält ?v=<Version>, darum darf der Browser lange zwischenspeichern
            self.send_header("Cache-Control", "private, max-age=31536000, immutable")
            self.end_headers()
            self.wfile.write(data)
            return None
        if method == "PUT":
            data = self.read_body(MAX_IMAGE)
            mime = sniff_image(data)
            if not data or mime not in IMAGE_TYPES:
                raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Bitte ein JPEG-, PNG- oder WebP-Bild hochladen")
            with db(write=True) as con:
                get_plant(con, pid)
                save_image(con, pid, "own", mime, data, {"source": "Eigenes Foto"})
                return get_plant(con, pid)
        if method == "DELETE":
            with db(write=True) as con:
                get_plant(con, pid)
                con.execute("DELETE FROM images WHERE plant_id = ?", (pid,))
                return get_plant(con, pid)
        raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "Nicht erlaubt")

    def serve_static(self):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if path.endswith("/"):
            path += "index.html"
        target = (PUBLIC / path.lstrip("/")).resolve()
        if PUBLIC not in target.parents or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data = target.read_bytes()
        ctype = "application/manifest+json" if target.suffix == ".webmanifest" else (mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/"):
            self.handle_api("GET")
        else:
            self.serve_static()

    def do_POST(self):
        self.handle_api("POST")

    def do_PUT(self):
        self.handle_api("PUT")

    def do_DELETE(self):
        self.handle_api("DELETE")


def main():
    global DB_PATH
    ap = argparse.ArgumentParser(description="Giesbert – Backend")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8097)
    ap.add_argument("--db", default=str(DB_PATH), help="Pfad zur SQLite-Datei")
    args = ap.parse_args()
    DB_PATH = Path(args.db)
    init_db()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Giesbert läuft auf http://{args.host}:{args.port} (Datenbank: {DB_PATH})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
