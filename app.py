from __future__ import annotations

import os
import sqlite3
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request


BASE_DIR = Path(__file__).resolve().parent
DATABASE = Path(os.environ.get("MEDIAVAULT_DATABASE", BASE_DIR / "data" / "mediavault.db"))

app = Flask(__name__)

MEDIA_TYPES = ("Movies", "Television", "Music", "Games", "Books", "Other")
FORMATS = (
    "DVD", "Blu-ray", "4K", "CD", "Vinyl", "Cassette",
    "Game Disc", "Cartridge", "Digital", "Other",
)
STATUSES = ("Owned", "In Collection", "Wishlist", "Upgrade Candidate")
CONDITIONS = ("New", "Like New", "Good", "Fair", "Poor", "Unknown")


def db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_error=None):
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()


def init_db() -> None:
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            year INTEGER,
            media_type TEXT NOT NULL,
            format TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'In Collection',
            upc TEXT,
            condition TEXT,
            purchase_price REAL,
            purchase_date TEXT,
            purchase_location TEXT,
            physical_location TEXT,
            notes TEXT,
            tags TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    connection.execute("CREATE INDEX IF NOT EXISTS idx_media_title ON media(title)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_media_upc ON media(upc)")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS jellyfin_sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            jellyfin_item_id TEXT NOT NULL,
            jellyfin_library_id TEXT,
            jellyfin_library_name TEXT,
            server_url TEXT NOT NULL,
            media_id INTEGER,
            source_title TEXT NOT NULL,
            source_year INTEGER,
            action TEXT NOT NULL CHECK(action IN ('attached', 'created', 'ignored')),
            metadata_json TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(server_url, jellyfin_item_id),
            FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE RESTRICT
        )
        """
    )
    connection.commit()
    connection.close()


def row_to_dict(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["tags"] = [tag.strip() for tag in (item.get("tags") or "").split(",") if tag.strip()]
    return item


def clean_payload(payload: dict) -> dict:
    title = str(payload.get("title", "")).strip()
    if not title:
        raise ValueError("Title is required.")

    media_type = str(payload.get("media_type", "Other"))
    item_format = str(payload.get("format", "Other"))
    status = str(payload.get("status", "In Collection"))
    condition = str(payload.get("condition", "Unknown"))
    if media_type not in MEDIA_TYPES:
        raise ValueError("Invalid media type.")
    if item_format not in FORMATS:
        raise ValueError("Invalid format.")
    if status not in STATUSES:
        raise ValueError("Invalid collection status.")
    if condition not in CONDITIONS:
        raise ValueError("Invalid condition.")

    year = payload.get("year")
    if year not in (None, ""):
        year = int(year)
        if year < 1000 or year > datetime.now().year + 5:
            raise ValueError("Enter a valid year.")
    else:
        year = None

    price = payload.get("purchase_price")
    price = float(price) if price not in (None, "") else None
    if price is not None and price < 0:
        raise ValueError("Purchase price cannot be negative.")

    tags = payload.get("tags", "")
    if isinstance(tags, list):
        tags = ", ".join(str(tag).strip() for tag in tags if str(tag).strip())

    return {
        "title": title,
        "year": year,
        "media_type": media_type,
        "format": item_format,
        "status": status,
        "upc": str(payload.get("upc", "")).strip(),
        "condition": condition,
        "purchase_price": price,
        "purchase_date": str(payload.get("purchase_date", "")).strip(),
        "purchase_location": str(payload.get("purchase_location", "")).strip(),
        "physical_location": str(payload.get("physical_location", "")).strip(),
        "notes": str(payload.get("notes", "")).strip(),
        "tags": str(tags).strip(),
    }


def jellyfin_settings() -> dict:
    rows = db().execute(
        "SELECT key, value FROM app_settings WHERE key LIKE 'jellyfin_%'"
    ).fetchall()
    values = {row["key"]: row["value"] for row in rows}
    return {
        "server_url": values.get("jellyfin_server_url", ""),
        "api_key": values.get("jellyfin_api_key", ""),
        "server_name": values.get("jellyfin_server_name", ""),
    }


def normalize_server_url(value: str) -> str:
    url = value.strip().rstrip("/")
    if not url:
        raise ValueError("Server URL is required.")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Enter a valid Jellyfin server URL including http:// or https://.")
    return url


def jellyfin_request(settings: dict, path: str, query: dict | None = None) -> dict:
    server_url = normalize_server_url(settings.get("server_url", ""))
    api_key = str(settings.get("api_key", "")).strip()
    if not api_key:
        raise ValueError("API Key is required.")
    url = f"{server_url}{path}"
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    req = urllib.request.Request(
        url,
        headers={
            "X-Emby-Token": api_key,
            "Accept": "application/json",
            "User-Agent": "MediaVault/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise ValueError("Jellyfin rejected the API key.") from exc
        raise ValueError(f"Jellyfin returned HTTP {exc.code}.") from exc
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        raise ValueError(f"Could not reach Jellyfin: {reason}") from exc
    except (TimeoutError, json.JSONDecodeError) as exc:
        raise ValueError("Jellyfin did not return a valid response.") from exc


def jellyfin_connection(settings: dict) -> dict:
    info = jellyfin_request(settings, "/System/Info")
    views = jellyfin_request(settings, "/Library/VirtualFolders")
    libraries = [
        {
            "id": library.get("ItemId", ""),
            "name": library.get("Name", "Unnamed Library"),
            "type": library.get("CollectionType") or "mixed",
        }
        for library in views
    ]
    return {
        "connected": True,
        "server_name": info.get("ServerName") or settings.get("server_name") or "Jellyfin",
        "version": info.get("Version", ""),
        "libraries": libraries,
    }


def normalized_title(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()


def compare_jellyfin_movies(items: list[dict], library: dict, server_url: str) -> dict:
    local_rows = db().execute(
        "SELECT id, title, year, format, status FROM media WHERE media_type = 'Movies'"
    ).fetchall()
    locals_ = [dict(row) for row in local_rows]
    handled = {
        row["jellyfin_item_id"]
        for row in db().execute(
            "SELECT jellyfin_item_id FROM jellyfin_sources WHERE server_url = ?",
            (server_url,),
        ).fetchall()
    }
    result = {"matches": [], "possible_matches": [], "new_items": []}
    for raw in items:
        source_id = str(raw.get("Id", ""))
        if not source_id or source_id in handled:
            continue
        source = {
            "jellyfin_item_id": source_id,
            "library_id": library["id"],
            "library_name": library["name"],
            "title": raw.get("Name") or "Untitled",
            "year": raw.get("ProductionYear"),
            "provider_ids": raw.get("ProviderIds") or {},
            "path": raw.get("Path") or "",
        }
        source_norm = normalized_title(source["title"])
        exact = next(
            (
                item for item in locals_
                if normalized_title(item["title"]) == source_norm
                and (not source["year"] or not item["year"] or item["year"] == source["year"])
            ),
            None,
        )
        if exact:
            source["media_match"] = exact
            result["matches"].append(source)
            continue
        candidates = sorted(
            (
                (SequenceMatcher(None, source_norm, normalized_title(item["title"])).ratio(), item)
                for item in locals_
            ),
            key=lambda value: value[0],
            reverse=True,
        )
        if candidates and candidates[0][0] >= 0.72:
            source["media_match"] = candidates[0][1]
            source["confidence"] = round(candidates[0][0] * 100)
            result["possible_matches"].append(source)
        else:
            result["new_items"].append(source)
    return result


@app.get("/")
def index():
    return render_template(
        "index.html",
        media_types=MEDIA_TYPES,
        formats=FORMATS,
        statuses=STATUSES,
        conditions=CONDITIONS,
    )


@app.get("/api/media")
def list_media():
    search = request.args.get("q", "").strip()
    media_type = request.args.get("type", "").strip()
    status = request.args.get("status", "").strip()
    params: list = []
    where: list[str] = []

    if search:
        where.append(
            "(title LIKE ? OR upc LIKE ? OR tags LIKE ? OR physical_location LIKE ?)"
        )
        wildcard = f"%{search}%"
        params.extend([wildcard] * 4)
    if media_type:
        where.append("media_type = ?")
        params.append(media_type)
    if status:
        where.append("status = ?")
        params.append(status)

    clause = f"WHERE {' AND '.join(where)}" if where else ""
    rows = db().execute(
        f"SELECT * FROM media {clause} ORDER BY created_at DESC, id DESC", params
    ).fetchall()
    return jsonify([row_to_dict(row) for row in rows])


@app.get("/api/media/<int:item_id>")
def get_media(item_id: int):
    row = db().execute("SELECT * FROM media WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        return jsonify({"error": "Item not found."}), 404
    return jsonify(row_to_dict(row))


@app.post("/api/media")
def create_media():
    try:
        item = clean_payload(request.get_json(silent=True) or {})
    except (ValueError, TypeError) as exc:
        return jsonify({"error": str(exc)}), 400
    now = datetime.now(timezone.utc).isoformat()
    columns = ", ".join(item.keys())
    placeholders = ", ".join("?" for _ in item)
    cursor = db().execute(
        f"INSERT INTO media ({columns}, created_at, updated_at) "
        f"VALUES ({placeholders}, ?, ?)",
        [*item.values(), now, now],
    )
    db().commit()
    row = db().execute("SELECT * FROM media WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.put("/api/media/<int:item_id>")
def update_media(item_id: int):
    if db().execute("SELECT 1 FROM media WHERE id = ?", (item_id,)).fetchone() is None:
        return jsonify({"error": "Item not found."}), 404
    try:
        item = clean_payload(request.get_json(silent=True) or {})
    except (ValueError, TypeError) as exc:
        return jsonify({"error": str(exc)}), 400
    assignments = ", ".join(f"{column} = ?" for column in item)
    now = datetime.now(timezone.utc).isoformat()
    db().execute(
        f"UPDATE media SET {assignments}, updated_at = ? WHERE id = ?",
        [*item.values(), now, item_id],
    )
    db().commit()
    row = db().execute("SELECT * FROM media WHERE id = ?", (item_id,)).fetchone()
    return jsonify(row_to_dict(row))


@app.delete("/api/media/<int:item_id>")
def delete_media(item_id: int):
    cursor = db().execute("DELETE FROM media WHERE id = ?", (item_id,))
    db().commit()
    if cursor.rowcount == 0:
        return jsonify({"error": "Item not found."}), 404
    return "", 204


@app.get("/api/dashboard")
def dashboard():
    connection = db()
    counts = {
        "total": connection.execute("SELECT COUNT(*) FROM media").fetchone()[0],
        "movies": connection.execute(
            "SELECT COUNT(*) FROM media WHERE media_type = 'Movies'"
        ).fetchone()[0],
        "music": connection.execute(
            "SELECT COUNT(*) FROM media WHERE media_type = 'Music'"
        ).fetchone()[0],
        "games": connection.execute(
            "SELECT COUNT(*) FROM media WHERE media_type = 'Games'"
        ).fetchone()[0],
        "wishlist": connection.execute(
            "SELECT COUNT(*) FROM media WHERE status = 'Wishlist'"
        ).fetchone()[0],
    }
    recent = connection.execute(
        "SELECT * FROM media ORDER BY created_at DESC, id DESC LIMIT 5"
    ).fetchall()
    return jsonify({**counts, "recent": [row_to_dict(row) for row in recent]})


@app.get("/api/settings/jellyfin")
def get_jellyfin_settings():
    settings = jellyfin_settings()
    return jsonify({
        "server_url": settings["server_url"],
        "server_name": settings["server_name"],
        "api_key": "",
        "has_api_key": bool(settings["api_key"]),
    })


@app.post("/api/settings/jellyfin")
def save_jellyfin_settings():
    payload = request.get_json(silent=True) or {}
    current = jellyfin_settings()
    try:
        values = {
            "jellyfin_server_url": normalize_server_url(str(payload.get("server_url", ""))),
            "jellyfin_api_key": str(payload.get("api_key", "")).strip() or current["api_key"],
            "jellyfin_server_name": str(payload.get("server_name", "")).strip(),
        }
        if not values["jellyfin_api_key"]:
            raise ValueError("API Key is required.")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    db().executemany(
        "INSERT INTO app_settings(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        values.items(),
    )
    db().commit()
    return jsonify({"saved": True})


@app.post("/api/jellyfin/test")
def test_jellyfin():
    payload = request.get_json(silent=True) or {}
    saved = jellyfin_settings()
    settings = {
        "server_url": str(payload.get("server_url", "")).strip() or saved["server_url"],
        "api_key": str(payload.get("api_key", "")).strip() or saved["api_key"],
        "server_name": str(payload.get("server_name", "")).strip() or saved["server_name"],
    }
    try:
        return jsonify(jellyfin_connection(settings))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/jellyfin/import-preview")
def jellyfin_import_preview():
    settings = jellyfin_settings()
    try:
        connection = jellyfin_connection(settings)
        movie_libraries = [
            library for library in connection["libraries"]
            if library["type"].casefold() == "movies"
        ]
        combined = {"matches": [], "possible_matches": [], "new_items": []}
        for library in movie_libraries:
            response = jellyfin_request(
                settings,
                "/Items",
                {
                    "ParentId": library["id"],
                    "IncludeItemTypes": "Movie",
                    "Recursive": "true",
                    "Fields": "ProviderIds,Path",
                },
            )
            comparison = compare_jellyfin_movies(
                response.get("Items", []), library, normalize_server_url(settings["server_url"])
            )
            for category in combined:
                combined[category].extend(comparison[category])
        return jsonify({
            **combined,
            "movie_libraries": movie_libraries,
            "total": sum(len(values) for values in combined.values()),
        })
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/jellyfin/import-action")
def jellyfin_import_action():
    payload = request.get_json(silent=True) or {}
    action = str(payload.get("action", ""))
    if action not in ("attach", "create", "ignore"):
        return jsonify({"error": "Invalid import action."}), 400
    item = payload.get("item") or {}
    source_id = str(item.get("jellyfin_item_id", "")).strip()
    title = str(item.get("title", "")).strip()
    if not source_id or not title:
        return jsonify({"error": "Jellyfin item details are required."}), 400
    settings = jellyfin_settings()
    try:
        server_url = normalize_server_url(settings["server_url"])
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    media_id = payload.get("media_id")
    stored_action = "ignored"
    now = datetime.now(timezone.utc).isoformat()
    if action == "attach":
        if not media_id or db().execute(
            "SELECT 1 FROM media WHERE id = ?", (media_id,)
        ).fetchone() is None:
            return jsonify({"error": "Choose a valid MediaVault item."}), 400
        stored_action = "attached"
    elif action == "create":
        clean = clean_payload({
            "title": title,
            "year": item.get("year"),
            "media_type": "Movies",
            "format": "Digital",
            "status": "In Collection",
            "condition": "Unknown",
            "notes": "Available in Jellyfin.",
            "tags": "Jellyfin",
        })
        columns = ", ".join(clean.keys())
        placeholders = ", ".join("?" for _ in clean)
        cursor = db().execute(
            f"INSERT INTO media ({columns}, created_at, updated_at) "
            f"VALUES ({placeholders}, ?, ?)",
            [*clean.values(), now, now],
        )
        media_id = cursor.lastrowid
        stored_action = "created"

    try:
        db().execute(
            """
            INSERT INTO jellyfin_sources (
                jellyfin_item_id, jellyfin_library_id, jellyfin_library_name,
                server_url, media_id, source_title, source_year, action,
                metadata_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source_id, item.get("library_id"), item.get("library_name"),
                server_url, media_id, title, item.get("year"), stored_action,
                json.dumps(item, separators=(",", ":")), now,
            ),
        )
        db().commit()
    except sqlite3.IntegrityError:
        db().rollback()
        return jsonify({"error": "This Jellyfin item has already been handled."}), 409
    return jsonify({"action": stored_action, "media_id": media_id})


init_db()

if __name__ == "__main__":
    app.run(debug=True, port=int(os.environ.get("PORT", "5050")))
