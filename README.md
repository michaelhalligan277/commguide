# Comm Guide — CAL FIRE Radio

Radio communications reference PWA for Engine 4454 (Skull Creek, TCU).
Live at https://commguide.netlify.app — Netlify publishes this repository automatically on every commit to `main`.

## Files
- `index.html` — app shell and UI.
- `comm-data.js` — radio data (units, channels, tones, repeaters). Plain JS; edit directly.
- `comm-geo.js` — big geodata split out of comm-data.js (SRA grid, unit boundary polygons).
- `dc-runtime.js`, `leaflet.js`, fonts, map marker images — app/runtime assets.
- `incident-core.js`, `incident.js` — Incident (ICS-205 / ICS-204) photo import: validation logic and the scan/review/division screens. Opened from the map menu.
- `vendor/ocr/` — Tesseract.js reader (about 11 MB), cached separately on the phone (`cg-ocr-v1`) so app updates don't re-download it.
- `sw.js` — service worker (offline launch + map tile cache).
- `manifest.json`, `icon-192.png`, `icon-512.png` — home-screen install.
- `netlify.toml`, `_headers` — Netlify settings (no post-processing; `sw.js` and `index.html` never cached).
- `_redirects` — blocks `/reference/*` from the public site (returns 404).
- `reference/` — source documents for verifying data. **Not published.**
  - `CAL_FIRE_Radio_Call_Plan_v2023.1.pdf` — CAL FIRE Statewide Radio Call Plan, Version 2023.1 (173 pp).
    Note: the app's channel data is the Statewide Load V25A6 Rev 03/08/25, a separate document.

## Updating
- **Bump `APP` in `sw.js` (e.g. `cg-app-v23` → `cg-app-v24`) on every change** so installed phones drop the old offline copy.
- Data rule: every frequency, tone, coordinate and identifier must come from a verified source
  (CAL FIRE Statewide Radio Call Plan, FCC ULS, GNIS) or the crew's direct input. Unverified sites stay `null`.
- React and ReactDOM are vendored in `vendor/` (no CDN needed); `babel.min.js` is only loaded if a JSX x-import is ever used. Large geodata (SRA grid, unit boundaries) lives in `comm-geo.js` and loads on demand.

## Incident import (ICS-205 and ICS-204)
Menu → Incident · ICS-205 / 204 → photo of the page (the app tells which form it is, and which way up). Runs entirely on the
phone: finds the ruled tables, reads each cell, reads frequencies and key identifiers several ways and flags disagreements,
checks tones/bands/known channels, and never changes a frequency by itself (suggestions are tap-to-apply).
- **ICS-205** → `INC` zone (via the existing `ADDZ` mechanism, `incident:true`, `incKind:'ics205'`), listed first under Channels.
- **ICS-204** → a division screen (operations personnel/overhead, resources grouped by request type with a personnel total
  that is checked against the printed count, work assignments, special instructions, channels) and a `DIV` zone
  (`incKind:'ics204'`, one per division). A channel that differs from the same-named one on the saved ICS-205 is flagged, never merged.
- Storage: `cg_incident_v1` = `{meta, rows (205), divs:[…], savedAt}`; zones live in `cg_overrides_v1.ADDZ.HOME`.
- A sheet for a different incident than the one saved asks before replacing everything. IAP forms are marked CUI — confirm
  storing them on a personal phone is allowed.
