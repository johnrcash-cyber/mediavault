# MediaVault

**Know What You Own.**

A fast, local-first catalog for physical media collections.

## Run locally

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Then open `http://127.0.0.1:5050`. Set `PORT` if you prefer another port.

Collection data is stored in `data/mediavault.db`. Set `MEDIAVAULT_DATABASE` to use a different SQLite file.

## Local HTTPS

MediaVault can bind to the home network over HTTPS for mobile browser features
such as future camera-based UPC scanning.

Generate a local self-signed certificate from the MediaVault directory:

```powershell
openssl req -x509 -newkey rsa:4096 -nodes -out cert.pem -keyout key.pem -days 365
```

Start HTTPS mode:

```powershell
python app.py --https
```

Flask binds to `0.0.0.0` on port `5050`. Open MediaVault from another device at:

```text
https://LOCAL-IP:5050
```

Your browser will warn that the certificate is self-signed. Accept that warning
only for your own trusted local MediaVault server. This mode is for development
and private home networks; it is not production TLS security. Keep `cert.pem`
and especially `key.pem` private. Both files, plus `*.crt` and `*.key`, are
excluded from Git.

Normal HTTP mode remains available:

```powershell
python app.py
```

Open it locally at `http://127.0.0.1:5050`.

## Phase 1 features

- Dashboard counts and recently added items
- Instant title, UPC, tag, and location search
- Filters by media type and collection status
- Add, edit, and remove catalog entries
- Purchase details, physical locations, notes, and tags
- Responsive dark interface for desktop and mobile
- Local SQLite storage

## Jellyfin integration

Open **Settings → Jellyfin**, enter the server URL and an API key, then select
**Test Connection**. MediaVault displays the server and available libraries.

The Phase 1 importer scans movie libraries and groups results into exact matches,
possible matches, and new items. Jellyfin remains an external source: records are
only attached, created, or ignored when you explicitly choose that action.

Selecting a catalog item opens Quick View. Attached Jellyfin metadata—artwork,
overview, genres, runtime, rating, credits, studio, and release date—is read-only
and can be refreshed independently. **Edit** changes only MediaVault-owned
collection, purchase, location, tag, and note fields.

## Metadata enrichment

OMDb is the default movie provider in MediaVault's provider-neutral metadata
layer, with TMDB available as an optional fallback. Configure either provider
under **Settings → Metadata Providers**, choose their priority, then open a movie
and select **Change Metadata Source**. OMDb supplies posters, plots, genres,
runtime, IMDb rating, director, actors, release date, and IMDb ID.

Settings links directly to the official
[OMDb key page](https://www.omdbapi.com/apikey.aspx) and
[TMDB API settings](https://www.themoviedb.org/settings/api). Provider keys are
stored locally by the Flask server and are never returned to the browser.

Provider metadata is stored separately from the catalog record. Refreshing,
changing, or removing a source never overwrites or deletes collector-owned data.
Discogs and RAWG credentials can be stored for future Music and Games enrichment;
OpenLibrary requires no key and is reserved for the Books phase.

Use **Settings → Metadata Providers → Refresh All Metadata** to enrich every
movie and album in provider-priority order. MediaVault tries OMDb first for
movies and MusicBrainz first for albums, requires a safe title/year/artist match,
and reports processed, enriched, skipped, and failed counts by category.
Per-item refresh uses the same priority rules. Jellyfin is displayed only as a
library/source indicator, never as the metadata provider.

Enriched metadata also appears throughout the collection grid and Dashboard
Recently Added cards, including poster art, short summaries, runtime, rating,
provider, and attached source badges. Unenriched items retain MediaVault's
original artwork placeholder.

## Music metadata

Music enrichment follows **MusicBrainz → Discogs → Cover Art Archive → Last.fm**.
MusicBrainz release search and refresh provide album/artist identity, release
year and type, genres, track counts and listings, duration, label, catalog
number, and edition data. Cover Art Archive supplies release-specific covers.
Discogs tokens and Last.fm keys can be configured as additional searchable
providers; Last.fm artist imagery is used when available.

Music Quick View separates provider metadata from MediaVault ownership and shows
the physical/digital format (CD, Vinyl, Cassette, FLAC, or MP3) and Jellyfin as
independent sources. Refreshing or changing a music provider never changes
collector status, purchases, locations, tags, or notes.

Settings is divided into **Metadata Providers** and **Jellyfin Sync** tabs.
Jellyfin-imported albums retain album and artist source hints, allowing either
Quick View **Refresh Metadata** or the bulk refresh tool to locate and attach an
exact MusicBrainz release automatically.

## Jellyfin library sync

The Jellyfin source stores discovered libraries and MediaVault category mappings
for Movies, Television, Music, Books, and Games. The compact Sources card exposes
Configure, Sync Now, Refresh Libraries, and Disable actions without placing the
legacy connection and library-management panels on the Sources landing page.

Movie, series, album, book, and game records are created only when no matching
catalog item exists. Exact matches receive a Jellyfin source attachment without
changing collector fields. Imported albums are Music records and can then be
enriched through MusicBrainz, Discogs, Cover Art Archive, or Last.fm.

The sidebar **Refresh Library** action runs incremental sync without navigating
away from the current view. It reports processed, added, updated, skipped, and
failed items. Incremental sync refreshes Jellyfin source snapshots and fills
missing provider metadata/artwork, but never overwrites collector data or
deletes MediaVault records.

At application startup, a separate background health pass checks Jellyfin,
OMDb, TMDB, MusicBrainz, Discogs, and Last.fm concurrently with three-second
timeouts. Settings shows Online, Offline, or Not Configured status, last checked
time, and the most recent sanitized error. Health checks never trigger sync or
metadata refresh, and provider outages do not block startup or cached catalog
access.

## Sources and catalog portability

Settings treats catalog provenance as **Sources**. MediaVault Local Database is
always present. External cards represent connected instances—not generic source
types—so Jellyfin appears only after it is configured and each completed JSON
import appears as its own import source. With no external instances, Sources
shows a focused empty state. Metadata provider health stays under Metadata
Providers.

Top-level source actions include Add Source, Import Catalog, Export Catalog,
Sync All Sources, and a confirmed Full Refresh. JSON exports contain collector
fields, tags, notes, metadata links, and non-secret source references. API keys
and tokens are never exported.

JSON imports are previewed before applying. Items are grouped as new, exact
matches, possible duplicates, or ignored, and each review decision explicitly
creates an item, attaches an import source, or ignores it. Import attachment
never overwrites existing collector fields. CSV import is reserved for a later
phase.

Add Source currently presents extensible setup placeholders for Jellyfin, Plex,
CSV Import, JSON Import, Discogs, OpenLibrary, Steam, and Manual Collection.
Deleting or disabling a source detaches its connection records but never deletes
MediaVault catalog items.
