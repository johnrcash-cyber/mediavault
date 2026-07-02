from __future__ import annotations

import argparse
import os
import sqlite3
import json
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from flask import Flask, Response, g, jsonify, render_template, request


BASE_DIR = Path(__file__).resolve().parent
DATABASE = Path(os.environ.get("MEDIAVAULT_DATABASE", BASE_DIR / "data" / "mediavault.db"))

app = Flask(__name__)

MEDIA_TYPES = ("Movies", "Television", "Music", "Games", "Books", "Other")
FORMATS = (
    "DVD", "Blu-ray", "4K", "CD", "Vinyl", "Cassette",
    "FLAC", "MP3", "Game Disc", "Cartridge", "Digital", "Other",
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
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS metadata_attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id INTEGER NOT NULL UNIQUE,
            provider TEXT NOT NULL,
            external_id TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            refreshed_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE,
            UNIQUE(provider, external_id)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS jellyfin_libraries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_url TEXT NOT NULL,
            library_id TEXT NOT NULL,
            name TEXT NOT NULL,
            collection_type TEXT NOT NULL,
            media_category TEXT,
            enabled INTEGER NOT NULL DEFAULT 0,
            imported_count INTEGER NOT NULL DEFAULT 0,
            last_sync TEXT,
            UNIQUE(server_url, library_id)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS source_status (
            source_name TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            last_checked TEXT,
            last_error TEXT
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS catalog_imports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            item_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS catalog_import_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            import_id INTEGER NOT NULL,
            source_key TEXT NOT NULL,
            media_id INTEGER,
            action TEXT NOT NULL CHECK(action IN ('created', 'attached', 'ignored')),
            created_at TEXT NOT NULL,
            UNIQUE(import_id, source_key),
            FOREIGN KEY(import_id) REFERENCES catalog_imports(id),
            FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE RESTRICT
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS import_previews (
            token TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            import_id INTEGER
        )
        """
    )
    preview_columns = {
        row[1] for row in connection.execute(
            "PRAGMA table_info(import_previews)"
        ).fetchall()
    }
    if "import_id" not in preview_columns:
        connection.execute("ALTER TABLE import_previews ADD COLUMN import_id INTEGER")
    connection.commit()
    connection.close()


def row_to_dict(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["tags"] = [tag.strip() for tag in (item.get("tags") or "").split(",") if tag.strip()]
    return item


def row_to_card_dict(row: sqlite3.Row) -> dict:
    item = row_to_dict(row)
    raw_metadata = item.pop("metadata_json", None)
    provider = item.pop("metadata_provider", None)
    has_jellyfin = bool(item.pop("has_jellyfin", False))
    try:
        metadata = json.loads(raw_metadata or "{}")
    except json.JSONDecodeError:
        metadata = {}
    item["title"] = metadata.get("title") or item["title"]
    item["year"] = metadata.get("year") or item["year"]
    item["poster_url"] = metadata.get("poster_url") or ""
    item["overview"] = metadata.get("overview") or ""
    item["runtime_minutes"] = metadata.get("runtime_minutes")
    item["rating"] = metadata.get("rating")
    item["artist"] = metadata.get("artist") or ""
    item["track_count"] = metadata.get("track_count")
    item["metadata_provider"] = (
        metadata.get("metadata_source")
        or (provider.upper() if provider else "")
    )
    item["sources"] = ["Jellyfin"] if has_jellyfin else []
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


JELLYFIN_LIBRARY_MAP = {
    "movies": ("Movies", "Movie"),
    "tvshows": ("Television", "Series"),
    "music": ("Music", "MusicAlbum"),
    "books": ("Books", "Book"),
    "games": ("Games", "Game"),
}


def auto_sync_enabled() -> bool:
    row = db().execute(
        "SELECT value FROM app_settings WHERE key = 'jellyfin_auto_sync'"
    ).fetchone()
    return bool(row and row["value"] == "1")


def auto_sync_frequency() -> str:
    row = db().execute(
        "SELECT value FROM app_settings "
        "WHERE key = 'jellyfin_auto_sync_frequency'"
    ).fetchone()
    value = row["value"] if row else "manual"
    return value if value in (
        "startup", "hourly", "six_hours", "daily", "weekly", "manual"
    ) else "manual"


def last_sync_summary() -> dict | None:
    row = db().execute(
        "SELECT value FROM app_settings "
        "WHERE key = 'jellyfin_last_sync_summary'"
    ).fetchone()
    if not row:
        return None
    try:
        return json.loads(row["value"])
    except json.JSONDecodeError:
        return None


def library_to_dict(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["enabled"] = bool(item["enabled"])
    item["supported"] = bool(item["media_category"])
    return item


def discover_jellyfin_libraries() -> list[dict]:
    settings = jellyfin_settings()
    connection = jellyfin_connection(settings)
    server_url = normalize_server_url(settings["server_url"])
    for library in connection["libraries"]:
        collection_type = str(library["type"] or "mixed").casefold()
        mapping = JELLYFIN_LIBRARY_MAP.get(collection_type)
        existing = db().execute(
            "SELECT enabled, media_category FROM jellyfin_libraries "
            "WHERE server_url = ? AND library_id = ?",
            (server_url, library["id"]),
        ).fetchone()
        category = (
            existing["media_category"] if existing and existing["media_category"]
            else mapping[0] if mapping else None
        )
        enabled = existing["enabled"] if existing else 0
        db().execute(
            """
            INSERT INTO jellyfin_libraries (
                server_url, library_id, name, collection_type,
                media_category, enabled
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(server_url, library_id) DO UPDATE SET
                name = excluded.name,
                collection_type = excluded.collection_type,
                media_category = excluded.media_category
            """,
            (
                server_url, library["id"], library["name"],
                collection_type, category, enabled,
            ),
        )
    db().commit()
    rows = db().execute(
        "SELECT * FROM jellyfin_libraries WHERE server_url = ? ORDER BY name",
        (server_url,),
    ).fetchall()
    return [library_to_dict(row) for row in rows]


def jellyfin_item_source(raw: dict, library: sqlite3.Row) -> dict:
    runtime_ticks = raw.get("RunTimeTicks") or 0
    artists = raw.get("Artists") or []
    artist = raw.get("AlbumArtist") or ", ".join(artists)
    return {
        "jellyfin_item_id": str(raw.get("Id", "")),
        "library_id": library["library_id"],
        "library_name": library["name"],
        "title": raw.get("Name") or "Untitled",
        "year": raw.get("ProductionYear"),
        "artist": artist,
        "genres": raw.get("Genres") or [],
        "track_count": raw.get("ChildCount"),
        "duration_seconds": round(runtime_ticks / 10_000_000) if runtime_ticks else None,
        "provider_ids": raw.get("ProviderIds") or {},
        "path": raw.get("Path") or "",
    }


def sync_jellyfin_libraries() -> dict:
    settings = jellyfin_settings()
    server_url = normalize_server_url(settings["server_url"])
    libraries = db().execute(
        """
        SELECT * FROM jellyfin_libraries
        WHERE server_url = ? AND enabled = 1 AND media_category IS NOT NULL
        ORDER BY name
        """,
        (server_url,),
    ).fetchall()
    result = {
        "processed": 0, "added": 0, "updated": 0,
        "skipped": 0, "failed": 0, "libraries": [],
    }
    now = datetime.now(timezone.utc).isoformat()
    for library in libraries:
        mapping = JELLYFIN_LIBRARY_MAP.get(library["collection_type"])
        if not mapping:
            continue
        category = library["media_category"]
        include_type = mapping[1]
        library_result = {
            "id": library["library_id"], "name": library["name"],
            "category": category, "added": 0, "updated": 0,
            "skipped": 0, "failed": 0,
        }
        try:
            response = jellyfin_request(
                settings,
                "/Items",
                {
                    "ParentId": library["library_id"],
                    "IncludeItemTypes": include_type,
                    "Recursive": "true",
                    "Fields": "ProviderIds,Path,Genres,RunTimeTicks,"
                              "AlbumArtist,Artists,ChildCount",
                },
            )
            for raw in response.get("Items", []):
                result["processed"] += 1
                source = jellyfin_item_source(raw, library)
                if not source["jellyfin_item_id"]:
                    continue
                existing_source = db().execute(
                    "SELECT * FROM jellyfin_sources "
                    "WHERE server_url = ? AND jellyfin_item_id = ?",
                    (server_url, source["jellyfin_item_id"]),
                ).fetchone()
                if existing_source:
                    source_json = json.dumps(source, separators=(",", ":"))
                    changed = (
                        existing_source["source_title"] != source["title"]
                        or existing_source["source_year"] != source["year"]
                        or existing_source["jellyfin_library_id"] != library["library_id"]
                        or existing_source["jellyfin_library_name"] != library["name"]
                        or existing_source["metadata_json"] != source_json
                    )
                    if changed:
                        db().execute(
                            """
                            UPDATE jellyfin_sources
                            SET jellyfin_library_id = ?, jellyfin_library_name = ?,
                                source_title = ?, source_year = ?, metadata_json = ?
                            WHERE id = ?
                            """,
                            (
                                library["library_id"], library["name"],
                                source["title"], source["year"], source_json,
                                existing_source["id"],
                            ),
                        )
                        result["updated"] += 1
                        library_result["updated"] += 1
                    else:
                        result["skipped"] += 1
                        library_result["skipped"] += 1
                    media_id = existing_source["media_id"]
                    if media_id and category in ("Movies", "Music"):
                        attachment = db().execute(
                            "SELECT metadata_json FROM metadata_attachments "
                            "WHERE media_id = ?",
                            (media_id,),
                        ).fetchone()
                        needs_metadata = not attachment
                        if attachment:
                            try:
                                needs_metadata = not json.loads(
                                    attachment["metadata_json"] or "{}"
                                ).get("poster_url")
                            except json.JSONDecodeError:
                                needs_metadata = True
                        if needs_metadata:
                            try:
                                enrich_media_item(media_id)
                            except (ValueError, LookupError, sqlite3.Error):
                                pass
                    continue
                candidates = db().execute(
                    "SELECT id, title, year FROM media WHERE media_type = ?",
                    (category,),
                ).fetchall()
                match = next(
                    (
                        row for row in candidates
                        if normalized_title(row["title"]) == normalized_title(source["title"])
                        and (
                            not source["year"] or not row["year"]
                            or source["year"] == row["year"]
                        )
                    ),
                    None,
                )
                media_id = match["id"] if match else None
                action = "attached"
                if not media_id:
                    clean = clean_payload({
                        "title": source["title"],
                        "year": source["year"],
                        "media_type": category,
                        "format": "Digital",
                        "status": "In Collection",
                        "condition": "Unknown",
                        "notes": "",
                        "tags": "",
                    })
                    columns = ", ".join(clean.keys())
                    placeholders = ", ".join("?" for _ in clean)
                    cursor = db().execute(
                        f"INSERT INTO media ({columns}, created_at, updated_at) "
                        f"VALUES ({placeholders}, ?, ?)",
                        [*clean.values(), now, now],
                    )
                    media_id = cursor.lastrowid
                    action = "created"
                    result["added"] += 1
                    library_result["added"] += 1
                else:
                    result["updated"] += 1
                    library_result["updated"] += 1
                db().execute(
                    """
                    INSERT INTO jellyfin_sources (
                        jellyfin_item_id, jellyfin_library_id,
                        jellyfin_library_name, server_url, media_id,
                        source_title, source_year, action,
                        metadata_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        source["jellyfin_item_id"], library["library_id"],
                        library["name"], server_url, media_id,
                        source["title"], source["year"], action,
                        json.dumps(source, separators=(",", ":")), now,
                    ),
                )
                if category in ("Movies", "Music"):
                    try:
                        enrich_media_item(media_id)
                    except (ValueError, LookupError, sqlite3.Error):
                        pass
            total = db().execute(
                "SELECT COUNT(*) FROM jellyfin_sources "
                "WHERE server_url = ? AND jellyfin_library_id = ? "
                "AND action IN ('attached', 'created')",
                (server_url, library["library_id"]),
            ).fetchone()[0]
            db().execute(
                "UPDATE jellyfin_libraries SET imported_count = ?, last_sync = ? "
                "WHERE id = ?",
                (total, now, library["id"]),
            )
            db().commit()
            library_result["imported_count"] = total
        except (ValueError, sqlite3.Error) as exc:
            db().rollback()
            result["failed"] += 1
            library_result["failed"] += 1
            library_result["error"] = str(exc)
        result["libraries"].append(library_result)
    result["last_sync"] = now
    db().execute(
        "INSERT INTO app_settings(key, value) VALUES('jellyfin_last_sync_summary', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (json.dumps(result, separators=(",", ":")),),
    )
    db().commit()
    return result


def normalized_title(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()


def normalize_jellyfin_item(raw: dict, library: dict | None = None) -> dict:
    people = raw.get("People") or []
    directors = [person.get("Name") for person in people if person.get("Type") == "Director"]
    cast = [person.get("Name") for person in people if person.get("Type") == "Actor"][:12]
    studios = raw.get("Studios") or []
    runtime_ticks = raw.get("RunTimeTicks") or 0
    return {
        "jellyfin_item_id": str(raw.get("Id", "")),
        "library_id": (library or {}).get("id", ""),
        "library_name": (library or {}).get("name", ""),
        "title": raw.get("Name") or "Untitled",
        "year": raw.get("ProductionYear"),
        "overview": raw.get("Overview") or "",
        "genres": raw.get("Genres") or [],
        "runtime_minutes": round(runtime_ticks / 600_000_000) if runtime_ticks else None,
        "rating": raw.get("CommunityRating"),
        "director": ", ".join(filter(None, directors)),
        "cast": list(filter(None, cast)),
        "studio": ", ".join(
            studio.get("Name", "") for studio in studios if studio.get("Name")
        ),
        "release_date": (raw.get("PremiereDate") or "")[:10],
        "provider_ids": raw.get("ProviderIds") or {},
        "path": raw.get("Path") or "",
        "has_poster": bool((raw.get("ImageTags") or {}).get("Primary")),
        "has_backdrop": bool(raw.get("BackdropImageTags")),
    }


def provider_settings() -> dict:
    rows = db().execute(
        "SELECT key, value FROM app_settings WHERE key IN "
        "('omdb_api_key', 'tmdb_api_key', 'metadata_provider_priority', "
        "'music_provider_priority', 'discogs_token', 'lastfm_api_key', "
        "'rawg_api_key')"
    ).fetchall()
    values = {row["key"]: row["value"] for row in rows}
    return {
        "omdb_api_key": values.get("omdb_api_key", ""),
        "tmdb_api_key": values.get("tmdb_api_key", ""),
        "metadata_provider_priority": values.get(
            "metadata_provider_priority", "omdb,tmdb"
        ),
        "music_provider_priority": values.get(
            "music_provider_priority", "musicbrainz,discogs,coverartarchive,lastfm"
        ),
        "discogs_token": values.get("discogs_token", ""),
        "lastfm_api_key": values.get("lastfm_api_key", ""),
        "rawg_api_key": values.get("rawg_api_key", ""),
    }


SOURCE_NAMES = ("Jellyfin", "OMDb", "TMDB", "MusicBrainz", "Discogs", "Last.fm")


def source_health_configuration() -> dict[str, dict | None]:
    providers = provider_settings()
    jellyfin = jellyfin_settings()
    configurations: dict[str, dict | None] = {
        "Jellyfin": None,
        "OMDb": None,
        "TMDB": None,
        "MusicBrainz": {
            "url": "https://musicbrainz.org/ws/2/release/"
                   "?query=release%3Atest&limit=1&fmt=json",
            "headers": {
                "Accept": "application/json",
                "User-Agent": "MediaVault/1.0 (personal media catalog)",
            },
        },
        "Discogs": None,
        "Last.fm": None,
    }
    if jellyfin["server_url"] and jellyfin["api_key"]:
        configurations["Jellyfin"] = {
            "url": f"{normalize_server_url(jellyfin['server_url'])}/System/Info",
            "headers": {
                "Accept": "application/json",
                "X-Emby-Token": jellyfin["api_key"],
                "User-Agent": "MediaVault/1.0",
            },
        }
    if providers["omdb_api_key"]:
        configurations["OMDb"] = {
            "url": "https://www.omdbapi.com/?" + urllib.parse.urlencode({
                "apikey": providers["omdb_api_key"], "i": "tt0133093", "r": "json",
            }),
            "headers": {"Accept": "application/json", "User-Agent": "MediaVault/1.0"},
        }
    if providers["tmdb_api_key"]:
        tmdb_headers = {"Accept": "application/json", "User-Agent": "MediaVault/1.0"}
        tmdb_query = {}
        if providers["tmdb_api_key"].startswith("eyJ"):
            tmdb_headers["Authorization"] = f"Bearer {providers['tmdb_api_key']}"
        else:
            tmdb_query["api_key"] = providers["tmdb_api_key"]
        configurations["TMDB"] = {
            "url": "https://api.themoviedb.org/3/configuration?"
                   + urllib.parse.urlencode(tmdb_query),
            "headers": tmdb_headers,
        }
    if providers["discogs_token"]:
        configurations["Discogs"] = {
            "url": "https://api.discogs.com/database/search?"
                   + urllib.parse.urlencode({
                       "q": "test", "type": "release", "per_page": 1,
                       "token": providers["discogs_token"],
                   }),
            "headers": {"Accept": "application/json", "User-Agent": "MediaVault/1.0"},
        }
    if providers["lastfm_api_key"]:
        configurations["Last.fm"] = {
            "url": "https://ws.audioscrobbler.com/2.0/?"
                   + urllib.parse.urlencode({
                       "method": "album.search", "album": "test", "limit": 1,
                       "api_key": providers["lastfm_api_key"], "format": "json",
                   }),
            "headers": {"Accept": "application/json", "User-Agent": "MediaVault/1.0"},
        }
    return configurations


def check_source_health(name: str, config: dict | None) -> dict:
    checked = datetime.now(timezone.utc).isoformat()
    if config is None:
        return {
            "source_name": name, "status": "Not Configured",
            "last_checked": checked, "last_error": "",
        }
    try:
        request_ = urllib.request.Request(config["url"], headers=config["headers"])
        with urllib.request.urlopen(request_, timeout=3) as response:
            if not 200 <= response.status < 400:
                raise ValueError(f"HTTP {response.status}")
            response.read(1024)
        return {
            "source_name": name, "status": "Online",
            "last_checked": checked, "last_error": "",
        }
    except urllib.error.HTTPError as exc:
        error = f"Authentication failed (HTTP {exc.code})" if exc.code in (401, 403) else f"HTTP {exc.code}"
    except urllib.error.URLError as exc:
        error = str(getattr(exc, "reason", "Connection failed"))
    except (TimeoutError, ValueError) as exc:
        error = str(exc) or "Connection timed out"
    return {
        "source_name": name, "status": "Offline",
        "last_checked": checked, "last_error": error[:300],
    }


def run_source_health_checks() -> list[dict]:
    with app.app_context():
        configurations = source_health_configuration()
    results = []
    with ThreadPoolExecutor(max_workers=len(SOURCE_NAMES)) as executor:
        futures = {
            executor.submit(check_source_health, name, configurations[name]): name
            for name in SOURCE_NAMES
        }
        for future in as_completed(futures):
            results.append(future.result())
    with app.app_context():
        db().executemany(
            """
            INSERT INTO source_status (
                source_name, status, last_checked, last_error
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(source_name) DO UPDATE SET
                status = excluded.status,
                last_checked = excluded.last_checked,
                last_error = excluded.last_error
            """,
            [
                (
                    result["source_name"], result["status"],
                    result["last_checked"], result["last_error"],
                )
                for result in results
            ],
        )
        db().commit()
    return sorted(results, key=lambda item: SOURCE_NAMES.index(item["source_name"]))


def public_json_request(url: str, provider: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "MediaVault/1.0 (personal media catalog)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return {}
        raise ValueError(f"{provider} returned HTTP {exc.code}.") from exc
    except urllib.error.URLError as exc:
        raise ValueError(
            f"Could not reach {provider}: {getattr(exc, 'reason', exc)}"
        ) from exc
    except (TimeoutError, json.JSONDecodeError) as exc:
        raise ValueError(f"{provider} did not return a valid response.") from exc


def musicbrainz_request(path: str, query: dict | None = None) -> dict:
    params = {**(query or {}), "fmt": "json"}
    url = (
        f"https://musicbrainz.org/ws/2{path}?"
        f"{urllib.parse.urlencode(params)}"
    )
    return public_json_request(url, "MusicBrainz")


def cover_art_for_release(release_id: str) -> str:
    data = public_json_request(
        f"https://coverartarchive.org/release/{urllib.parse.quote(release_id)}",
        "Cover Art Archive",
    )
    images = data.get("images") or []
    front = next((image for image in images if image.get("front")), None)
    if not front:
        return ""
    thumbnails = front.get("thumbnails") or {}
    return thumbnails.get("500") or thumbnails.get("large") or front.get("image") or ""


def artist_credit_text(raw: dict) -> str:
    return "".join(
        f"{part.get('name', '')}{part.get('joinphrase', '')}"
        for part in (raw.get("artist-credit") or [])
    ).strip()


def normalize_musicbrainz_release(raw: dict) -> dict:
    media = raw.get("media") or []
    tracks = []
    total_duration_ms = 0
    for medium in media:
        for track in medium.get("tracks") or []:
            recording = track.get("recording") or {}
            length = track.get("length") or recording.get("length") or 0
            total_duration_ms += length
            tracks.append({
                "number": track.get("number") or str(len(tracks) + 1),
                "title": track.get("title") or recording.get("title") or "Untitled",
                "duration_seconds": round(length / 1000) if length else None,
            })
    label_info = raw.get("label-info") or []
    labels = [
        info.get("label", {}).get("name")
        for info in label_info if info.get("label", {}).get("name")
    ]
    catalog_numbers = [
        info.get("catalog-number") for info in label_info
        if info.get("catalog-number")
    ]
    release_group = raw.get("release-group") or {}
    genres = [
        genre.get("name") for genre in (
            raw.get("genres") or release_group.get("genres") or []
        ) if genre.get("name")
    ]
    release_types = [
        release_group.get("primary-type"),
        *(release_group.get("secondary-types") or []),
    ]
    date = raw.get("date") or ""
    return {
        "title": raw.get("title") or "Untitled",
        "album_title": raw.get("title") or "Untitled",
        "artist": artist_credit_text(raw),
        "year": int(date[:4]) if date[:4].isdigit() else None,
        "overview": "",
        "genres": genres,
        "runtime_minutes": round(total_duration_ms / 60000) if total_duration_ms else None,
        "duration_seconds": round(total_duration_ms / 1000) if total_duration_ms else None,
        "rating": None,
        "director": "",
        "cast": [],
        "studio": "",
        "release_date": date,
        "track_count": len(tracks) or sum(medium.get("track-count", 0) for medium in media),
        "track_listing": tracks,
        "label": ", ".join(labels),
        "catalog_number": ", ".join(catalog_numbers),
        "edition": raw.get("disambiguation") or (
            ", ".join(filter(None, [raw.get("country"), raw.get("status")]))
        ),
        "release_type": ", ".join(filter(None, release_types)),
        "external_id": raw.get("id") or "",
        "metadata_source": "MusicBrainz",
        "artwork_source": "Cover Art Archive",
        "poster_url": cover_art_for_release(raw.get("id", "")),
        "backdrop_url": "",
        "artist_image_url": "",
    }


def fetch_musicbrainz_release(external_id: str) -> dict:
    if not re.fullmatch(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
        r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        str(external_id),
    ):
        raise ValueError("Invalid MusicBrainz release ID.")
    raw = musicbrainz_request(
        f"/release/{external_id}",
        {"inc": "recordings+artist-credits+labels+release-groups+genres"},
    )
    if not raw.get("id"):
        raise ValueError("MusicBrainz release not found.")
    return normalize_musicbrainz_release(raw)


def discogs_request(path: str, query: dict | None = None) -> dict:
    token = provider_settings()["discogs_token"].strip()
    if not token:
        raise ValueError("Configure your Discogs token in Settings first.")
    params = {**(query or {}), "token": token}
    return public_json_request(
        f"https://api.discogs.com{path}?{urllib.parse.urlencode(params)}",
        "Discogs",
    )


def duration_to_seconds(value: str) -> int | None:
    parts = str(value or "").split(":")
    if not parts or not all(part.isdigit() for part in parts):
        return None
    total = 0
    for part in parts:
        total = total * 60 + int(part)
    return total or None


def normalize_discogs_release(raw: dict) -> dict:
    tracks = []
    total_seconds = 0
    for index, track in enumerate(raw.get("tracklist") or [], start=1):
        seconds = duration_to_seconds(track.get("duration"))
        total_seconds += seconds or 0
        tracks.append({
            "number": track.get("position") or str(index),
            "title": track.get("title") or "Untitled",
            "duration_seconds": seconds,
        })
    artists = ", ".join(
        artist.get("name", "").replace(" (2)", "")
        for artist in (raw.get("artists") or []) if artist.get("name")
    )
    labels = raw.get("labels") or []
    formats = raw.get("formats") or []
    image = next(
        (image for image in (raw.get("images") or []) if image.get("type") == "primary"),
        (raw.get("images") or [{}])[0],
    )
    year = raw.get("year")
    return {
        "title": raw.get("title") or "Untitled",
        "album_title": raw.get("title") or "Untitled",
        "artist": artists,
        "year": int(year) if str(year).isdigit() else None,
        "overview": raw.get("notes") or "",
        "genres": list(dict.fromkeys([*(raw.get("genres") or []), *(raw.get("styles") or [])])),
        "runtime_minutes": round(total_seconds / 60) if total_seconds else None,
        "duration_seconds": total_seconds or None,
        "rating": (raw.get("community") or {}).get("rating", {}).get("average"),
        "director": "", "cast": [], "studio": "",
        "release_date": str(year or ""),
        "track_count": len(tracks),
        "track_listing": tracks,
        "label": ", ".join(label.get("name", "") for label in labels if label.get("name")),
        "catalog_number": ", ".join(label.get("catno", "") for label in labels if label.get("catno")),
        "edition": ", ".join(
            value for fmt in formats for value in (fmt.get("descriptions") or [])
        ),
        "release_type": ", ".join(fmt.get("name", "") for fmt in formats if fmt.get("name")),
        "external_id": str(raw.get("id", "")),
        "metadata_source": "Discogs",
        "artwork_source": "Discogs",
        "poster_url": image.get("uri") or image.get("resource_url") or "",
        "backdrop_url": "", "artist_image_url": "",
    }


def fetch_discogs_release(external_id: str) -> dict:
    if not str(external_id).isdigit():
        raise ValueError("Invalid Discogs release ID.")
    return normalize_discogs_release(discogs_request(f"/releases/{external_id}"))


def lastfm_request(params: dict) -> dict:
    key = provider_settings()["lastfm_api_key"].strip()
    if not key:
        raise ValueError("Configure your Last.fm API key in Settings first.")
    query = {**params, "api_key": key, "format": "json"}
    data = public_json_request(
        f"https://ws.audioscrobbler.com/2.0/?{urllib.parse.urlencode(query)}",
        "Last.fm",
    )
    if data.get("error"):
        raise ValueError(data.get("message") or "Last.fm could not complete the request.")
    return data


def lastfm_external_id(artist: str, album: str) -> str:
    return urllib.parse.urlencode({"artist": artist, "album": album})


def fetch_lastfm_album(external_id: str) -> dict:
    identity = urllib.parse.parse_qs(external_id)
    artist = (identity.get("artist") or [""])[0]
    album = (identity.get("album") or [""])[0]
    if not artist or not album:
        raise ValueError("Invalid Last.fm album identity.")
    raw = lastfm_request({
        "method": "album.getinfo", "artist": artist,
        "album": album, "autocorrect": 1,
    }).get("album") or {}
    tracks_raw = (raw.get("tracks") or {}).get("track") or []
    if isinstance(tracks_raw, dict):
        tracks_raw = [tracks_raw]
    tracks = []
    total = 0
    for index, track in enumerate(tracks_raw, 1):
        seconds = int(track.get("duration") or 0) or None
        total += seconds or 0
        tracks.append({
            "number": str((track.get("@attr") or {}).get("rank") or index),
            "title": track.get("name") or "Untitled",
            "duration_seconds": seconds,
        })
    images = raw.get("image") or []
    poster = next(
        (image.get("#text") for image in reversed(images) if image.get("#text")), ""
    )
    tags = (raw.get("tags") or {}).get("tag") or []
    if isinstance(tags, dict):
        tags = [tags]
    release_date = str(raw.get("releasedate") or "").strip()
    artist_name = raw.get("artist") or artist
    artist_image = ""
    try:
        artist_info = lastfm_request({
            "method": "artist.getinfo", "artist": artist_name, "autocorrect": 1,
        }).get("artist") or {}
        artist_images = artist_info.get("image") or []
        artist_image = next(
            (
                image.get("#text") for image in reversed(artist_images)
                if image.get("#text")
            ),
            "",
        )
    except ValueError:
        pass
    return {
        "title": raw.get("name") or album,
        "album_title": raw.get("name") or album,
        "artist": artist_name,
        "year": next((int(part) for part in release_date.replace(",", " ").split() if len(part) == 4 and part.isdigit()), None),
        "overview": ((raw.get("wiki") or {}).get("summary") or ""),
        "genres": [tag.get("name") for tag in tags if tag.get("name")],
        "runtime_minutes": round(total / 60) if total else None,
        "duration_seconds": total or None,
        "rating": None, "director": "", "cast": [], "studio": "",
        "release_date": release_date,
        "track_count": len(tracks), "track_listing": tracks,
        "label": "", "catalog_number": "", "edition": "", "release_type": "Album",
        "external_id": external_id, "metadata_source": "Last.fm",
        "artwork_source": "Last.fm", "poster_url": poster,
        "backdrop_url": "", "artist_image_url": artist_image,
    }


def omdb_request(query: dict) -> dict:
    api_key = provider_settings()["omdb_api_key"].strip()
    if not api_key:
        raise ValueError("Configure your OMDb API key in Settings first.")
    params = {**query, "apikey": api_key, "r": "json"}
    url = f"https://www.omdbapi.com/?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url, headers={"Accept": "application/json", "User-Agent": "MediaVault/1.0"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
        if data.get("Response") == "False":
            raise ValueError(data.get("Error") or "OMDb could not complete the request.")
        return data
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise ValueError("OMDb rejected the API key.") from exc
        raise ValueError(f"OMDb returned HTTP {exc.code}.") from exc
    except urllib.error.URLError as exc:
        raise ValueError(f"Could not reach OMDb: {getattr(exc, 'reason', exc)}") from exc
    except (TimeoutError, json.JSONDecodeError) as exc:
        raise ValueError("OMDb did not return a valid response.") from exc


def normalize_omdb_movie(raw: dict) -> dict:
    def available(value):
        return "" if value in (None, "N/A") else value

    year_text = available(raw.get("Year", ""))
    runtime_text = available(raw.get("Runtime", ""))
    runtime_match = re.search(r"\d+", runtime_text)
    rating_text = available(raw.get("imdbRating", ""))
    poster = available(raw.get("Poster", ""))
    return {
        "title": available(raw.get("Title")) or "Untitled",
        "year": int(year_text[:4]) if year_text[:4].isdigit() else None,
        "overview": available(raw.get("Plot")),
        "genres": [
            value.strip() for value in available(raw.get("Genre", "")).split(",")
            if value.strip()
        ],
        "runtime_minutes": int(runtime_match.group()) if runtime_match else None,
        "rating": float(rating_text) if rating_text else None,
        "director": available(raw.get("Director")),
        "cast": [
            value.strip() for value in available(raw.get("Actors", "")).split(",")
            if value.strip()
        ],
        "studio": "",
        "release_date": available(raw.get("Released")),
        "external_id": available(raw.get("imdbID")),
        "metadata_source": "OMDb",
        "poster_url": poster,
        "backdrop_url": "",
    }


def fetch_omdb_movie(external_id: str) -> dict:
    if not re.fullmatch(r"tt\d{7,10}", str(external_id)):
        raise ValueError("Invalid IMDb ID.")
    return normalize_omdb_movie(
        omdb_request({"i": external_id, "type": "movie", "plot": "full"})
    )


def fetch_provider_movie(provider: str, external_id: str) -> dict:
    if provider == "omdb":
        return fetch_omdb_movie(external_id)
    if provider == "tmdb":
        return fetch_tmdb_movie(external_id)
    raise ValueError("Unsupported movie metadata provider.")


def provider_order() -> list[str]:
    configured = provider_settings()
    order = [
        provider.strip()
        for provider in configured["metadata_provider_priority"].split(",")
        if provider.strip() in ("omdb", "tmdb")
    ]
    return [
        provider for provider in order
        if configured.get(f"{provider}_api_key")
    ]


def find_provider_movie(provider: str, title: str, year: int | None) -> str | None:
    target = normalized_title(title)
    if provider == "omdb":
        params = {"s": title, "type": "movie", "page": 1}
        if year:
            params["y"] = str(year)
        try:
            response = omdb_request(params)
        except ValueError as exc:
            if "not found" in str(exc).casefold():
                return None
            raise
        candidates = response.get("Search", [])
        for candidate in candidates:
            candidate_year = str(candidate.get("Year") or "")[:4]
            if normalized_title(candidate.get("Title") or "") == target and (
                not year or not candidate_year.isdigit() or int(candidate_year) == year
            ):
                return candidate.get("imdbID")
        return None
    if provider == "tmdb":
        params = {
            "query": title, "include_adult": "false",
            "language": "en-US", "page": 1,
        }
        if year:
            params["primary_release_year"] = str(year)
        response = tmdb_request("/search/movie", params)
        for candidate in response.get("results", []):
            release_year = str(candidate.get("release_date") or "")[:4]
            if normalized_title(candidate.get("title") or "") == target and (
                not year or not release_year.isdigit() or int(release_year) == year
            ):
                return str(candidate.get("id"))
        return None
    return None


def music_provider_order() -> list[str]:
    settings = provider_settings()
    order = [
        provider.strip()
        for provider in settings["music_provider_priority"].split(",")
        if provider.strip() in ("musicbrainz", "discogs", "lastfm")
    ]
    return [
        provider for provider in order
        if provider == "musicbrainz"
        or (provider == "discogs" and settings["discogs_token"])
        or (provider == "lastfm" and settings["lastfm_api_key"])
    ]


def find_music_release(
    provider: str, album: str, artist: str, year: int | None
) -> str | None:
    target_album = normalized_title(album)
    target_artist = normalized_title(artist)
    if provider == "musicbrainz":
        safe_album = album.replace('"', r'\"')
        parts = [f'release:"{safe_album}"']
        if artist:
            parts.append(f'artist:"{artist.replace(chr(34), "")}"')
        if year:
            parts.append(f"date:{year}")
        response = musicbrainz_request(
            "/release/", {"query": " AND ".join(parts), "limit": 12}
        )
        for release in response.get("releases", []):
            release_artist = normalized_title(artist_credit_text(release))
            release_year = str(release.get("date") or "")[:4]
            if normalized_title(release.get("title") or "") == target_album and (
                not target_artist or release_artist == target_artist
            ) and (
                not year or not release_year.isdigit() or int(release_year) == year
            ):
                return release.get("id")
        return None
    if provider == "discogs":
        params = {"release_title": album, "type": "release", "per_page": 12}
        if artist:
            params["artist"] = artist
        if year:
            params["year"] = year
        response = discogs_request("/database/search", params)
        for release in response.get("results", []):
            combined = release.get("title") or ""
            release_artist, separator, release_album = combined.partition(" - ")
            if normalized_title(release_album if separator else combined) == target_album and (
                not target_artist or normalized_title(release_artist) == target_artist
            ):
                return str(release.get("id"))
        return None
    if provider == "lastfm":
        response = lastfm_request({
            "method": "album.search", "album": album, "limit": 12,
        })
        matches = ((response.get("results") or {}).get("albummatches") or {}).get("album") or []
        if isinstance(matches, dict):
            matches = [matches]
        for release in matches:
            release_artist = release.get("artist") or ""
            if normalized_title(release.get("name") or "") == target_album and (
                not target_artist or normalized_title(release_artist) == target_artist
            ):
                return lastfm_external_id(release_artist, release.get("name") or album)
        return None
    return None


def enrich_media_item(item_id: int) -> tuple[str, dict]:
    item = db().execute(
        "SELECT id, title, year, media_type FROM media WHERE id = ?", (item_id,)
    ).fetchone()
    if item is None:
        raise ValueError("Item not found.")
    attachment = db().execute(
        "SELECT * FROM metadata_attachments WHERE media_id = ?", (item_id,)
    ).fetchone()
    if item["media_type"] == "Music":
        music_fetchers = {
            "musicbrainz": fetch_musicbrainz_release,
            "discogs": fetch_discogs_release,
            "lastfm": fetch_lastfm_album,
        }
        if attachment:
            fetcher = music_fetchers.get(attachment["provider"])
            if not fetcher:
                raise ValueError("This music metadata provider cannot be refreshed.")
            metadata = fetcher(attachment["external_id"])
            db().execute(
                "UPDATE metadata_attachments SET metadata_json = ?, refreshed_at = ? "
                "WHERE id = ?",
                (
                    json.dumps(metadata, separators=(",", ":")),
                    datetime.now(timezone.utc).isoformat(),
                    attachment["id"],
                ),
            )
            db().commit()
            return attachment["provider"], metadata
        source = db().execute(
            """
            SELECT metadata_json FROM jellyfin_sources
            WHERE media_id = ? AND action IN ('attached', 'created')
            ORDER BY created_at DESC LIMIT 1
            """,
            (item_id,),
        ).fetchone()
        source_data = json.loads(source["metadata_json"] or "{}") if source else {}
        artist = source_data.get("artist") or ""
        errors = []
        for provider in music_provider_order():
            try:
                external_id = find_music_release(
                    provider, item["title"], artist, item["year"]
                )
                if not external_id:
                    continue
                metadata = music_fetchers[provider](external_id)
                now = datetime.now(timezone.utc).isoformat()
                db().execute(
                    """
                    INSERT INTO metadata_attachments (
                        media_id, provider, external_id, metadata_json,
                        refreshed_at, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item_id, provider, external_id,
                        json.dumps(metadata, separators=(",", ":")), now, now,
                    ),
                )
                db().commit()
                return provider, metadata
            except (ValueError, sqlite3.IntegrityError) as exc:
                db().rollback()
                errors.append(f"{provider}: {exc}")
        if errors:
            raise ValueError("; ".join(errors))
        raise LookupError(
            "No exact album match found. Use Change Metadata Source to choose one."
        )
    if item["media_type"] != "Movies":
        raise LookupError("Metadata enrichment is not available for this media type yet.")
    order = provider_order()
    if not order:
        raise ValueError("Configure an OMDb or TMDB API key in Settings first.")
    errors = []
    for provider in order:
        try:
            external_id = None
            if attachment and attachment["provider"] == provider:
                external_id = attachment["external_id"]
            if not external_id:
                external_id = find_provider_movie(
                    provider, item["title"], item["year"]
                )
            if not external_id:
                continue
            metadata = fetch_provider_movie(provider, external_id)
            now = datetime.now(timezone.utc).isoformat()
            db().execute(
                """
                INSERT INTO metadata_attachments (
                    media_id, provider, external_id, metadata_json,
                    refreshed_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(media_id) DO UPDATE SET
                    provider = excluded.provider,
                    external_id = excluded.external_id,
                    metadata_json = excluded.metadata_json,
                    refreshed_at = excluded.refreshed_at
                """,
                (
                    item_id, provider, external_id,
                    json.dumps(metadata, separators=(",", ":")), now, now,
                ),
            )
            db().commit()
            return provider, metadata
        except (ValueError, sqlite3.IntegrityError) as exc:
            db().rollback()
            errors.append(f"{provider.upper()}: {exc}")
    if errors:
        raise ValueError("; ".join(errors))
    raise LookupError("No exact provider match found for this title and year.")


def tmdb_request(path: str, query: dict | None = None) -> dict:
    api_key = provider_settings()["tmdb_api_key"].strip()
    if not api_key:
        raise ValueError("Configure your TMDB API key in Settings first.")
    params = dict(query or {})
    headers = {"Accept": "application/json", "User-Agent": "MediaVault/1.0"}
    if api_key.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {api_key}"
    else:
        params["api_key"] = api_key
    url = f"https://api.themoviedb.org/3{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise ValueError("TMDB rejected the API key.") from exc
        raise ValueError(f"TMDB returned HTTP {exc.code}.") from exc
    except urllib.error.URLError as exc:
        raise ValueError(f"Could not reach TMDB: {getattr(exc, 'reason', exc)}") from exc
    except (TimeoutError, json.JSONDecodeError) as exc:
        raise ValueError("TMDB did not return a valid response.") from exc


def normalize_tmdb_movie(raw: dict) -> dict:
    credits = raw.get("credits") or {}
    crew = credits.get("crew") or []
    cast = credits.get("cast") or []
    directors = [
        person.get("name") for person in crew
        if person.get("job") == "Director" and person.get("name")
    ]
    poster_path = raw.get("poster_path") or ""
    backdrop_path = raw.get("backdrop_path") or ""
    release_date = raw.get("release_date") or ""
    return {
        "title": raw.get("title") or raw.get("name") or "Untitled",
        "year": int(release_date[:4]) if release_date[:4].isdigit() else None,
        "overview": raw.get("overview") or "",
        "genres": [
            genre.get("name") for genre in (raw.get("genres") or [])
            if genre.get("name")
        ],
        "runtime_minutes": raw.get("runtime"),
        "rating": raw.get("vote_average"),
        "director": ", ".join(directors),
        "cast": [person.get("name") for person in cast[:12] if person.get("name")],
        "studio": ", ".join(
            company.get("name", "") for company in (raw.get("production_companies") or [])
            if company.get("name")
        ),
        "release_date": release_date,
        "external_id": str(raw.get("id", "")),
        "metadata_source": "TMDB",
        "poster_url": f"https://image.tmdb.org/t/p/w500{poster_path}" if poster_path else "",
        "backdrop_url": f"https://image.tmdb.org/t/p/w1280{backdrop_path}" if backdrop_path else "",
    }


def fetch_tmdb_movie(external_id: str) -> dict:
    if not str(external_id).isdigit():
        raise ValueError("Invalid TMDB movie ID.")
    raw = tmdb_request(
        f"/movie/{external_id}",
        {"language": "en-US", "append_to_response": "credits"},
    )
    return normalize_tmdb_movie(raw)


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
        source = normalize_jellyfin_item(raw, library)
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
    source = request.args.get("source", "").strip()
    params: list = []
    where: list[str] = []

    if search:
        where.append(
            "(m.title LIKE ? OR m.upc LIKE ? OR m.tags LIKE ? OR m.physical_location LIKE ?)"
        )
        wildcard = f"%{search}%"
        params.extend([wildcard] * 4)
    if media_type:
        where.append("m.media_type = ?")
        params.append(media_type)
    if status:
        where.append("m.status = ?")
        params.append(status)
    if source == "manual":
        where.append(
            "NOT EXISTS (SELECT 1 FROM jellyfin_sources js WHERE js.media_id = m.id) "
            "AND NOT EXISTS (SELECT 1 FROM catalog_import_links ci WHERE ci.media_id = m.id)"
        )

    clause = f"WHERE {' AND '.join(where)}" if where else ""
    rows = db().execute(
        f"""
        SELECT m.*, ma.provider AS metadata_provider, ma.metadata_json,
               EXISTS(
                   SELECT 1 FROM jellyfin_sources js
                   WHERE js.media_id = m.id
                     AND js.action IN ('attached', 'created')
               ) AS has_jellyfin
        FROM media m
        LEFT JOIN metadata_attachments ma ON ma.media_id = m.id
        {clause}
        ORDER BY m.created_at DESC, m.id DESC
        """,
        params,
    ).fetchall()
    return jsonify([row_to_card_dict(row) for row in rows])


@app.get("/api/media/<int:item_id>")
def get_media(item_id: int):
    row = db().execute("SELECT * FROM media WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        return jsonify({"error": "Item not found."}), 404
    return jsonify(row_to_dict(row))


@app.get("/api/media/<int:item_id>/quick-view")
def media_quick_view(item_id: int):
    row = db().execute("SELECT * FROM media WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        return jsonify({"error": "Item not found."}), 404
    collector = row_to_dict(row)
    source = db().execute(
        """
        SELECT * FROM jellyfin_sources
        WHERE media_id = ? AND action IN ('attached', 'created')
        ORDER BY created_at DESC LIMIT 1
        """,
        (item_id,),
    ).fetchone()
    metadata_attachment = db().execute(
        "SELECT * FROM metadata_attachments WHERE media_id = ?",
        (item_id,),
    ).fetchone()
    metadata = {}
    metadata_source = None
    if metadata_attachment:
        metadata = json.loads(metadata_attachment["metadata_json"] or "{}")
        provider_names = {
            "omdb": "OMDb", "tmdb": "TMDB",
            "musicbrainz": "MusicBrainz",
            "discogs": "Discogs", "lastfm": "Last.fm",
        }
        metadata["metadata_source"] = provider_names.get(
            metadata_attachment["provider"], metadata_attachment["provider"]
        )
        metadata["external_id"] = metadata_attachment["external_id"]
        metadata["refreshed_at"] = metadata_attachment["refreshed_at"]
        metadata_source = {
            "provider": metadata_attachment["provider"],
            "external_id": metadata_attachment["external_id"],
            "refreshed_at": metadata_attachment["refreshed_at"],
        }
    jellyfin_source = None
    if source:
        jellyfin_source = {
            "id": source["id"],
            "item_id": source["jellyfin_item_id"],
            "library_name": source["jellyfin_library_name"],
            "server_url": source["server_url"],
            "action": source["action"],
        }
    return jsonify({
        "collector": collector,
        "metadata": metadata,
        "metadata_source": metadata_source,
        "jellyfin_source": jellyfin_source,
        "sources": {
            "jellyfin": bool(source),
            "physical_media": collector["format"] != "Digital",
            "wishlist": collector["status"] == "Wishlist",
            "upgrade_wanted": collector["status"] == "Upgrade Candidate",
        },
    })


@app.post("/api/media/<int:item_id>/refresh-metadata")
def refresh_media_metadata(item_id: int):
    try:
        enrich_media_item(item_id)
        return media_quick_view(item_id)
    except LookupError as exc:
        return jsonify({"error": str(exc)}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/metadata/refresh-all")
def refresh_all_metadata():
    items = db().execute(
        "SELECT id, title, media_type FROM media "
        "WHERE media_type IN ('Movies', 'Music') "
        "ORDER BY media_type, title"
    ).fetchall()
    result = {
        "processed": 0,
        "enriched": 0,
        "skipped": 0,
        "failed": 0,
        "failures": [],
        "categories": {
            "Movies": {"processed": 0, "enriched": 0, "skipped": 0, "failed": 0},
            "Music": {"processed": 0, "enriched": 0, "skipped": 0, "failed": 0},
        },
    }
    for item in items:
        category = result["categories"][item["media_type"]]
        result["processed"] += 1
        category["processed"] += 1
        try:
            enrich_media_item(item["id"])
            result["enriched"] += 1
            category["enriched"] += 1
        except LookupError as exc:
            result["skipped"] += 1
            category["skipped"] += 1
            result["failures"].append({
                "id": item["id"], "title": item["title"],
                "media_type": item["media_type"],
                "status": "skipped", "error": str(exc),
            })
        except (ValueError, sqlite3.Error) as exc:
            result["failed"] += 1
            category["failed"] += 1
            result["failures"].append({
                "id": item["id"], "title": item["title"],
                "media_type": item["media_type"],
                "status": "failed", "error": str(exc),
            })
    return jsonify(result)


@app.get("/api/jellyfin/image/<item_id>/<image_type>")
def jellyfin_image(item_id: str, image_type: str):
    if image_type not in ("Primary", "Backdrop"):
        return jsonify({"error": "Invalid image type."}), 400
    settings = jellyfin_settings()
    try:
        server_url = normalize_server_url(settings["server_url"])
        if not settings["api_key"]:
            raise ValueError("Jellyfin API key is not configured.")
        url = (
            f"{server_url}/Items/{urllib.parse.quote(item_id)}/Images/{image_type}"
            f"?maxWidth={'1280' if image_type == 'Backdrop' else '500'}&quality=90"
        )
        req = urllib.request.Request(
            url,
            headers={"X-Emby-Token": settings["api_key"], "User-Agent": "MediaVault/1.0"},
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            return Response(
                response.read(),
                content_type=response.headers.get_content_type(),
                headers={"Cache-Control": "private, max-age=3600"},
            )
    except (ValueError, urllib.error.URLError, urllib.error.HTTPError) as exc:
        return jsonify({"error": f"Could not load Jellyfin image: {exc}"}), 404


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
    existing = db().execute(
        "SELECT title, year FROM media WHERE id = ?", (item_id,)
    ).fetchone()
    if existing is None:
        return jsonify({"error": "Item not found."}), 404
    try:
        item = clean_payload(request.get_json(silent=True) or {})
    except (ValueError, TypeError) as exc:
        return jsonify({"error": str(exc)}), 400
    # Identity fields are fixed after creation. Attached providers own display
    # metadata; collector edits must never rewrite title/year implicitly.
    item["title"] = existing["title"]
    item["year"] = existing["year"]
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
        """
        SELECT m.*, ma.provider AS metadata_provider, ma.metadata_json,
               EXISTS(
                   SELECT 1 FROM jellyfin_sources js
                   WHERE js.media_id = m.id
                     AND js.action IN ('attached', 'created')
               ) AS has_jellyfin
        FROM media m
        LEFT JOIN metadata_attachments ma ON ma.media_id = m.id
        ORDER BY m.created_at DESC, m.id DESC LIMIT 5
        """
    ).fetchall()
    return jsonify({**counts, "recent": [row_to_card_dict(row) for row in recent]})


@app.get("/api/sources")
def source_summary():
    connection = db()
    total = connection.execute("SELECT COUNT(*) FROM media").fetchone()[0]
    jellyfin_count = connection.execute(
        "SELECT COUNT(DISTINCT media_id) FROM jellyfin_sources "
        "WHERE media_id IS NOT NULL AND action IN ('attached', 'created')"
    ).fetchone()[0]
    import_count = connection.execute(
        "SELECT COUNT(DISTINCT media_id) FROM catalog_import_links "
        "WHERE media_id IS NOT NULL AND action IN ('attached', 'created')"
    ).fetchone()[0]
    manual_count = connection.execute(
        """
        SELECT COUNT(*) FROM media m
        WHERE NOT EXISTS (
            SELECT 1 FROM jellyfin_sources js WHERE js.media_id = m.id
        ) AND NOT EXISTS (
            SELECT 1 FROM catalog_import_links ci WHERE ci.media_id = m.id
        )
        """
    ).fetchone()[0]
    jellyfin = jellyfin_settings()
    health = connection.execute(
        "SELECT status FROM source_status WHERE source_name = 'Jellyfin'"
    ).fetchone()
    libraries = connection.execute(
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled "
        "FROM jellyfin_libraries"
    ).fetchone()
    last_sync = connection.execute(
        "SELECT MAX(last_sync) FROM jellyfin_libraries"
    ).fetchone()[0]
    last_import = connection.execute(
        "SELECT * FROM catalog_imports ORDER BY created_at DESC LIMIT 1"
    ).fetchone()
    return jsonify({
        "local": {"items": total, "status": "Active"},
        "manual": {"items": manual_count, "status": "Active"},
        "jellyfin": {
            "items": jellyfin_count,
            "status": health["status"] if health else (
                "Configured" if jellyfin["server_url"] and jellyfin["api_key"]
                else "Not Configured"
            ),
            "server_name": jellyfin["server_name"],
            "server_url": jellyfin["server_url"],
            "enabled_libraries": libraries["enabled"] or 0,
            "library_count": libraries["total"] or 0,
            "last_sync": last_sync,
            "auto_sync": auto_sync_enabled(),
            "frequency": auto_sync_frequency(),
        },
        "catalog_import": {
            "items": import_count,
            "status": "Available",
            "last_import": dict(last_import) if last_import else None,
            "formats": ["JSON", "CSV (coming later)"],
        },
    })


@app.get("/api/catalog/export")
def export_catalog():
    connection = db()
    rows = connection.execute("SELECT * FROM media ORDER BY id").fetchall()
    catalog_items = []
    for row in rows:
        collector = row_to_dict(row)
        metadata_row = connection.execute(
            "SELECT provider, external_id, metadata_json, refreshed_at "
            "FROM metadata_attachments WHERE media_id = ?",
            (row["id"],),
        ).fetchone()
        jellyfin_rows = connection.execute(
            "SELECT jellyfin_item_id, jellyfin_library_id, "
            "jellyfin_library_name, source_title, source_year, action "
            "FROM jellyfin_sources WHERE media_id = ?",
            (row["id"],),
        ).fetchall()
        import_rows = connection.execute(
            "SELECT source_key, action FROM catalog_import_links "
            "WHERE media_id = ?",
            (row["id"],),
        ).fetchall()
        metadata = None
        if metadata_row:
            metadata = {
                "provider": metadata_row["provider"],
                "external_id": metadata_row["external_id"],
                "refreshed_at": metadata_row["refreshed_at"],
                "data": json.loads(metadata_row["metadata_json"] or "{}"),
            }
        catalog_items.append({
            "source_key": str(row["id"]),
            "collector": collector,
            "metadata": metadata,
            "sources": {
                "jellyfin": [dict(source) for source in jellyfin_rows],
                "catalog_imports": [dict(source) for source in import_rows],
            },
        })
    payload = {
        "application": "MediaVault",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "version": 1,
        "catalog_items": catalog_items,
    }
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    filename = f"mediavault-export-{datetime.now().date().isoformat()}.json"
    return Response(
        body,
        content_type="application/json; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/catalog/import/preview")
def preview_catalog_import():
    upload = request.files.get("file")
    if not upload or not upload.filename:
        return jsonify({"error": "Choose a MediaVault JSON export file."}), 400
    if not upload.filename.casefold().endswith(".json"):
        return jsonify({"error": "JSON is supported first; CSV is coming later."}), 400
    raw = upload.read(10 * 1024 * 1024 + 1)
    if len(raw) > 10 * 1024 * 1024:
        return jsonify({"error": "Import files must be 10 MB or smaller."}), 400
    try:
        payload = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return jsonify({"error": "The selected file is not valid JSON."}), 400
    incoming = (
        payload.get("catalog_items", []) if isinstance(payload, dict)
        else payload if isinstance(payload, list) else []
    )
    existing = [
        dict(row) for row in db().execute(
            "SELECT id, title, year, media_type, format, status FROM media"
        ).fetchall()
    ]
    preview_items = []
    counts = {"new_items": 0, "matches": 0, "possible_duplicates": 0, "ignored": 0}
    for index, raw_item in enumerate(incoming):
        wrapper = raw_item if isinstance(raw_item, dict) else {}
        collector = wrapper.get("collector", wrapper)
        if not isinstance(collector, dict) or not str(collector.get("title", "")).strip():
            counts["ignored"] += 1
            continue
        title = str(collector["title"]).strip()
        year = collector.get("year")
        media_type = collector.get("media_type", "Other")
        exact = next(
            (
                item for item in existing
                if normalized_title(item["title"]) == normalized_title(title)
                and item["media_type"] == media_type
                and (not year or not item["year"] or year == item["year"])
            ),
            None,
        )
        candidates = sorted(
            (
                (
                    SequenceMatcher(
                        None, normalized_title(title),
                        normalized_title(item["title"]),
                    ).ratio(),
                    item,
                )
                for item in existing if item["media_type"] == media_type
            ),
            key=lambda value: value[0],
            reverse=True,
        )
        if exact:
            category, match, confidence = "matches", exact, 100
        elif candidates and candidates[0][0] >= 0.72:
            category, match = "possible_duplicates", candidates[0][1]
            confidence = round(candidates[0][0] * 100)
        else:
            category, match, confidence = "new_items", None, None
        counts[category] += 1
        preview_items.append({
            "index": index,
            "source_key": str(wrapper.get("source_key", index)),
            "collector": collector,
            "metadata": wrapper.get("metadata"),
            "category": category,
            "match": match,
            "confidence": confidence,
        })
    token = uuid.uuid4().hex
    db().execute(
        "INSERT INTO import_previews(token, filename, payload_json, created_at) "
        "VALUES (?, ?, ?, ?)",
        (
            token, upload.filename,
            json.dumps(preview_items, separators=(",", ":")),
            datetime.now(timezone.utc).isoformat(),
        ),
    )
    db().commit()
    return jsonify({"token": token, "counts": counts, "items": preview_items})


@app.post("/api/catalog/import/apply")
def apply_catalog_import():
    payload = request.get_json(silent=True) or {}
    token = str(payload.get("token", ""))
    index = payload.get("index")
    action = str(payload.get("action", ""))
    if action not in ("create", "attach", "ignore"):
        return jsonify({"error": "Choose create, attach, or ignore."}), 400
    preview = db().execute(
        "SELECT * FROM import_previews WHERE token = ?", (token,)
    ).fetchone()
    if not preview:
        return jsonify({"error": "Import preview expired or was not found."}), 404
    items = json.loads(preview["payload_json"])
    item = next((value for value in items if value["index"] == index), None)
    if not item:
        return jsonify({"error": "Import item was not found."}), 404
    import_id = preview["import_id"]
    now = datetime.now(timezone.utc).isoformat()
    if not import_id:
        cursor = db().execute(
            "INSERT INTO catalog_imports(filename, item_count, created_at) "
            "VALUES (?, ?, ?)",
            (preview["filename"], len(items), now),
        )
        import_id = cursor.lastrowid
        db().execute(
            "UPDATE import_previews SET import_id = ? WHERE token = ?",
            (import_id, token),
        )
    media_id = None
    stored_action = "ignored"
    if action == "attach":
        media_id = payload.get("media_id") or (
            item.get("match") or {}
        ).get("id")
        if not media_id or not db().execute(
            "SELECT 1 FROM media WHERE id = ?", (media_id,)
        ).fetchone():
            return jsonify({"error": "Choose a valid MediaVault item."}), 400
        stored_action = "attached"
    elif action == "create":
        try:
            clean = clean_payload(item["collector"])
        except (ValueError, TypeError) as exc:
            return jsonify({"error": str(exc)}), 400
        columns = ", ".join(clean.keys())
        placeholders = ", ".join("?" for _ in clean)
        cursor = db().execute(
            f"INSERT INTO media ({columns}, created_at, updated_at) "
            f"VALUES ({placeholders}, ?, ?)",
            [*clean.values(), now, now],
        )
        media_id = cursor.lastrowid
        stored_action = "created"
        metadata = item.get("metadata")
        if metadata and metadata.get("provider") and metadata.get("external_id"):
            try:
                db().execute(
                    "INSERT INTO metadata_attachments("
                    "media_id, provider, external_id, metadata_json, "
                    "refreshed_at, created_at) VALUES(?,?,?,?,?,?)",
                    (
                        media_id, metadata["provider"], metadata["external_id"],
                        json.dumps(metadata.get("data") or {}, separators=(",", ":")),
                        metadata.get("refreshed_at") or now, now,
                    ),
                )
            except sqlite3.IntegrityError:
                pass
    try:
        db().execute(
            "INSERT INTO catalog_import_links("
            "import_id, source_key, media_id, action, created_at) "
            "VALUES(?,?,?,?,?)",
            (import_id, item["source_key"], media_id, stored_action, now),
        )
        db().commit()
    except sqlite3.IntegrityError:
        db().rollback()
        return jsonify({"error": "This import item has already been handled."}), 409
    return jsonify({"action": stored_action, "media_id": media_id})


@app.get("/api/settings/jellyfin")
def get_jellyfin_settings():
    settings = jellyfin_settings()
    return jsonify({
        "server_url": settings["server_url"],
        "server_name": settings["server_name"],
        "api_key": "",
        "has_api_key": bool(settings["api_key"]),
    })


@app.get("/api/settings/providers")
def get_provider_settings():
    settings = provider_settings()
    return jsonify({
        "omdb_api_key": "",
        "has_omdb_api_key": bool(settings["omdb_api_key"]),
        "tmdb_api_key": "",
        "has_tmdb_api_key": bool(settings["tmdb_api_key"]),
        "metadata_provider_priority": settings["metadata_provider_priority"],
        "music_provider_priority": settings["music_provider_priority"],
        "discogs_token": "",
        "has_discogs_token": bool(settings["discogs_token"]),
        "lastfm_api_key": "",
        "has_lastfm_api_key": bool(settings["lastfm_api_key"]),
        "rawg_api_key": "",
        "has_rawg_api_key": bool(settings["rawg_api_key"]),
    })


@app.get("/api/source-status")
def get_source_status():
    rows = {
        row["source_name"]: dict(row)
        for row in db().execute("SELECT * FROM source_status").fetchall()
    }
    configurations = source_health_configuration()
    statuses = []
    for name in SOURCE_NAMES:
        statuses.append(rows.get(name) or {
            "source_name": name,
            "status": "Checking" if configurations[name] else "Not Configured",
            "last_checked": None,
            "last_error": "",
        })
    return jsonify(statuses)


@app.post("/api/source-status/refresh")
def refresh_source_status():
    return jsonify(run_source_health_checks())


@app.post("/api/settings/providers")
def save_provider_settings():
    payload = request.get_json(silent=True) or {}
    current = provider_settings()
    values = {
        "omdb_api_key": str(payload.get("omdb_api_key", "")).strip() or current["omdb_api_key"],
        "tmdb_api_key": str(payload.get("tmdb_api_key", "")).strip() or current["tmdb_api_key"],
        "metadata_provider_priority": (
            str(payload.get("metadata_provider_priority", "")).strip()
            if str(payload.get("metadata_provider_priority", "")).strip()
            in ("omdb,tmdb", "tmdb,omdb")
            else current["metadata_provider_priority"]
        ),
        "music_provider_priority": "musicbrainz,discogs,coverartarchive,lastfm",
        "discogs_token": str(payload.get("discogs_token", "")).strip() or current["discogs_token"],
        "lastfm_api_key": str(payload.get("lastfm_api_key", "")).strip() or current["lastfm_api_key"],
        "rawg_api_key": str(payload.get("rawg_api_key", "")).strip() or current["rawg_api_key"],
    }
    db().executemany(
        "INSERT INTO app_settings(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        values.items(),
    )
    db().commit()
    return jsonify({"saved": True})


@app.post("/api/metadata/omdb/test")
def test_omdb_connection():
    try:
        data = omdb_request({"i": "tt0133093", "type": "movie", "plot": "short"})
        return jsonify({"connected": data.get("Response") != "False", "provider": "OMDb"})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/metadata/tmdb/test")
def test_tmdb_connection():
    try:
        data = tmdb_request("/configuration")
        return jsonify({"connected": bool(data.get("images"))})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.get("/api/metadata/tmdb/search")
def search_tmdb_movies():
    query = request.args.get("q", "").strip()
    year = request.args.get("year", "").strip()
    if not query:
        return jsonify({"error": "Enter a movie title to search."}), 400
    params = {
        "query": query,
        "include_adult": "false",
        "language": "en-US",
        "page": 1,
    }
    if year.isdigit():
        params["primary_release_year"] = year
    try:
        response = tmdb_request("/search/movie", params)
        results = []
        for raw in response.get("results", [])[:12]:
            poster_path = raw.get("poster_path") or ""
            release_date = raw.get("release_date") or ""
            results.append({
                "external_id": str(raw.get("id", "")),
                "title": raw.get("title") or "Untitled",
                "year": int(release_date[:4]) if release_date[:4].isdigit() else None,
                "overview": raw.get("overview") or "",
                "rating": raw.get("vote_average"),
                "poster_url": f"https://image.tmdb.org/t/p/w185{poster_path}" if poster_path else "",
                "metadata_source": "TMDB",
            })
        return jsonify(results)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.get("/api/metadata/omdb/search")
def search_omdb_movies():
    query = request.args.get("q", "").strip()
    year = request.args.get("year", "").strip()
    if not query:
        return jsonify({"error": "Enter a movie title to search."}), 400
    params = {"s": query, "type": "movie", "page": 1}
    if year.isdigit():
        params["y"] = year
    try:
        response = omdb_request(params)
        results = []
        for raw in response.get("Search", [])[:12]:
            poster = raw.get("Poster") or ""
            if poster == "N/A":
                poster = ""
            year_text = raw.get("Year") or ""
            results.append({
                "external_id": str(raw.get("imdbID", "")),
                "title": raw.get("Title") or "Untitled",
                "year": int(year_text[:4]) if year_text[:4].isdigit() else None,
                "overview": "Select this result to retrieve the full OMDb record.",
                "rating": None,
                "poster_url": poster,
                "metadata_source": "OMDb",
            })
        return jsonify(results)
    except ValueError as exc:
        if "Movie not found" in str(exc):
            return jsonify([])
        return jsonify({"error": str(exc)}), 400


@app.get("/api/metadata/musicbrainz/search")
def search_musicbrainz_releases():
    album = request.args.get("q", "").strip()
    artist = request.args.get("artist", "").strip()
    year = request.args.get("year", "").strip()
    if not album:
        return jsonify({"error": "Enter an album title to search."}), 400
    safe_album = album.replace('"', r'\"')
    parts = [f'release:"{safe_album}"']
    if artist:
        safe_artist = artist.replace('"', r'\"')
        parts.append(f'artist:"{safe_artist}"')
    if year.isdigit():
        parts.append(f"date:{year}")
    try:
        response = musicbrainz_request(
            "/release/", {"query": " AND ".join(parts), "limit": 12}
        )
        results = []
        for raw in response.get("releases", []):
            date = raw.get("date") or ""
            release_id = raw.get("id") or ""
            release_group = raw.get("release-group") or {}
            results.append({
                "external_id": release_id,
                "title": raw.get("title") or "Untitled",
                "artist": artist_credit_text(raw),
                "year": int(date[:4]) if date[:4].isdigit() else None,
                "overview": ", ".join(filter(None, [
                    raw.get("country"), raw.get("status"),
                    release_group.get("primary-type"),
                ])),
                "rating": None,
                "poster_url": (
                    f"https://coverartarchive.org/release/{release_id}/front-250"
                    if release_id and (raw.get("cover-art-archive") or {}).get("front")
                    else ""
                ),
                "metadata_source": "MusicBrainz",
            })
        return jsonify(results)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.get("/api/metadata/discogs/search")
def search_discogs_releases():
    album = request.args.get("q", "").strip()
    artist = request.args.get("artist", "").strip()
    year = request.args.get("year", "").strip()
    if not album:
        return jsonify({"error": "Enter an album title to search."}), 400
    params = {"release_title": album, "type": "release", "per_page": 12}
    if artist:
        params["artist"] = artist
    if year.isdigit():
        params["year"] = year
    try:
        response = discogs_request("/database/search", params)
        results = []
        for raw in response.get("results", []):
            title = raw.get("title") or "Untitled"
            result_artist, _, album_title = title.partition(" - ")
            results.append({
                "external_id": str(raw.get("id", "")),
                "title": album_title or title,
                "artist": result_artist if album_title else "",
                "year": raw.get("year"),
                "overview": ", ".join(raw.get("format") or []),
                "rating": None,
                "poster_url": raw.get("cover_image") or raw.get("thumb") or "",
                "metadata_source": "Discogs",
            })
        return jsonify(results)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.get("/api/metadata/lastfm/search")
def search_lastfm_albums():
    album = request.args.get("q", "").strip()
    artist_filter = request.args.get("artist", "").strip()
    if not album:
        return jsonify({"error": "Enter an album title to search."}), 400
    try:
        response = lastfm_request({
            "method": "album.search", "album": album, "limit": 12,
        })
        matches = ((response.get("results") or {}).get("albummatches") or {}).get("album") or []
        if isinstance(matches, dict):
            matches = [matches]
        results = []
        for raw in matches:
            artist = raw.get("artist") or ""
            if artist_filter and normalized_title(artist_filter) != normalized_title(artist):
                continue
            images = raw.get("image") or []
            poster = next(
                (image.get("#text") for image in reversed(images) if image.get("#text")), ""
            )
            results.append({
                "external_id": lastfm_external_id(artist, raw.get("name") or album),
                "title": raw.get("name") or album,
                "artist": artist,
                "year": None,
                "overview": "Select to retrieve the full Last.fm album record.",
                "rating": None, "poster_url": poster,
                "metadata_source": "Last.fm",
            })
        return jsonify(results)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/media/<int:item_id>/metadata")
def attach_media_metadata(item_id: int):
    media = db().execute(
        "SELECT media_type FROM media WHERE id = ?", (item_id,)
    ).fetchone()
    if media is None:
        return jsonify({"error": "Item not found."}), 404
    payload = request.get_json(silent=True) or {}
    provider = str(payload.get("provider", "")).casefold()
    external_id = str(payload.get("external_id", "")).strip()
    allowed = (
        ("musicbrainz", "discogs", "lastfm") if media["media_type"] == "Music"
        else ("omdb", "tmdb") if media["media_type"] in ("Movies", "Television")
        else ()
    )
    if provider not in allowed:
        return jsonify({"error": "Choose a supported provider for this media type."}), 400
    try:
        metadata = (
            fetch_musicbrainz_release(external_id)
            if provider == "musicbrainz"
            else fetch_discogs_release(external_id)
            if provider == "discogs"
            else fetch_lastfm_album(external_id)
            if provider == "lastfm"
            else fetch_provider_movie(provider, external_id)
        )
        now = datetime.now(timezone.utc).isoformat()
        db().execute(
            """
            INSERT INTO metadata_attachments (
                media_id, provider, external_id, metadata_json, refreshed_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(media_id) DO UPDATE SET
                provider = excluded.provider,
                external_id = excluded.external_id,
                metadata_json = excluded.metadata_json,
                refreshed_at = excluded.refreshed_at
            """,
            (
                item_id, provider, external_id,
                json.dumps(metadata, separators=(",", ":")), now, now,
            ),
        )
        db().commit()
        return media_quick_view(item_id)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except sqlite3.IntegrityError:
        db().rollback()
        return jsonify({"error": "That TMDB movie is already attached to another catalog item."}), 409


@app.delete("/api/media/<int:item_id>/metadata")
def remove_media_metadata(item_id: int):
    cursor = db().execute(
        "DELETE FROM metadata_attachments WHERE media_id = ?", (item_id,)
    )
    db().commit()
    if cursor.rowcount == 0:
        return jsonify({"error": "This item has no metadata source."}), 404
    return jsonify({"removed": True})


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


@app.get("/api/jellyfin/libraries")
def get_jellyfin_libraries():
    settings = jellyfin_settings()
    if not settings["server_url"]:
        return jsonify({
            "libraries": [], "auto_sync": auto_sync_enabled(),
            "frequency": auto_sync_frequency(), "last_sync": None,
            "last_result": last_sync_summary(),
        })
    rows = db().execute(
        "SELECT * FROM jellyfin_libraries WHERE server_url = ? ORDER BY name",
        (normalize_server_url(settings["server_url"]),),
    ).fetchall()
    last_sync = max(
        (row["last_sync"] for row in rows if row["last_sync"]),
        default=None,
    )
    return jsonify({
        "libraries": [library_to_dict(row) for row in rows],
        "auto_sync": auto_sync_enabled(),
        "frequency": auto_sync_frequency(),
        "last_sync": last_sync,
        "last_result": last_sync_summary(),
    })


@app.post("/api/jellyfin/libraries/refresh")
def refresh_jellyfin_libraries():
    try:
        libraries = discover_jellyfin_libraries()
        sync_result = sync_jellyfin_libraries() if auto_sync_enabled() else None
        if sync_result:
            server_url = normalize_server_url(jellyfin_settings()["server_url"])
            rows = db().execute(
                "SELECT * FROM jellyfin_libraries WHERE server_url = ? ORDER BY name",
                (server_url,),
            ).fetchall()
            libraries = [library_to_dict(row) for row in rows]
        return jsonify({
            "libraries": libraries,
            "auto_sync": auto_sync_enabled(),
            "sync": sync_result,
        })
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.put("/api/jellyfin/libraries")
def update_jellyfin_libraries():
    payload = request.get_json(silent=True) or {}
    settings = jellyfin_settings()
    try:
        server_url = normalize_server_url(settings["server_url"])
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    allowed_categories = set(MEDIA_TYPES)
    for item in payload.get("libraries", []):
        library_id = str(item.get("library_id", ""))
        category = item.get("media_category")
        if category not in allowed_categories:
            category = None
        db().execute(
            """
            UPDATE jellyfin_libraries
            SET enabled = ?, media_category = ?
            WHERE server_url = ? AND library_id = ?
            """,
            (
                1 if item.get("enabled") and category else 0,
                category, server_url, library_id,
            ),
        )
    db().execute(
        "INSERT INTO app_settings(key, value) VALUES('jellyfin_auto_sync', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ("1" if payload.get("auto_sync") else "0",),
    )
    frequency = str(payload.get("frequency", "manual"))
    if frequency not in (
        "startup", "hourly", "six_hours", "daily", "weekly", "manual"
    ):
        frequency = "manual"
    db().execute(
        "INSERT INTO app_settings(key, value) "
        "VALUES('jellyfin_auto_sync_frequency', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (frequency,),
    )
    db().commit()
    return jsonify({"saved": True})


@app.post("/api/jellyfin/sync")
def sync_selected_jellyfin_libraries():
    try:
        return jsonify(sync_jellyfin_libraries())
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/jellyfin/full-refresh")
def full_refresh_jellyfin():
    try:
        discover_jellyfin_libraries()
        sync_result = sync_jellyfin_libraries()
        metadata_result = refresh_all_metadata().get_json()
        return jsonify({
            "sync": sync_result,
            "metadata": metadata_result,
            "last_sync": sync_result["last_sync"],
        })
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
                    "Fields": "Overview,Genres,RunTimeTicks,CommunityRating,People,"
                              "Studios,PremiereDate,ProviderIds,Path,ImageTags,"
                              "BackdropImageTags",
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


_auto_sync_lock = threading.Lock()
_startup_sync_scheduled = False


def run_scheduled_sync() -> None:
    if not _auto_sync_lock.acquire(blocking=False):
        return
    try:
        with app.app_context():
            sync_jellyfin_libraries()
    except Exception:
        app.logger.exception("Scheduled Jellyfin sync failed")
    finally:
        _auto_sync_lock.release()


@app.before_request
def schedule_auto_sync_if_due():
    global _startup_sync_scheduled
    if request.path.startswith("/static/") or not auto_sync_enabled():
        return None
    frequency = auto_sync_frequency()
    if frequency == "manual":
        return None
    summary = last_sync_summary()
    last_sync = None
    if summary and summary.get("last_sync"):
        try:
            last_sync = datetime.fromisoformat(summary["last_sync"])
        except (TypeError, ValueError):
            pass
    now = datetime.now(timezone.utc)
    intervals = {
        "hourly": 3600, "six_hours": 21600,
        "daily": 86400, "weekly": 604800,
    }
    due = False
    if frequency == "startup":
        due = not _startup_sync_scheduled
        _startup_sync_scheduled = True
    elif not last_sync:
        due = True
    else:
        due = (now - last_sync).total_seconds() >= intervals.get(frequency, 86400)
    if due and not _auto_sync_lock.locked():
        threading.Thread(target=run_scheduled_sync, daemon=True).start()
    return None


init_db()

if os.environ.get("MEDIAVAULT_DISABLE_STARTUP_CHECKS") != "1":
    threading.Thread(
        target=run_source_health_checks,
        name="mediavault-source-health",
        daemon=True,
    ).start()

def parse_run_args(args: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the MediaVault web server.")
    parser.add_argument(
        "--https",
        action="store_true",
        help="Serve MediaVault over HTTPS using local cert.pem and key.pem files.",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("HOST", "0.0.0.0"),
        help="Interface to bind (default: 0.0.0.0).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", "5050")),
        help="Port to bind (default: 5050).",
    )
    return parser.parse_args(args)


def run_configuration(args: argparse.Namespace) -> dict:
    configuration = {
        "host": args.host,
        "port": args.port,
        "debug": True,
        "use_reloader": False,
        "ssl_context": None,
    }
    if args.https:
        certificate = BASE_DIR / "cert.pem"
        private_key = BASE_DIR / "key.pem"
        missing = [
            path.name for path in (certificate, private_key) if not path.is_file()
        ]
        if missing:
            raise FileNotFoundError(
                "HTTPS requires cert.pem and key.pem in the MediaVault folder. "
                f"Missing: {', '.join(missing)}"
            )
        configuration["ssl_context"] = (str(certificate), str(private_key))
    return configuration


if __name__ == "__main__":
    run_args = parse_run_args()
    try:
        server_config = run_configuration(run_args)
    except FileNotFoundError as exc:
        raise SystemExit(str(exc)) from exc
    scheme = "https" if run_args.https else "http"
    print(f"MediaVault local server: {scheme}://127.0.0.1:{run_args.port}")
    if run_args.https:
        print(
            "Local HTTPS mode uses a self-signed certificate and is not "
            "production security."
        )
    app.run(**server_config)
