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
movie in provider-priority order. MediaVault tries OMDb first by default, falls
back to TMDB when configured, requires a safe title/year match, and reports
processed, enriched, skipped, and failed counts. Per-item refresh uses the same
priority rules. Jellyfin is displayed only as a library/source indicator, never
as the metadata provider.

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
