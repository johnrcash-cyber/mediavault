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
