# Comm Guide — CAL FIRE Radio

Radio communications reference PWA for Engine 4454 (Skull Creek, TCU).
Live at https://commguide.netlify.app — Netlify publishes this repository automatically on every commit to `main`.

## Files
- `index.html` — app shell and UI.
- `comm-data.js` — radio data (units, channels, tones, repeaters). Plain JS; edit directly.
- `comm-geo.js` — big geodata split out of comm-data.js (SRA grid, unit boundary polygons).
- `dc-runtime.js`, `leaflet.js`, fonts, map marker images — app/runtime assets.
- `incident-core.js`, `incident.js` — Incident (ICS-205) photo import: validation logic and the scan/review screens. Opened from the map menu.
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

## Incident (ICS-205) import
Menu → Incident · ICS-205 → photo of the ICS-205 page. Runs entirely on the phone: finds the ruled table, reads each cell,
reads every frequency three ways and flags disagreements, checks tones/bands/known channels, and never changes a
frequency by itself (suggestions are tap-to-apply). Saved as an `INC` zone (via the existing `ADDZ` mechanism, `incident:true`)
and listed first under Channels. IAP forms are marked CUI — confirm storing them on a personal phone is allowed.
