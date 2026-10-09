# Comm Guide — CAL FIRE Radio

Radio communications reference PWA for Engine 4454 (Skull Creek, TCU).
Live at https://commguide.netlify.app — Netlify publishes this repository automatically on every commit to `main`.

## Files
- `index.html` — app shell and UI.
- `comm-data.js` — radio data (units, channels, tones, repeaters). Plain JS; edit directly.
- `comm-geo.js` — big geodata split out of comm-data.js (SRA grid, unit boundary polygons).
- `dc-runtime.js`, `leaflet.js`, fonts, map marker images — app/runtime assets.
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
