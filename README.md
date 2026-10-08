# Comm Guide — CAL FIRE Radio

Radio communications reference PWA for Engine 4454 (Skull Creek, TCU).
Live at https://commguide.netlify.app — Netlify publishes this repository automatically on every commit to `main`.

## Files
- `index.html` — app shell and UI.
- `comm-data.js` — all radio data (units, zones, channels, tones, repeaters). Plain JS; edit directly.
- `dc-runtime.js`, `leaflet.js`, fonts, map marker images — app/runtime assets.
- `sw.js` — service worker (offline launch + map tile cache).
- `manifest.json`, `icon-192.png`, `icon-512.png` — home-screen install.
- `netlify.toml`, `_headers` — Netlify settings (no post-processing; `sw.js` and `index.html` never cached).

## Updating
- **Bump `APP` in `sw.js` (e.g. `cg-app-v18` → `cg-app-v19`) on every change** so installed phones drop the old offline copy.
- Data rule: every frequency, tone, coordinate and identifier must come from a verified source
  (CAL FIRE Statewide Radio Call Plan, FCC ULS, GNIS) or the crew's direct input. Unverified sites stay `null`.
- React, ReactDOM and Babel load from unpkg.com and are cached by the service worker after first launch.
