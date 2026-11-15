# SatIdentifier — Architecture Contract

The inverse of [SatObserver-MX](../satobserver): instead of asking *where is this
satellite*, it asks **who is in my field of view**. Given a site, an epoch and a
timespan, a pointing (RA/Dec J2000 or Alt/Az) and a field of view, it finds every
catalogued object that crosses that field, draws them on a gnomonic sky chart, and
draws the trail each would leave across the field — so an unidentified trail on a
real frame can be matched against the list.

Local Python backend (TLE/catalogue fetching + persistence, stdlib only) + browser
frontend (SGP4 in Web Workers, canvas chart). This document is the **binding
contract** between modules. Every module MUST expose exactly the API written here and
MAY rely on every other module exposing exactly its API. Plain ES2020 browser JS, **no
build step, no ES modules** — each file is a classic `<script>` attaching to the global
`SAT` namespace. No external network access from the frontend except the local backend.

Namespace stays `SAT` (not `SATID`) so modules ported from SatObserver work unchanged.

## File layout

```
/Users/mickey/sda/satidentifier/
  server.py                  # backend: static file server + JSON API (stdlib only)
  desktop.py                 # pywebview shell (native window), ~27 lines, as SatObserver
  SatIdentifier.command      # double-click dev launcher
  tools/make_starcat.py      # one-shot: build assets/stars_m9.bin from Tycho-2 (dev only)
  app/
    index.html               # loads CSS + scripts in fixed order (see below)
    css/app.css
    assets/stars_m9.bin      # deep star catalogue, ~120k stars to V=9.0 (binary, ~1.4 MB)
    js/vendor/satellite.min.js   # satellite.js 5.0 UMD -> global `satellite`
    js/vendor/starcat.js         # bright stars + constellation lines/names (from SatObserver)
    js/vendor/mwdata.js          # Milky Way isophotes -> SAT.mwdata (All-Sky only since round 20)
    js/util.js               # SAT.util      (port from SatObserver + additions)
    js/frames.js             # SAT.frames    NEW  (AGENT F)
    js/windows.js            # SAT.windows   (port, unchanged)
    js/clock.js              # SAT.clock     (port, unchanged)
    js/propagate.js          # SAT.prop      (port, trimmed)
    js/state.js              # SAT.state, SAT.bus
    js/stars.js              # SAT.stars     NEW  (AGENT S)
    js/photometry.js         # SAT.photo     NEW  (AGENT P)
    js/scan.js               # SAT.scan      NEW  (AGENT E)
    js/worker/scan-worker.js # worker-side scan engine (AGENT E)
    js/sources.js            # SAT.ui.sources   (port)
    js/locations.js          # SAT.ui.locations (port, unchanged)
    js/satinfo.js            # SAT.ui.satinfo   (port + extend)
    js/pointing.js           # SAT.ui.pointing  NEW  (AGENT I)
    js/chart.js              # SAT.chart        NEW  (AGENT C) — main view
    js/crossings.js          # SAT.ui.crossings NEW  (AGENT T) — main list
    js/allsky.js             # SAT.allsky       (port of skychart.js, context view)
    js/main.js               # boot
  data/                      # backend persistence (state.json, config.json, cache/)
```

`index.html` script order: vendor libs, then `util, frames, windows, clock, propagate,
state, stars, photometry, scan, sources, locations, satinfo, pointing, chart,
crossings, allsky, main`. `window.SAT = {ui:{}}` is created inline in index.html before
any script loads.

## Conventions

- Angles at module boundaries are **degrees** (suffix `Deg`); longitude normalized to
  **[-180, 180]**; RA in **[0, 360)**; position angles measured **north through east**.
- Small angles in tables/readouts may be arcmin (`Am`) or arcsec (`As`) — always
  suffixed. Angular **rates are arcsec/s** (`AsPerS`).
- Altitudes: satellite height in **km**, ground station altitude in **m**, ranges in **km**.
- Times are JS `Date` objects (internally UTC); millisecond epochs are `*Ms`.
  Display format `YYYY-MM-DD HH:MM:SS`.
- **All catalogue and chart RA/Dec are J2000 mean equinox** unless a field is
  explicitly named `*OfDate`. Alt/Az is *apparent* (refracted) when
  refraction is always applied (round-2 review removed the toggle: an Alt/Az
  pointing is what the telescope points at, which is apparent by definition).
  `SAT.frames` keeps the `{refract}` option so tests can reach the geometric path.
- Colors are CSS hex strings, e.g. `"#ffcc00"`.
- Every module is defensive: an object whose SGP4 propagation fails at a given time is
  silently skipped (no throws in render or scan loops).

## Performance decisions (measured, not assumed — do not re-litigate without new numbers)

Benchmarked 2026-07-21 on this machine, node 25, satellite.js 5.0, real CelesTrak
`GROUP=active` catalogue (16 056 objects), in
`scratchpad/bench.js`:

```
init:      16 056 satrecs in 106 ms          (6.6 us each, ONE TIME)
propagate: 321k propagations in 196 ms       (0.61 us each)
hot loop:  9.2 ms per coarse step over 16 056 objects
           (propagate + topocentric vector + horizon + dot-product separation)
```

Extrapolated to a 27 000-object catalogue, before any geometric cull:

| Scan | Coarse steps | 1 thread | 6 workers |
|---|---|---|---|
| 10 min @ 30 s | 20 | 0.3 s | 0.1 s |
| 1 h @ 30 s | 120 | 1.9 s | 0.3 s |
| 6 h @ 30 s | 720 | 11.1 s | 1.9 s |
| 24 h @ 60 s | 1440 | 22.2 s | 3.7 s |

**Decision: satellite.js, no WebAssembly.** A WASM port of Bill Gray's `sat_code`
(assessed: 4–6 self-contained files, no malloc/stdio, fully re-entrant, caller-owned
`params` — a genuinely clean port) would buy perhaps 3× on a stage that already costs
0.3 s for the common case. It would cost an emscripten toolchain dependency, a build
step, a committed binary artifact, and `-fno-strict-aliasing` care around
`sgp4.cpp`'s int-punned-through-double `simple_flag`. Not worth it.

**Revisit only if** a measured full-catalogue 24 h scan exceeds ~10 s on 6 workers,
or the catalogue grows past ~100 k objects. The structural optimisations below are
worth far more than the language, and they are what the budget above already assumes.

**Round 22 — new numbers, as that rule asks.** By 2026-11 the catalogue was
32 912 objects and long scans had drifted past the table above: measured single
thread, the round-21 engine took 7.7 s for 6 h and **31–34 s for 24 h**, 80–90% of
it stage 2 propagating every survivor at every step. The answer was again
structural, not the language: stage 2 now **skips** every stretch in which an
object provably cannot reach the field (see "Algorithm"), and stage 3 walks the
field boundary instead of sampling a grid. Same machine, same catalogue, single
thread, thirteen scenarios (`scratchpad/bench.js`):

| Scan | round 21 | round 22 | propagations |
|---|---|---|---|
| 1.5°×1° frame, 30 min | 0.13 s | 0.05 s | 0.10 M → 0.01 M |
| 15°×10° frame, 1 h | 1.1 s | 0.11 s | 1.41 M → 0.10 M |
| 2°×1.5°, 6 h | 7.7 s | 0.33 s | 12.0 M → 0.55 M |
| 5° parked mount, 6 h | 11.0 s | 0.48 s | 16.4 M → 0.78 M |
| GEO belt 3°×2°, 24 h @ 60 s | 30.8 s | 2.6 s | 45.3 M → 4.5 M |
| GEO stare 2°, 24 h @ 60 s | 34.5 s | 2.0 s | 44.6 M → 3.7 M |
| LVLH 10°×10° from orbit, 90 min | 9.7 s | 0.45 s | 17.2 M → 0.68 M |
| all thirteen | **106 s** | **7.2 s** | |

3–10% of the fixed grid is actually propagated. `scan.js`'s estimate charges 10%
(`SKIP_FRACTION`), so the 60 M refusal limit now corresponds to ten times the
span it used to.

### Structural rules for the hot loop (from Bill Gray's `sat_id`)

These are the difference between the table above and something 50× slower:

1. **Init once, propagate many.** `sat_id` hoists `SGP4_init` outside its object loop.
   Build every satrec **once when the catalogue loads** (106 ms for 16 k) and never
   again — not lazily per scan, not per time step. `_satrec` lives for the session.
2. **Rotate the pointing, not the catalogue.** Convert the FOV centre J2000 → TEME
   **once per epoch** and compare in TEME. Never convert 27 000 satellite vectors to
   J2000 inside the loop. Only the handful of confirmed crossings are converted to
   J2000, at the end, for display. This is worth more than everything else combined,
   and it has the happy side effect of keeping precession out of the hot loop
   entirely — see the accuracy note below.
3. **No trig in the cull.** Test separation as a dot product against
   `cos(margin)`, and the horizon as `dot(topoVec, siteVec) > 0`. No `acos`, no
   `atan2`, no `sqrt` beyond the one range. `acos` at 27 000 × N steps is not free.
4. **Everything JD-keyed is computed once per epoch**: GMST, the site's TEME vector,
   the pointing's TEME vector, the Sun vector for the shadow test, the precession
   matrix. `sat_id` memoises `lunar_solar_position` on JD for exactly this reason.
5. **Call `satellite.sgp4(satrec, tsinceMinutes)` directly**, not
   `satellite.propagate(satrec, date)` — the latter re-derives minutes-since-epoch
   from a `Date` on every call. Precompute `tsince` per epoch per satellite.

## Why `SAT.frames` exists (read this before touching coordinates)

SatObserver only ever needed alt/az and sub-points, so it used satellite.js's
TEME→ECEF (`gstime`) path and never worried about equinox. This tool reports **RA/Dec
to arcminute precision against a star field**, so the following are mandatory:

- **TEME is not J2000.** satellite.js SGP4 returns True Equator Mean Equinox of date.
  Precession since J2000 is ≈ 0.36° in 2026 — 20× a typical telescope FOV. Reporting
  TEME as J2000 would be the single largest error in the tool.
- **Refraction** is ~1.7′ at 30° elevation and ~5′ at 10°. When the user gives an
  Alt/Az pointing they mean where the *telescope points*, i.e. apparent; when they
  compare against a star field they need geometric. Convert explicitly.
- **Topocentric parallax** is handled implicitly (we always difference against the
  observer's geocentric position vector) — never use geocentric satellite RA/Dec.
- **Light time IS applied (round 22); aberration is not.** Every reported and
  drawn direction is the **astrometric place**: the observer at the instant of
  reception, the satellite where it was `ρ/c` earlier — to first order
  `r − v·ρ/c`, which is exact to a micrometre at these speeds. The displacement is
  `v⊥/c`: **5″ for LEO whatever the range, 2″ for GEO** (the round-1 note here
  said "≤ 0.005″ of motion", which was the Earth's rotation during the light
  time, not the satellite's own travel — the satellite moves 7.7 km/s, not
  0.46). It costs nothing and it is a systematic along-track bias.
  **Aberration** — annual (≤ 20.5″), diurnal (≤ 0.3″), and an orbit site's own
  (≤ 5″) — is applied to neither satellites nor stars: it displaces a satellite
  and the stars around it alike, star positions are left at catalogue J2000 mean
  places, and so chart and satellites stay mutually consistent. Astrometric place
  is also exactly what a plate solution against catalogue stars returns for a
  measured streak. Say so in the Help window; do not "fix" aberration on one
  side alone. `SAT.prop.look(…, {lightTime:false})` gives the geometric
  direction, for tests against satellite.js's own look angles only.

### Precession — the specific ways this goes wrong

Bill Gray rewrote his own precession code twice; the reasons are documented in
`lunar/precess.cpp` and are worth obeying rather than rediscovering.

1. **Only ever build the matrix J2000 → date, and transpose it to invert.** Do not
   use the general "precess from t1 to t2" cubic polynomials (the form in the
   deprecated `lunar/precess2.cpp`). Those are not self-inverse: precessing forward
   then back does not return the original vector, and the error grows with span.
   `frames.js` therefore exposes one primitive, `precessionMatrix(date)` meaning
   J2000 → mean-of-date, and every other direction is its transpose. This makes
   `j2000ToTeme(temeToJ2000(v, t), t) === v` exact to rounding, which is a test.
2. **Use the equatorial IAU-1976 form, and say so in a comment.** The ecliptic form
   is more stable over millennia (the equatorial cubic terms are ~600× larger and
   diverge), and Bill Gray recommends it for long spans — but for near-term epochs
   he notes the equatorial form is preferred, and the two differ by only about a
   nanoradian per 3 years from J2000, i.e. **~2 milliarcsec in 2026**. Irrelevant
   here. Comment it so nobody "fixes" it later thinking the ecliptic form is a bug.
   Polynomials, arcsec, `t` = Julian centuries TT from J2000:
   `ζ = t(2306.2181 + t(0.30188 + 0.017998t))`,
   `z = t(2306.2181 + t(1.09468 + 0.018203t))`,
   `θ = t(2004.3109 + t(−0.42665 − 0.041833t))`.
3. **TEME is not true-equinox-of-date.** The chain is
   `TEME --R3(−Eq_eq)--> TOD --N^T--> MOD --P^T--> J2000`.
   The *sign* of the equation-of-equinoxes step is not a matter of taste: TEME→PEF
   uses GMST (the SGP4 convention satellite.js implements) while TOD→PEF uses
   GAST = GMST + Eq_eq, so `R3(GMST)·v_TEME = R3(GAST)·v_TOD` forces
   `v_TOD = R3(−Eq_eq)·v_TEME`. The cross-check test below verifies it.
   Bill Gray's `sat_id` skips the equation of the equinoxes entirely and uses a
   linear-rate precession approximation (`observe.cpp:80`), fine at his 4° search
   radius. **Eq_eq reaches ±1.15 seconds of time — that is ±17″ of arc, not ±1.1″**;
   the seconds-of-time/arcsec confusion is easy to make and this document made it
   once. We do the full rotation because our FOV boundary is the answer, not a
   loose filter.
4. **Time scales.** Precession and nutation take TT; GMST takes **UT1**.

### Accuracy budget — be honest about which term dominates

| Term | Magnitude | Applied? |
|---|---|---|
| TLE position error (fresh → 1 week old) | ~1–20 km ⇒ **7′–2°** at 500 km range | irreducible |
| **UT1−UTC (DUT1) ignored** | ≤ 0.9 s ⇒ 0.42 km site shift ⇒ **≤ 2.9′** | optional `dut1S` setting, default 0 |
| Refraction (if toggled off) | 1.7′ at El 30°, 5′ at El 10° | user's choice |
| Annual aberration | ≤ 20.5″ | no (consistently, both sides) |
| Precession + nutation, done properly | < 1″ | **yes** |
| Equatorial vs ecliptic precession form | ~2 mas | irrelevant |
| Light time (satellite's travel during ρ/c) | 5″ LEO, 2″ GEO | **yes** (round 22) |
| Diurnal aberration | < 0.3″ | no (consistently, both sides) |

So: **`frames.js` must not be the dominant error, and it easily is not.** The claim
to make in the UI is "arcsecond-level frame handling; arcminute-level truth, limited
by TLE age" — never "arcsecond accuracy". Expose `dut1S` in settings because it is
the largest term we could remove and choose not to by default.

### Mandatory verification (`frames.js` ships with these or it is not done)

- **Round trip**: `j2000ToTeme(temeToJ2000(v, t), t)` matches `v` to < 1e-12 for a
  spread of dates. Guaranteed by construction if rule 1 is obeyed — so it is really
  a test that rule 1 was obeyed.
- **Cross-check against the well-tested path**: for a real satellite, compute alt/az
  two ways — (a) satellite.js `eciToEcf(teme, gmst)` → `ecfToLookAngles`, the path
  SatObserver has used all along, and (b) `temeToJ2000` → `raDecToAltAz` with
  refraction off. **They must agree to < 1″.** This single test catches sign errors
  in the equation of the equinoxes, nutation or precession, wrong units, and a
  GMST/GAST mix-up. It needs no external data.
- **Absolute sanity**: precessing the J2000 vernal equinox to 2026.5 must move it by
  ≈ 0.363°, and a known star's J2000 → mean-of-date offset must match a published
  value to < 1″.

## SAT.bus — event bus (in state.js)

`SAT.bus.on(event, fn)`, `SAT.bus.off(event, fn)`, `SAT.bus.emit(event, payload)`.

Events (payloads):
- `'time'` `{date: Date, jumped: bool}` — every animation tick from the clock.
- `'obs-changed'` `{field: string}` — pointing / FOV / timespan edited.
  Consumers redraw; `SAT.scan` marks its result **stale** but does not auto-rerun.
- `'scan-started'`, `'scan-progress'` `{done, total, phase:'coarse'|'fine'}`,
  `'scan-done'` `{count, ms, truncated: bool}`, `'scan-failed'` `{error}`.
- `'catalog-changed'` — the loaded object set changed (sources window updated it).
- `'locations-changed'` — site list / active flag changed.
- `'selection-changed'` `{satId: string|null}`.
- `'filters-changed'` — crossing display filters changed (no rescan needed).
- `'settings-changed'` `{section: string}`.
- `'state-loaded'` — initial state restored from backend; rebuild UI.

## SAT.state (state.js)

Data (JSON-serializable, persisted to backend `/api/state` debounced 800 ms):

```js
SAT.state.obs = {
  mode: "radec",            // "radec" | "altaz"
  raDeg: 83.822, decDeg: -5.391,      // J2000, used when mode === "radec"
  azDeg: 180, elDeg: 60,              // apparent, used when mode === "altaz"
  track: "sky",             // "sky" = field fixed on the celestial sphere (sidereal
                            //   tracking); "mount" = field fixed in alt/az (parked /
                            //   drift scan). Default "sky" in radec, "mount" in altaz.
  fovShape: "rect",         // "rect" | "circ"
  fovWDeg: 1.5, fovHDeg: 1.0,         // rect: full width/height on sky
  fovRDeg: 0.75,                      // circ: radius
  rotDeg: 0,                // position angle of chart +Y (up), north through east
  flipEW: false,            // mirror the chart (odd number of reflections)
  spanMin: 60,              // scan timespan, minutes, starting at the clock time
  dut1S: 0                  // UT1-UTC seconds; 0 unless the user cares about 2.9'
}
// refraction left obs in round 2: always applied, never a per-observation choice.
// exposureS / plateScaleAsPerPx were removed in the round-1 review: the trail
// across the FOV (path + entry/exit + rate + duration) is the identification
// tool, and a separate per-exposure streak length duplicated it while demanding
// a plate scale the user did not want to supply.

SAT.state.filters = {
  maxMag: 14,               // estimated visual magnitude cut; 99 = off
  sunlitOnly: false,        // drop eclipsed objects
  minElDeg: 0,              // horizon cut applied during the scan
  classes: { leo:true, meo:true, geo:true, heo:true },
  types: { "PAY":true, "R/B":true, "DEB":true, "UNK":true },  // SATCAT object type;
                            // typeless objects sit in UNK so they never vanish silently
  minAltKm: 0, maxAltKm: 0, // geodetic height at closest approach; 0 = no limit
  maxRateAsPerS: 0, minRateAsPerS: 0   // 0 = no limit
}

SAT.state.catalog = {       // the object set the scan runs against — a MERGED set
  objs: [ObjEntry, ...], count: N, bad: N,
  sources: {                // per-source rehydrate refs + presence
    spacetrack: [{source, fetched, cacheKey}, ...],   // most recent last, capped 8
    mccants:    [{source, fetched, cacheKey}, ...],
    paste:      {fetched} | null,
  }
}
// ObjEntry — deliberately flat and small; ~27k of these live in memory
{ id: "o_25544", norad: 25544, name: "ISS (ZARYA)", intl: "1998-067A",
  l1: "1 25544U ...", l2: "2 25544U ...",
  rcs: 399.05,            // m^2 from SATCAT, or null (absent above NORAD 50000)
  type: "PAY",            // SATCAT OBJECT_TYPE: PAY | R/B | DEB | UNK, or null
  stdMag: -1.3,           // McCants qsmag standard magnitude, or null
  src: "spacetrack" }     // 'spacetrack' | 'mccants' | 'paste' — drives per-source stats
// non-persisted runtime fields (stripped on save): _satrec, _satrecBad.
// Deduplicated by NORAD across sources, NEWEST TLE EPOCH WINS regardless of
// source — so after a collision the owning src reflects whose elements are
// fresher, and the per-source statistics count final ownership, not loads.
// Cached sources are NOT written into state.json (too large): they re-hydrate
// from /api/cache/<cacheKey> via catalogRefs. Pasted TLEs have no server cache,
// so they persist inline as `pasted` (capped 2000 — paste means a handful).

SAT.state.locations = [{ id, name, kind, latDeg, lonDeg, altM, norad, active: false, color }]
// kind: 'ground' (default — a missing kind IS 'ground', so pre-v0.2 saves need no
// migration) | 'orbit'. An orbit site observes from a catalogue object: `norad`
// names it, and the TLE is RESOLVED FROM THE LOADED CATALOGUE at use time — the
// site never stores element lines of its own, so it can never silently go stale
// relative to the catalogue it identifies against. latDeg/lonDeg/altM stay 0 on
// orbit sites (numeric, so a missed ground-only code path degrades, not throws).
// state.resolvedSite(loc?) is the ONE resolution point: ground sites pass through;
// orbit sites come back with {l1, l2, objName} attached, or {missing:true} when the
// catalogue lacks the NORAD — callers show that, they do not guess.

SAT.state.settings = {
  chart:  { stars:true, starNames:false, constLines:true, constNames:false,
            sunMoon:true, grid:true, magAuto:true, magLimit:9.0,
            labels:true, tracks:true, padFrac:0.7 },
  // round 14: magAuto (default true) makes the chart's star depth follow the view
  // span (see the chart section); magLimit is the pinned MANUAL limit, used only
  // when magAuto is false. Old saved states lack magAuto and so pick up the
  // adaptive default on first load — that migration is deliberate.
  // round 20: chart.mw retired — the chart has no Milky Way layer any more (the
  // glow lives only in the All-Sky panel); a stored chart.mw is ignored.
  // tracks (default true) draws the satellite trails; off leaves markers+labels.
  allsky: { eastLeft:true, elStep:30, stars:true, sunMoon:true, mw:false },
  // round 12: allsky.magLimit retired — the All-Sky star field is the bright
  // catalogue only (see its panel section); a stored value is ignored.
  scan:   { coarseStepS:30, fineStepS:1.0, marginDeg:0 /*0 = auto*/,
            workers:0 /*0 = auto: hardwareConcurrency-1, capped 8*/,
            maxCrossings:5000 },
  layout: { <windowId>: {x,y,w,h,open} }   // maintained by SAT.windows
}

SAT.state.scan = {          // runtime only, not persisted
  crossings: [Crossing, ...], ranAt: Date|null, stale: bool, params: {...}
}
SAT.state.selection = { satId: null }
```

Methods:
- `activeLocation() -> location|null`
- `getObj(id) -> ObjEntry|null`, `objByNorad(n) -> ObjEntry|null`
- `setSelection(satId|null)` / `clickSelect(satId|null)` — emit `'selection-changed'`.
- `visibleCrossings() -> Crossing[]` — `scan.crossings` after applying
  `SAT.state.filters`. **The single filter point.**
- `chartCrossings() -> Crossing[]` — `visibleCrossings()` narrowed to the rows
  ticked in the Crossings table (`scan.checked`, a runtime Set cleared on every
  new scan) when any are ticked. The chart and all-sky view draw THIS; the table
  keeps listing `visibleCrossings()` so boxes can still be unticked.
- `setObs(patch)` — merge into `obs`, normalize (wrap RA, clamp Dec/El, keep
  `fovWDeg/fovHDeg` > 0), mark `scan.stale = true`, emit `'obs-changed'`, `save()`.
- `addTles(tag, payload, {replace}) -> {count, bad, added, updated}` — merge a
  TlePayload into the catalogue under `tag` ('spacetrack'|'mccants'|'paste') and
  build every satrec up front. `replace:true` drops the tag's previous objects
  first (Load-full-catalogue semantics); otherwise additive (queries, successive
  files, successive pastes). Emits `'catalog-changed'`.
- `clearSource(tag)` — remove everything a source contributed.
- `sourceStats() -> {tag: {count, newestD, medianD, oldestD}}` — TLE-epoch ages in
  days **against the sim clock** (scanning yesterday's exposure against today's
  ages would misstate every number); tags with no objects are absent.
- `save()` — debounced push to backend. Call after ANY mutation.
- `load() -> Promise` — restore state, replay `catalogRefs` through `addTles`, then
  restore `pasted`, then emit `'state-loaded'`.

## SAT.frames (frames.js) — AGENT F

Pure functions, no state. Accuracy target **better than 1 arcsec** for every
transformation below; it must never be the dominant error.

- `jdTT(date) -> number` — Julian Date in TT (TAI+32.184 s; UTC→TAI uses a built-in
  leap-second table through 2026, extrapolate flat and note it).
- `gmstRad(date) -> number`, `gastRad(date) -> number` (GMST + equation of equinoxes).
- `precessionMatrix(date) -> M[3][3]` — IAU-1976, J2000 → mean of date (zeta, z,
  theta polynomials).
- `nutation(date) -> {dPsiRad, dEpsRad, epsARad}` — IAU-1980 truncated to the 20
  largest terms (≤ 0.05″ residual).
- `temeToJ2000(v, date) -> {x,y,z}` — TEME of date → J2000 mean equinox. This is
  `P^T · N^T · R3(+eqeq)` applied to `v`. **Every satellite RA/Dec in this app goes
  through here.** Inverse: `j2000ToTeme(v, date)`.
- `siteEcefKm(loc) -> {x,y,z}` — WGS-84 geodetic → ECEF, using `altM`.
- `siteTemeKm(loc, date) -> {x,y,z}` — the above rotated by GAST (not GMST — TEME's
  x-axis is the *uniform* equinox; use `gmstRad` here to match satellite.js's own
  convention and stay self-consistent with `SAT.prop`).
- `topoTeme(loc, satTemeKm, date) -> {x,y,z}` — satellite minus site, in TEME.
- `vecToRaDec(v) -> {raDeg, decDeg, rKm}` and `raDecToVec(raDeg, decDeg) -> {x,y,z}` (unit).
- `raDecToAltAz(raDeg, decDeg, loc, date, {refract:bool}) -> {azDeg, elDeg}` — J2000
  → alt/az. Applies precession/nutation to date, hour angle from GAST + longitude,
  then refraction if requested.
- `altAzToRaDec(azDeg, elDeg, loc, date, {refract:bool}) -> {raDeg, decDeg}` — inverse.
- `refractionDeg(elDeg, {tempC=10, pressureMb=1010}) -> number` — Bennett's formula
  with the Sæmundsson inverse; returns 0 below −1° elevation.
- `sep(ra1, dec1, ra2, dec2) -> Deg` — Vincenty great-circle (stable at small angles).
- `posAngle(ra1, dec1, ra2, dec2) -> Deg` — of point 2 from point 1, N through E.
- `sunJ2000(date) -> {raDeg, decDeg, rAu}`, `sunTemeKm(date) -> {x,y,z}` — low
  precision (±0.01°), enough for phase angle and eclipse.
- `moonJ2000(date) -> {raDeg, decDeg, rKm}` — ±0.3°, used for a moon marker + a
  "moon separation" column.

### Gnomonic projection (also in frames.js)

- `SAT.frames.tanProject(raDeg, decDeg, ra0, dec0) -> {xi, eta} | null` — standard
  coordinates in **degrees**, xi east, eta north; `null` when the point is more than
  90° from the tangent point.
- `SAT.frames.tanDeproject(xi, eta, ra0, dec0) -> {raDeg, decDeg}` — inverse.

The chart then applies rotation and E/W flip on top of `{xi, eta}` — projection and
orientation stay separate so the crossing geometry never depends on display settings.

## SAT.prop (propagate.js) — SGP4 via global `satellite`

Trimmed from SatObserver: no ground tracks, no footprints, no orbit lines.

- `ensureSatrec(obj) -> bool` — build+memoize `_satrec`; false if the TLE is invalid.
- `temeKm(obj, date) -> null | {r:{x,y,z}, v:{x,y,z}}` — position and velocity, TEME.
- `look(loc, obj, date, opts) -> null | {raDeg, decDeg, azDeg, elDeg, rangeKm,
  rangeRateKmS, rateAsPerS, paDeg, rateMountAsPerS, paMountDeg, phaseDeg, sunlit,
  shadow:'none'|'penumbra'|'umbra', teme, temeVel}` — the full topocentric solution
  used by chart, table and info window. RA/Dec are J2000 via
  `SAT.frames.temeToJ2000`.

  **Two angular rates, because which one streaks the exposure depends on how the
  instrument was tracking, and for some orbits they differ by everything:**

  - `rateAsPerS` / `paDeg` — `d(RA,Dec)/dt`, motion against the **stars**. This is
    the streak on a sidereally-guided exposure, and it is the default. A
    geostationary object is *not* stationary here: it co-rotates with the Earth and
    so drifts through the star field at very nearly the sidereal rate, ~15″/s —
    which is precisely why GEO objects appear as dashes in tracked images.
  - `rateMountAsPerS` / `paMountDeg` — `d(alt,az)/dt`, motion against the
    **horizon**: what a parked or alt-az-fixed instrument sees. Here a
    geostationary object really is a fixed dot and the stars are what trail.

  Both are verified against finite-differenced sky and alt/az positions in
  `tools/test_propagate.js`. Consumers pick by `SAT.state.obs.track`: `'sky'` ⇒ the
  sidereal pair, `'mount'` ⇒ the mount pair. Getting this wrong is not a rounding
  error — it is 15″/s, which over a 30 s exposure is 7.5′ of streak that either
  exists or does not.
- `classOf(obj) -> 'leo'|'meo'|'geo'|'heo'` — from mean motion and eccentricity
  (geo: 0.9 ≤ n ≤ 1.1 rev/day and e < 0.05; heo: e ≥ 0.25; leo: n > 5; else meo).
- `periodMinutes(obj) -> number`, `Re = 6378.137`, `Rp = 6356.752`.

## SAT.scan (scan.js + worker/scan-worker.js) — AGENT E

**The heart of the tool.** Finds every object whose topocentric direction enters the
field between `t0` and `t0 + spanMin`, running SGP4 in a pool of Web Workers.

`SAT.scan.run() -> Promise<Crossing[]>` — reads `SAT.state.obs/filters/settings.scan`
and the active location; emits `'scan-started'`, then `'scan-progress'`, then
`'scan-done'`. `SAT.scan.cancel()`. `SAT.scan.isRunning() -> bool`.

```js
// Crossing
{ satId, norad, name, intl,
  tEnterMs, tExitMs, tCaMs,        // FOV entry, exit, closest approach to field centre
  sepCaDeg,                        // separation from pointing at closest approach
  raDeg, decDeg,                   // J2000 at tCaMs
  azDeg, elDeg, rangeKm, rangeRateKmS,
  rateAsPerS, paDeg,               // vs the STARS (sidereal guiding) — see SAT.prop.look
  rateMountAsPerS, paMountDeg,     // vs the HORIZON (parked mount)
  magEst, phaseDeg, shadow,        // photometry at tCaMs
  cls, sunElDeg,                   // orbit class, site solar elevation at tCaMs
  type, altKm,                     // SATCAT object type; geodetic height at tCaMs
  path: [{t, raDeg, decDeg}, ...]  // <=64 samples spanning tEnter..tExit, for drawing
}
```

### Algorithm — three stages, in this order

Stage 1 and 2 are what make a full-catalogue scan interactive; do not skip them.

**Stage 1 — static geometric cull (no SGP4 at all).** Bill Gray's `sat_id` has no
such cull — it brute-forces the catalogue at a single epoch, which is cheap. We scan a
*timespan*, so every object removed here is removed from every step. From `satrec`
alone (`inclo`, `nodeo`, `no_kozai`, `ecco`) compute the semi-major axis and hence
apogee/perigee heights, then reject the object outright when any test fails:

- *Horizon reachability.* The sub-satellite point never leaves `|lat| ≤ i`. The site
  is at geodetic latitude φ. The minimum possible ground-arc between site and
  sub-point is `max(0, |φ| − i)`; the object is above the horizon only if that is less
  than the horizon half-angle `acos(Re / (Re + h_apogee))`. Fail ⇒ never visible.
- *Declination reachability.* A satellite seen along the pointing ray sits at
  geocentric position `siteVec + ρ · rayVec` for some range ρ ∈ [h_perigee, h_apogee +
  2·Re]. Sweep ρ over ~24 log-spaced samples and keep the min/max geocentric
  declination. The satellite's own geocentric declination is bounded by `|δ| ≤ i`.
  If the whole ray-declination interval lies outside `[−i, +i]` padded by the FOV
  radius, the object can never appear in this field.
- *Orbit-plane test* — **the strong one, and strictly tighter than the two above.**
  The satellite's geocentric position always lies *in* its orbital plane, so it is
  exactly perpendicular to the plane normal `n̂(i, Ω)`. For each sampled range ρ along
  the sightline, the candidate geocentric position `p = siteVec + ρ·rayVec` must
  satisfy `|p̂ · n̂| ≲ tol`. If no ρ satisfies it, the object can never be in the field.
  The tolerance must absorb the nodal regression of Ω over the timespan:
  `tol = sin(fovRadius) + |Ω̇| · spanMin/1440 + margin`, with
  `Ω̇ = −1.5 · J2 · (Re/p)² · n · cos i` (rad/day). Fresh, short scans get a very tight
  test; a 24 h scan on a LEO object relaxes it by the ~5°/day the plane actually
  sweeps. Unlike the declination test this uses Ω, so it discriminates *which*
  polar orbits can reach the field, not merely whether the inclination is high enough.

Typical survival on a 27 k catalogue is 10–40% depending on pointing; a pointing near
the pole kills the entire GEO belt outright. Report the counts (see below) — a cull
this aggressive must be visible, or a bug in it looks like "no satellites tonight".

**Stage 2 — coarse sweep with skipping, in TEME (round 22).** Per epoch, **once**,
the worker tabulates the observer state and the pointing's TEME unit vector
(J2000 → TEME via `frames`, i.e. the *pointing* is rotated, never the catalogue).
Then, **object by object**, it asks one question at each step it visits:

> The satellite is at range ρ and **D km from the sightline ray**. How long before
> it could possibly be in the field?

In the field means within angle R of the boresight, i.e. within `ρ·sin R` km of
the ray, so the gap to close is `C = D − ρ sin R`. It closes no faster than
things move: the satellite at most its osculating perigee speed `V_sat`; the
ray's origin at most the observer's speed `V_s`; the ray's direction turning at
most `Ω_p`, which sweeps the ray's nearest point at `Ω_p × (its range)`, and
that range is at most `ρ + V_r t` with `V_r = V_sat + V_s`. `ρ sin R` itself
grows no faster than `V_r sin R`. In-field is therefore impossible while

```
C  >  [V_r (1 + sin R) + Ω_p ρ] · t  +  (Ω_p V_r / 2) · t²
```

and the positive root of that quadratic is `clearTime()`. It holds backwards in
time as well. `V_s` and `Ω_p` are **measured off the per-step tables**, so a
ground site, an orbit site, a sidereal field and an LVLH-fixed one are all the
same code; nothing in the bound knows what kind of orbit or observer it serves.
The step rule is then two lines:

- `clearTime ≥ one step` → jump `floor(clearTime / step)` whole steps (capped at
  2 h). Nothing can have been missed: the bound covers all of them, and the step
  just behind.
- `clearTime < one step` → the object may be in the field within one step either
  side: open (or extend) the candidate window `[t − step, t + step]`.

A LEO object on the far side of the Earth is ~13 000 km from the sightline and
closes at ≤ ~8.5 km/s, so it is not looked at again for 25 minutes; a typical
orbit costs a dozen propagations instead of 190. There is **no horizon test and
no angular margin in stage 2**: an object below the horizon is simply far from a
sightline that points above it, and visibility is imposed exactly, per sample,
in stage 3. The rounds 1–21 devices this replaces — the `ω·Δt` margin from the
instantaneous rate, the great-circle chord rescue, the per-object TLE slop
widening the margin — were heuristics that produced candidates, never results
(stage 3 dropped whatever was not actually in the field); the bound is rigorous
and produces fewer. Pads: `R` is widened by 0.02° and `C` reduced by
`1 km + 4·10⁻⁵ ρ` (the light-time displacement stage 3 applies and stage 2 does
not); `V_sat` carries 3% + 50 m/s over the osculating perigee speed, a
twenty-fold allowance on J2's ~0.15%. `tleSlopDeg` is still **reported** per
crossing (`(1 km + 2.5 km/day·age)/ρ`, capped) so the UI never presents an old
element set as a confident identification — it no longer changes what is found.
The grid is uniform (`ceil(span/step) + 1` steps): the satellite, the observer
and the pointing are evaluated at the same instant on every step, the last
included.

**Stage 3 — refinement by walking the boundary (round 22).** There is **no
sampling grid**. Each candidate window is walked: `probe(t)`, step by however
long the probe says the membership cannot change, probe again. A probe is one
SGP4 call plus dot products — the detector frame is three vectors (boresight,
+X, +Y), so membership is `X = (w·ex)/(w·b)`, `Y = (w·ey)/(w·b)` with no RA/Dec
and no trigonometry — and it returns:

- `in` — inside the true boundary (rectangle in the rotated detector frame, or
  circle) **and visible**: above the horizon / `minElDeg` on the ground, clear
  of the Earth's limb in orbit;
- `sep` — angle from the boresight;
- `h` — a safe step: while well outside, the rigorous `clearTime()`; near or
  inside the field, `0.5 × (distance to the edge) / (speed toward it)` on the
  tangent plane, capped at the time in which the viewing geometry could change
  by a quarter (`0.25 / (|v_rel|/ρ + n_LEO)`) — the edge can then only be
  overshot if the speed more than doubles within one step — and clamped to
  [10 ms, 10 min].

Where two consecutive probes disagree, the boundary between them is bisected to
**10 ms** against the same predicate, so entry/exit and membership can never
disagree. Closest approach is a golden-section minimum of `sep` (5 ms), bracketed
by the samples either side of the smallest. The reported row then goes through
the **exact** frame functions (`solveAt`: full nutation series, light time);
only the search samples use the 10-minute-bucketed TEME↔J2000 rotation
(< 0.001″). Photometry geometry, both rates, PAs and up to 64 `path` samples
(spacing `fineStepS`) are computed here. Objects that never actually enter the
field are dropped.

**Why the grid had to go.** Rounds 1–21 sampled each window at `fineStepS` and
kept the samples that landed inside. At the default 1 s that *missed any crossing
shorter than a second* whenever no sample fell in it: measured on the 2026-11-15
catalogue, **9 of the 14 objects that crossed a 0.2° field in two hours, 12 of 32
for 0.5°, 3 of 29 for 1°** — every one a fast LEO pass, i.e. exactly the trail
someone opens this tool to identify. `fineStepS` now only spaces the drawn path
samples. The limitation that remains is the mirror image and far smaller: a
grazing excursion out of the field and back *between two probes* of a slow
object (≤ 10 min apart, and only when its measured speed toward the edge is
near zero) is merged into one crossing.

**The detector is carried rigidly with the mount.** For `track:'sky'` the three
frame vectors are constant in J2000. For `track:'mount'` they are constant in
the Earth-fixed frame (ground) or in LVLH (orbit), with `rotDeg` read **at the
scan start**. On the ground that is what rounds 1–21 did in effect — a fixed
alt/az has a fixed parallactic angle. In LVLH it is a correction: the sky turns
under a body-fixed sensor once per orbit, and a rectangle held at a constant
angle to celestial north was not the rectangle that sensor sweeps. The chart
uses the same reference instant (`scanRefMs`), so the two agree.

**A ground target is in the field only while above the horizon** (the geocentric
"up", as stage 2 always used). Rounds 1–21 dropped below-horizon *coarse samples*
but tested no horizon in stage 3, so a field hanging partly below the horizon
reported the below-horizon stretch whenever a neighbouring sample was above.

**Co-located objects.** The observer's time-since-epoch is formed exactly as
every target's (`tsince0 + (t − t0)/60000`), never from a fresh Julian date
(which resolves only ~40 µs) or a `Date` (which drops fractional milliseconds).
At 7.7 km/s those are 0.3 m and 7.7 m of observer jitter — and for the objects
that fly *with* an orbital observer (the other ISS modules carry the station's
own elements) that jitter was the entire topocentric vector: a direction made of
rounding noise, flickering through the field thousands of times a scan. Formed
identically, a co-located object has range exactly zero and is never in the
field.

Rejected-at-each-stage counts are reported in `'scan-done'` and shown in the UI —
a scan that culls 90% of the catalogue should say so, not look like it found
nothing. `'scan-done'` also carries `propagations`, `gridPropagations` (what a
fixed-step sweep of the same survivors would have cost) and per-stage `timing`.

**Budget.** See "Performance decisions" for round-22 numbers. If the estimate
(`objects × steps × SKIP_FRACTION`) exceeds ~60 M propagations, `run()` refuses
and reports the estimate plus the two knobs that fix it (`coarseStepS`,
`spanMin`) rather than freezing the tab.

`maxCrossings` truncates the result set; `'scan-done'` carries `truncated:true` so the
UI can say so explicitly. Never silently drop.

**Verification (`tools/test_scan.js`, all with no network).** [b] cull on/off
identity; **[r] recall against an exhaustive brute force** that shares nothing
with the engine — every object, every second, a plain TEME gate no orbit can
beat, then 5 ms sampling through `frames.js` with iterated light time: every
crossing found, entry and exit within 25 ms, nothing spurious; **[k] the
clear-time bound walked instant by instant** for sidereal, parked and LVLH
pointings (12 000 bounds, ~900 000 instants, zero violations); [h] nothing
reported from below the horizon; [a]/[o] reported RA/Dec against an independent
astrometric recompute.

### Worker protocol (`js/worker/scan-worker.js`)

Classic worker, `importScripts('../vendor/satellite.min.js')` plus an inlined copy of
the handful of `SAT.frames` functions it needs (workers cannot see the main-thread
`SAT`; keep the duplicated maths in a clearly-marked block and keep it byte-identical
in behaviour to `frames.js` — `frames.js` is the reference implementation).

- main → worker `{cmd:'load', objs:[{id,norad,name,intl,l1,l2,rcs,stdMag}]}`
- main → worker `{cmd:'scan', params:{t0Ms, spanMin, site, pointing, fov, filters, steps}}`
  — `site` is either `{kind:'ground', latDeg, lonDeg, altM}` or
  `{kind:'orbit', norad, l1, l2, name}`: scan.js resolves the TLE from the catalogue
  *before* posting, because the worker owns satrecs for its shard only and the
  observer must exist in every worker.
- worker → main `{type:'progress', done, total}`
- worker → main `{type:'result', crossings:[...], culled:{stage1, stage2, stage3, …},
  propagations, gridPropagations, timing:{stage1Ms, stage2Ms, stage3Ms}}`
- main → worker `{cmd:'cancel'}`

## Orbital observing stations (v0.2) — the moving-observer amendment

A site may be a satellite (`kind:'orbit'`, space-based SSA: who crosses *my sensor's*
field). The scan pipeline was built so that the observer enters the geometry at
exactly one point — the TEME position/velocity provider — and this amendment keeps it
that way. **Nothing downstream of the provider may ever ask what kind of observer it
serves**, with the short list of physics gates below as the only exceptions.

### The observer provider

`obsStateAt(t) → {r, v}` in TEME km, km/s — the ONE place observer kind matters:

- ground: `r = R3(−gmst)·ecef`, `v = ω⊕ ẑ × r` (what siteTemeAt + the inline
  velocity always were; now they also hand back `v` so no caller reconstructs it);
- orbit: one `sgp4(obsRec, tsince)` — the observer's satrec is built once in
  `prepare()` from the TLE resolved out of the catalogue. One extra propagation per
  epoch against 32 k targets: unmeasurable. An invalid observer TLE fails the scan
  loudly at prepare time; it must never fail open into "scanned from (0,0,0)".

Main-thread mirror: `SAT.prop.obsState(loc, date)`, plus the dispatching converters
`SAT.prop.siteAltAzToRaDec / siteRaDecToAltAz` which every UI module now calls
instead of `SAT.frames.altAzToRaDec / raDecToAltAz` directly. For ground sites they
delegate verbatim (refraction included) — behaviour is byte-identical to v0.1.

### The LVLH frame — what "Az/El" means on an orbit site

Basis from the observer PV: `R̂ = r̂` (zenith, radially out), `Ŵ = (r×v)/|r×v|`
(orbit normal), `Ŝ = Ŵ×R̂` (along-track). Pointing angles:

```
boresight = cos(el)·(cos(az)·Ŝ + sin(az)·Ŵ) + sin(el)·R̂
```

so El is measured from the local-horizontal plane toward zenith (nadir = −90°), and
Az from the along-track direction toward the orbit normal — the same rotational
sense as ground azimuth N→E, with "north" played by the velocity direction. The
existing Az/El inputs, `track:'mount'`, and the parked-mount drift machinery all
carry over with this reading: a `track:'mount'` field on an orbit site is fixed in
LVLH (a body-mounted staring sensor) and its chart frame drifts at the orbital rate
through the stars, exactly as a parked ground mount drifts at the sidereal rate.
**No refraction, ever, on an orbit site** — the always-on refraction rule is a
ground-site rule; the converters gate it on kind, not the callers.

### Physics gates (the exhaustive list — do not add one without amending this)

1. **Horizon → Earth limb.** The ground gate `dot(topo, site) > 0` and `minElDeg`
   are meaningless in orbit (you can look down at a target against the Earth). An
   orbit site instead drops a sample iff the observer→target segment intersects the
   hard Earth sphere: with `t* = −s·ρ̂`, occluded when `0 < t* < ρ` and
   `|s + t*ρ̂| < Re`. Hard `Re`, no atmosphere pad — inclusion-conservative: a
   limb-grazing LOS is kept and the observer merely sees it against bright air.
   The limb test is part of field membership (`probe().in`), so entry/exit
   bisection resolves a target *rising from behind the Earth* the same way it
   resolves a field edge. On the **ground** the same slot is filled by the
   horizon: a target is in the field only while its geocentric elevation is
   ≥ max(0, `minElDeg`) (round 22).
2. **Sky/mount rates.** The sky rate is inertial and unchanged. The mount rate
   subtracts the observer frame's rotation: `ω⊕ ẑ × ρ` on the ground,
   `Ω_LVLH × ρ` with `Ω_LVLH = (r×v)/|r|²` in orbit.
3. **sunElDeg** keeps its formula (Sun's angle above the observer's local
   horizontal) — on an orbit site it reads as the observer's day/night state, which
   is what the twilight readout was for anyway.
4. **azDeg/elDeg on a Crossing** are LVLH angles on an orbit site (limb clearance is
   `elDeg` + 90° from nadir if anyone asks). Columns keep their headers.
5. **Self-exclusion.** The observer is removed from its own target list by NORAD at
   stage-2 shard setup: identifying yourself is never the answer.

### Stage 1 under a moving observer

The two quadratic culls (declination, orbit-plane) are already parameterized by
sampled observer positions and survive untouched *in form*. What breaks is the
sampling contract: 15-minute cadence assumed a site that moves 3.75°/15 min, and the
tests OR over samples, so sparse sampling on a LEO observer (56°/15 min) would cull
real objects — the one failure a cull must never have. On an orbit site:

- the *latitude/horizon-reachability* cull is **skipped** (fail open; the plane test
  was always the strong one);
- sightline range bounds widen to `ρ ∈ [max(1, rPeri_t − rObsMax), rApo_t + rObsMax]`
  with `rObsMin/Max` from the observer's own `orbitRadii`;
- observer samples come from `obsStateAt` at a cadence targeting ~2° of observer
  arc, capped at 600 samples; whatever arc the cap leaves unresolved is repaid as a
  *pad*: the between-sample chord `δ = 2·rObsMax·sin(Δθ/2)` is charged per object as
  `δ / max(rPeri_target, Re)` radians added to the declination limit and the plane
  tolerance. Provably conservative: a true observer position is within δ km of some
  sample, so the true candidate point `p` moves by ≤ δ and `|p| ≥ rPeri_target`.
- The soundness proof is the same one v0.1 shipped with: `useStage1:false` must
  return the identical crossing set, now exercised over orbital geometries too
  (tools/test_scan.js).

### Stage 2/3 under a moving observer

Round 22 made stages 2 and 3 observer-general by construction: the clear-time
bound takes the observer's top speed `V_s` and the boresight's top turn rate
`Ω_p` from the per-step tables, whatever produced them, and the detector frame is
three vectors carried in LVLH. Nothing in either stage asks what kind of observer
it serves. What remains orbit-specific:

- **`coarseStepS` is still clamped to ≤ 10 s** on orbit sites. The bound no
  longer needs it for soundness (the chord rescue it protected is gone); it
  stays because the tables sample the observer's own motion, and because a
  finer step makes tighter candidate windows — with skipping, it costs table
  entries, not propagations. The estimate/refusal maths use the clamped value.
- **The detector is LVLH-fixed** (see "Algorithm"): `rotDeg` is read at the scan
  start and the rectangle turns with the sensor.
- **Co-located objects** (other modules of the observing station) have range
  exactly zero and are never in the field — see "Co-located objects".
- TLE slop is reported as before; the observer's own slop is no longer added to
  a margin, because there is no margin.

### Documented omissions (measured against the TLE-slop floor, ~arcmin at best)

**Light time is applied** (round 22 — see "Why `SAT.frames` exists"): positions
are astrometric, on orbit sites as on the ground. The observer's **orbital
aberration** (v/c ≈ 25 µrad ≈ 5″) is ignored, as annual aberration is for ground
sites, and for the same reason: it displaces the target and the stars around it
alike. Do not apply it to one side.

### UI consequences

- Sites window: Ground | Orbit toggle on the add form; orbit rows show a NORAD box
  plus the live-resolved catalogue name (or a red "not in catalogue" — the site
  stays, the *scan* is what refuses, with the same message).
- Pointing: the site line reads `NORAD n · name`; Az/El row labels grow an L
  subscript on orbit sites; the track toggle relabels Mount → LVLH. Same fields,
  same persistence, no second pointing model.
- All-Sky is a ground-horizon projection and says so on an orbit site instead of
  rendering nonsense. The chart, crossings table, sat-info and exports work
  unchanged through the converters.

## SAT.photo (photometry.js) — AGENT P

`magnitude(obj, geom) -> {mag, method}` where `geom = {rangeKm, phaseDeg, shadow}`.

### Why there are five tiers and not two (measured 2026-07-21)

The obvious design — McCants standard magnitude, else RCS-derived sphere — collapses
on a real modern catalogue, and the UI would have shown a column of identical guesses:

- **CelesTrak publishes no RCS at all above NORAD 50000.** Measured coverage:
  41–97% below NORAD 40000, 25.6% for 40000–49999, **0.0% for 50000+**. Of the 16 078
  objects in CelesTrak `active`, only **879** carry an RCS — because two-thirds of that
  catalogue is Starlink, and no Starlink has a published RCS.
- **`mmccants.org/programs/qsmag.zip` currently returns HTTP 404** while still being
  linked. The graceful-empty path is the live path today, so the qsmag tier is
  presently contributing nothing.

`OBJECT_TYPE` in `satcat.csv`, by contrast, is **100% populated** (DEB 35 832 /
PAY 27 088 / R/B 6 867 / UNK 160), so it carries the size information RCS no longer
does. Hence the `type` tier, and a `model` tier for constellations whose brightness is
actually documented. If a future reader finds the RCS join returning almost nothing,
**it is not a join bug** — verify against the NORAD ranges above before "fixing" it.

Tiers, best available first (`method` names which was used):

1. `"qsmag"` — McCants standard magnitude `obj.stdMag`, defined at 1000 km range and
   50% illumination:
   `m = stdMag − 15.75 + 2.5·log10(range²  / F(φ))` with `F` normalised so that
   `F(90°) = 1`, i.e. `m = stdMag + 5·log10(range/1000) − 2.5·log10(F(φ)/F(90°))`.
2. `"rcs"` — effective radius `r = sqrt(rcs/π)` metres from SATCAT, treated as a
   diffuse sphere of albedo 0.20:
   `m = −26.74 − 2.5·log10( albedo · r² · F(φ) / d² )`, `r` and `d = range` in metres.
3. `"model"` — a documented per-constellation brightness where one exists (Starlink,
   OneWeb). Coarse: real scatter exceeds a magnitude with orientation and hardware
   revision, so round numbers only.
4. `"type"` — size prior from SATCAT `OBJECT_TYPE`, treated as a diffuse sphere:
   R/B ~2.0 m, PAY ~1.0 m, DEB ~0.15 m. Order-of-magnitude size classes, nothing more.
5. `"default"` — `r = 1.0 m`; flag it as a guess in the UI.

`"eclipsed"` is returned with `mag: null` when the object is in shadow.
**Every tier below `"rcs"` is a prior, not a measurement.** The table shows `method`
per row so a user can see exactly how much to trust a magnitude, and the magnitude
filter must never silently drop rows whose magnitude is a guess.

`F(φ) = (2/(3π²))·[(π−φ)·cos φ + sin φ]` — Lambertian sphere phase function, φ in
radians. `shadow !== 'none'` ⇒ `mag = null` (eclipsed objects are not visible;
penumbra dims by `2.5·log10` of the unobscured solar fraction).

- `phaseAngleDeg(sunTeme, siteTeme, satTeme) -> Deg` — Sun–satellite–observer angle.
- `shadowState(satTemeKm, date) -> {state:'none'|'penumbra'|'umbra', frac}` — conical
  Earth shadow with the solar angular radius, oblateness ignored (≤ 0.3 s of timing
  error at the terminator).

## SAT.stars (stars.js) — AGENT S

Loads `assets/stars_m9.bin` once (fetch → ArrayBuffer → typed-array views) and answers
cone queries. Since round 12 the only cone consumer is the **sky chart** — the
All-Sky panel's star field is the bright catalogue only (its SatObserver fallback;
see its panel section). The chart also uses `named()` / `constellationLines()`,
which are bright-catalogue helpers anyway. Falls back to `SAT.stardata` (the
bright-star catalogue
from SatObserver, mag ≤ 4.6) when the deep file is absent, so the app still runs
before `tools/make_starcat.py` has been executed.

**Built and verified 2026-07-21: 130 183 stars to V = 9.0, 1.30 MB** (Tycho-2).
Round 2 added a Gaia DR3 build (`--source gaia`, `assets/stars_deep.bin`, V ≤ 10.5,
proper motions propagated to epoch 2026.5); `stars.js` prefers it when present and
falls back to the Tycho file, then to the bright catalogue. The PM propagation is
not cosmetic: the Tycho build's J2000 mean places put 169 stars more than 13″ off
at the 2026 epoch, the worst by ~227″ (61 Cyg class) — visibly wrong on the chart.

**Bright-star astrometry (round 23) — binding for every build.** Gaia DR3 does
not contain its brightest stars (everything brighter than G ≈ 3 saturates and is
absent), so `merge_bright()` adds them whole from `starcat.js` — whose positions
are **J2000 places rounded to 0.01°, no proper motion**: fine for photometry and
an all-sky chart, wrong for this one. Measured in the shipped catalogue against
SIMBAD places at its own epoch: **Arcturus 63″ off, Procyon 36″, Sirius 31″,
Vega 28″, Capella 20″, Rigel 17″**, while every Gaia star around them was good
to 0.5″. `refine_bright()` recognises those stars (both coordinates on the 0.01°
lattice, V ≤ 4.6) and replaces each position with its **Hipparcos** place
(new reduction, VizieR `I/311/hip2`, complete to V ≈ 7.3) carried linearly to
the catalogue's epoch; magnitudes are untouched and the arrays are re-sorted by
declination. It runs inside every build (`finish()`, `build_deep_tiles()`), and
`make_starcat.py --refine-bright` repairs catalogues already on disk in place
(idempotent; one ~200 kB download, with a VizieR mirror list — the CDS host was
answering 404 on 2026-11-15). Applied 2026-11-15: 70 stars in `stars_deep.bin`,
105 in 86 deep tiles; the fourteen-star truth table now agrees to **≤ 0.2″**
(`tools/test_stars.js` [5b], `tools/test_starcat.py`). `starcat.js` itself is
unchanged — names and constellation figures are drawn from it on fields wider
than 5°, where 18″ is under a pixel.

Binary format — little-endian, **structure of arrays** so the frontend builds
`Float32Array`/`Int16Array` views directly over the buffer with no per-star parsing.
An interleaved 10-byte record would be misaligned and force a slow `DataView`.
Declination is sorted ascending so a cone query is a binary search over a dec band:

```
offset 0              magic "STR1"      4 bytes
offset 4              count uint32      4 bytes
offset 8              magLimit float32  4 bytes
offset 12             ra   float32[count]   degrees, [0, 360)
offset 12 + 4*count   dec  float32[count]   degrees, ASCENDING
offset 12 + 8*count   mag  int16[count]     V * 100
```

`float32` holds RA to ~0.08″, far finer than the ~0.5″ of proper motion we ignore by
keeping J2000 mean places. Both are negligible against arcminute-scale TLE error.

Three data-quality decisions in `make_starcat.py`, each of which was a bug first:

- **Tycho-2 main is not enough.** Its reduction saturates on the brightest stars, so
  the main catalogue is missing Sirius, Vega, Arcturus, Betelgeuse and Acrux. Fetch
  supplement 1 (`I/259/suppl_1`) as well.
- **Take BSC5 magnitudes, keep Tycho positions.** Tycho VT/BT saturate at the bright
  end and BT is often blank there (Sirius comes out at V = −1.10 instead of −1.46),
  but `starcat.js` positions are rounded to 0.01° ≈ 20–36″. So the merge overwrites
  *only the magnitude* of the nearest Tycho star — adopting BSC5 positions would trade
  two orders of magnitude of astrometry for a photometric fix. Match radius must be
  ≫ 0.01° (90″ is used) or the bright stars silently fail to match; within the radius
  take the **brightest** candidate, not the nearest.
- **Dedupe near-coincident entries** (< 2″, keep the brighter). Main and supplement
  overlap slightly — Arcturus appears twice, 0.2″ apart, with V = −0.1 and a saturated
  V = 3.47 — and which one a lookup returns is otherwise a coin toss. 539 removed.

The builder ships a `sanity_check()` that asserts six named bright stars are present
with the right magnitude. It caught every one of the above. Keep it.

- `SAT.stars.load() -> Promise<{count, deep: bool}>` — called once from `main.js`.
- `SAT.stars.cone(ra0, dec0, radiusDeg, magLimit) -> [{raDeg, decDeg, mag}, ...]`
  — dec-band binary search, then exact separation test; capped at 20000 results.
- `SAT.stars.named(ra0, dec0, radiusDeg) -> [{raDeg, decDeg, name}, ...]` and
  `SAT.stars.constellationLines(ra0, dec0, radiusDeg) -> [[{raDeg,decDeg},...], ...]`
  — both from `SAT.stardata`; used for wide fields only.
- `SAT.stars.isDeep() -> bool`.
- `SAT.stars.localLimit() -> number` (round 14) — the live catalogue's magnitude
  limit, read from the binary header (10.5 Gaia build / 9.0 Tycho / 4.6 on the
  bright fallback). The chart compares its wanted depth against this to decide
  when the deep tile set is needed at all.
- `SAT.stars.deepField(ra0, dec0, radiusDeg, magLimit, onReady)
  -> {state:'ready'|'loading'|'error', stars, truncated, magLimit?}` (rounds
  15-16 — LOCAL deep tiles; the round-14 online VizieR cone is REMOVED, no
  runtime network fetch) — the deep star source behind the chart's views
  narrower than 26° (3° until round 24),
  reading the tiled local catalogue that `make_starcat.py --deep-tiles` builds
  (see below) through `GET /api/stars/deep` (presence probe, once) and
  `GET /api/stars/tile/<name>` (one small binary per tile, ~105 kB; up to 128
  LRU-cached in memory since round 24). Never throws, never rejects. When every tile covering the cone is
  cached the result is computed synchronously — per-tile cone queries (the same
  kernel `cone()` uses) merged and capped at the brightest 20000 — and the
  state is `'ready'` with `magLimit` reporting the tile set's actual V cut (the
  chart's dot law keys on this delivered depth, not the wanted one); missing
  tiles are fetched (local server, milliseconds) and `'loading'` returns with
  `stars:null`, the chart drawing the bundled catalogue until `onReady` fires.
  If the tile set has not been built (probe says absent, or a tile 404s) the
  state parks in `'error'` and the chart stays on the bundled catalogue —
  quietly, no per-frame retries (re-probe only on a fresh page load; since
  round 19 removed the chart footer, the mA button tooltip is where the deep
  behaviour is described to the user).
- `SAT.stars.tilesForCone(ra0, dec0, radiusDeg) -> [name, ...]` (round 15, pure,
  unit-tested) — the tile names covering a cone under the scheme below, handling
  the RA wrap and the polar caps.

**Deep tile set** (rounds 15-16): `data/deepstars/` (gitignored — ~60 MB at the
round-16 depth of V = 13; per-machine, built once by the user; the packaged app
reads it from its own DATA_DIR, so copy, rebuild or symlink it into Application
Support for the .app). Scheme: 4° declination bands indexed 0..44 from −90;
bands with |dec| ≥ 86 are single polar tiles, every other band splits into
twelve 30° RA columns; names are `t<band>_<col>.bin` (polar caps use col 0).
Each tile is the same STR1 structure-of-arrays binary as the bundled asset
(header magLimit = the build's V cut — the frontend trusts the header and the
index, so a set built at another depth stays honest end to end), dec-sorted for
the shared cone kernel. `index.json` records `{magLimit, count, tiles,
builtIso, epochYr}` and is what the presence probe serves; it is written ONLY
on completion, so a half-finished build reads as absent. Data source (round
18): the **ESA Gaia Archive TAP** (`gea.esac.esa.int`) — one asynchronous ADQL
job per 20° declination slab (five tile bands, boundary-aligned), Gmag < cut
+ 0.5, G→V by Riello+ 2021, proper motions to the build-time decimal year,
tiles cut locally from each slab's CSV; the BSC5 bright-star merge is applied
per tile — Gaia genuinely lacks its saturated brightest stars (Vega, Sirius
class), and a 2° field containing Vega must still show Vega. Two guards, both
born of real incidents: a slab at ≥ 2.5M rows is assumed silently
row-cap-truncated (anonymous TAP truncates CSV with no overflow marker) and
splits into sub-slabs; a slab under ~1 row/deg² is a broken service response
(the round-16 VizieR husk lesson) and aborts the build resumably. Resumable at
slab granularity: a slab whose tiles all exist costs nothing. (VizieR remains
the source for the small bundled assets only — its interactive endpoint dies
on its ~2-minute execution cap under bulk load, which is how round 16's build
stalled.)

`tools/make_starcat.py` fetches Tycho-2 from VizieR, keeps `VT ≤ 9.0`, converts to
Johnson V, sorts by declination and writes the file. Dev-time only; the generated
asset is committed so users never need it. `--source gaia` builds the deeper
bundled asset; `--deep-tiles` (rounds 15-16) builds the deep tile set above.

## Panel modules (window content)

Each is registered from main.js via
`SAT.windows.register({... build: (body, win) => SAT.<mod>.init(body, win)})`.

### SAT.chart.init(bodyEl, win) — AGENT C (js/chart.js) — MAIN VIEW

Gnomonic (TAN) sky chart on `<canvas>`, tangent at the pointing. This is the primary
view and gets the largest default window.

**Round 22 redesign — binding.** The panel exists to be *held against a frame*,
and its layout follows from that:

- **Four stacked parts, nothing overlapping the sky**: a toolbar of labelled
  controls, the chart canvas, a **timeline** strip, a status line. (Rounds 1–21
  floated a toolbar of two-letter buttons and a HUD over the chart.)
  - Toolbar: **Layers ▾** (a menu listing every layer by its full name, with
    checkboxes: satellite names, satellite tracks, time ticks, colour key /
    stars, star names, constellation lines, constellation names, Sun and Moon,
    RA/Dec grid / timeline), **Stars** depth select (`auto`, V 4.5 … 13 — the
    same exactly-deliverable steps as round 17), **Ruler**, **− zoom% + Fit**,
    **Mirror E/W**. Every control has a `title`.
  - Status line: cursor RA/Dec (+ Az/El, or AzL/ElL on an orbit site) on the
    left; the round-19 one-line pointing summary on the right.
- **The frame interior carries only what the image carries**: stars and trails.
  All text is placed through one collision registry (`claim()`), in priority
  order — field size, colour key, picked trail's annotations, satellite names,
  grid labels — and **a piece of text that would overlap another, or lie along
  another object's trail, is not drawn** (the hover card has it). Nothing is
  ever printed across something else, except the picked object's own name and
  tick times, which are forced onto a dark plate.
- **Keys** (chart focused): `F` fit, `+`/`−` zoom, `R` ruler, `L` names,
  `T` tracks, `Esc` clears the ruler or the selection.

- Scale set so the FOV fits with a configurable padding (default: FOV occupies 70% of
  the shorter axis, so context outside the field is visible). Wheel zooms about the
  cursor (0.2×–20× relative to fit), drag pans; **double-click re-aims** — the
  clicked sky position becomes the new pointing, centred (round-3 review; drag
  somewhere, double-click the spot). Fit-to-window is the Fit button, the zoom
  readout, or `F`.
- Orientation: apply `rotDeg` then `flipEW` to `{xi, eta}`. A compass rosette in a
  corner shows N and E arrows *after* the transform, so the user can verify the
  chart matches their frame. Always visible; this is the thing people get wrong.
- Layers, respecting `settings.chart` and redrawing on `time / obs-changed /
  scan-done / filters-changed / selection-changed / settings-changed / state-loaded`:
  - **Chart star background (adaptive depth, all local; law re-set in round 24 —
    binding).** Stars from `SAT.stars.cone` / `SAT.stars.deepField` down to an
    *effective* magnitude limit. Default is **auto** (`settings.chart.magAuto`):
    the limit follows the view span D — the diameter in degrees of the circle
    enclosing the **window** (not the field frame, which fills 70% of it) — via
    the pure helper `SAT.chart.autoMagLimit(D)`:
    - **D ≤ 8°: 13.0**, the deep tile set's full depth;
    - **D > 8°: clamp(13 − 5·log10(D/8), 6.5, 13)** — 12.1 at 12°, 11.0 at 20°,
      10.1 at 30°, 8.6 at 60°, 7.7 at 90°, floor 6.5 from ~160°.
    **The law holds the number of stars on screen roughly constant** (~4 000 on
    an average sky): the sky has ~10^(0.45 m) stars per square degree brighter
    than m and the view covers ~D² square degrees. Rounds 14–23 used the same
    slope anchored 4.6 magnitudes shallower (10.5 at 3°, floor 4.5 from 48°),
    which left 60–420 stars on screen — a 15°×10° frame showed sixty; it now
    shows ~1 800 to V 10. The user asked for the change ("more stars on wider
    fields") after the drawing cost was measured: 0.2–0.4 ms a frame at the old
    counts, **2–4 ms at 2 000–5 300 stars** — the count was never a rendering
    limit.
    **Sources.** Above the bundled catalogue's V 10.5 the stars come from the
    LOCAL deep tile set through `SAT.stars.deepField` (round 15; no runtime
    network access, ever; V 13 since round 16 — on 1609 deg² of fetched sky,
    V≤11 ≈ 1M stars/10 MB, V≤13 ≈ 6M/60 MB, V≤15 ≈ 32M/320 MB, V≤17 ≈
    137M/1.4 GB). While tiles load (local server, milliseconds) or when the
    tile set has not been built, the bundled catalogue draws at its own
    `localLimit()`; the dot law keys on the DELIVERED depth, never the wanted
    one. **Deep tiles serve views narrower than 26°** (`DEEP_MAX_VIEW_DEG`;
    round 17's gate, 3° until round 24): the law crosses V 10.5 at 25.3°, so
    past the gate the tiles are not needed, and a wider cone would pull in
    hundreds of them. A pinned V 13 on a wider view draws the bundled
    catalogue. `stars.js` keeps up to 128 tiles (~105 kB each) in memory — a
    16° cone at high declination wraps every RA column of eight or nine dec
    bands. Measured refresh after a pan: 2–21 ms.
    **Star budget.** However deep the request, at most `STAR_BUDGET` = 12 000
    stars are kept from a query — the brightest (`applyStarBudget`; about 40%
    of them land inside the window) — and the drawn depth is reported as the
    faintest one kept. In the Milky Way an 8° view holds 40 000 stars to V 13;
    the budget keeps the frame time flat there (Cygnus 8°×6°: 5 300 on screen
    to V 10.9, 4 ms a frame).
    The toolbar's **Stars** select offers auto, 4.5/6/7.5/9/**10.5**/**13**
    (round 22: a select, where rounds 14–21 cycled a button; round 17: every
    manual step is exactly deliverable — 10.5 is the bundled catalogue's full
    depth and 13 the deep tiles'. A manual value pins `magLimit` and clears
    `magAuto`; a saved m11 from an older state is read as auto). Its first
    option names the depth actually drawn (`auto · V 10.1`).
    **Star rendering (round 15 — Stellarium-derived, binding).** The mapping
    from magnitude to dot follows Stellarium's `StelSkyDrawer::computeRCMag`
    design, adapted to a fixed-tone canvas (pure helper
    `SAT.chart.starDot(mag, mlim) -> {rad, lum}|null`, unit-tested; `mlim` is
    the *drawn* depth — the delivered catalogue's limit, not the wanted one):
    - Exposure shift (Stellarium's FOV factor): `m = mag − max(0, mlim − 11)`,
      so deep narrow fields behave like a longer exposure — an m17 star at an
      m17 limit renders like m11 did at m11 — while limits ≤ 11 keep the
      round-9 look for every star above the faint floor.
    - Flux-law radius (round 9, kept): `rr = 5.2·10^(−0.085·m)`; luminance ramp
      `lum = clamp(1.04 − 0.058·m, 0, 1)`.
    - **Faint end (the round-15 change): below `rr = 1 px` the dot stops
      shrinking and FADES instead** — `lum *= rr³` (Stellarium's cubic
      sub-floor falloff), radius pinned at 1 px, and dots with `lum < 0.02`
      are culled entirely (Stellarium's 0.3-radius cutoff). The old hard
      floors (0.7 px, alpha 0.42) that turned every star of the faint tail
      into identical pepper are GONE — the field now grades smoothly to
      invisibility at the limit.
    - Bright end: radius past 6.5 px is sqrt-compressed
      (`6.5 + sqrt(1 + rr − 6.5) − 1`, Stellarium's MAX_LINEAR_RADIUS device),
      so Alcyone in a deep Pleiades field is prominent, not a blob.
    Round-12 note kept: the deep background is REAFFIRMED — the SatObserver
    bright-only fallback belongs to the **All-Sky panel** (see its section;
    the All-Sky keeps its own SatObserver dot law and is NOT changed by round
    15). Star names, constellation lines AND constellation names (`constNames`,
    round 11) draw on fields wider than 5°.
    **Round 23 additions to the star layer** (the dot law above is unchanged):
    - **Star trails on a parked mount** (`settings.chart.starTrails`, default
      on, Layers menu). With `track:'mount'` the sky turns under the detector,
      so over the exposure every star draws a streak — and that streak pattern,
      not a field of dots, is what the frame shows; the header of this file had
      always said "the STARS trail" and the chart had never drawn it. Each of
      the brightest 1 500 drawn stars is carried through the detector frames of
      the window — the current scan's `[t0, t0 + spanMin]`, or clock … clock +
      `obs.spanMin` when there is no current scan — sampled every ≤ 2 min; the
      dot stays at the clock time. Streak alpha falls with length (a 60 s
      exposure gives crisp 15′ streaks, a 20 min window faint context lines).
      Nothing is drawn when the field tracks the sky.
    - **A soft halo** under stars whose dot radius is ≥ 2.6 px (radial gradient
      to 2.7 × the radius, 30% of the dot's luminance): a hard-edged disc reads
      as a marker, a star in an image has a skirt.
    - **Hover readout**: with the cursor within 7 px of a drawn star and no
      satellite under it, the status line appends `★ [Name] V m.mm` — a star's
      magnitude is how one judges the depth of a frame.
    - **"auto" says what it resolved to**: the Stars select's first option reads
      `auto · V 9.3`, the depth actually delivered (`drawnMag`).
    - Measured cost of the whole layer in round 23: 0.2–0.4 ms a frame at the
      60–420 dots the old depth law allowed — which is what made round 24's
      denser law free.
  - **Milky Way — REMOVED from the chart (round 20).** The gnomonic isophote port
    and its MW toggle are gone at user request; a saved `settings.chart.mw` is
    ignored. The glow survives only in the All-Sky panel (`settings.allsky.mw`,
    its own port — see that section), which is why `vendor/mwdata.js` stays
    loaded. The round-13 documented deviation (no twilight/daylight sky tint on
    the chart, ever) still stands — it was never MW-specific.
  - **Sun and Moon** (`settings.chart.sunMoon`, default on): SatObserver-style icons
    — rayed sun disc, moon with its phase terminator, bright limb facing the sun's
    chart direction (via a waypoint 1° along the moon→sun great circle, since the
    sun itself may be over the tangent-plane horizon). (The "moon N° away"
    footer note was removed with the footer in round 19.)
  - **Status line (round 19 wording, round 22 position).** `RA … Dec … · W° × H°
    (ONE decimal) · rot N° [· mirrored] [Az/El when altaz] · sidereal on|off`,
    now in the status line under the chart instead of over it. The zoom factor
    is on its toolbar button. Stale-scan state is shown on the timeline.
  - **the FOV outline**: accent rectangle with corner brackets (or circle), a
    centre cross at the pointing, the field's angular size as one label under
    the bottom-right corner; the region outside is dimmed ~46% so the frame
    reads as the image. **A circular field is drawn at `tan(R)`**, not `R`
    (`circTanDeg`): the scan's circle is a true angular radius and the gnomonic
    projection puts 30° at 33.1 "tangent degrees" — drawn at R (rounds 1–21),
    a ring of in-field trails lay outside the outline on any wide field. A
    rectangle is defined on the tangent plane in the scan as here and needs no
    correction.
  - a grid of RA/Dec lines when `settings.chart.grid` (spacing chosen from the
    field size: 1°, 10′, 1′ …), **each labelled where it leaves the frame**,
    just outside it (inside the viewport edge when the frame does not fit on
    screen) — found by intersecting the drawn line with the frame, so it is
    right at any rotation; plus a scale bar and the compass rosette, whose
    corners are reserved in the collision registry.
  - **colour key** (`settings.chart.legend`): top-left, only the object types
    actually on the chart, with counts, and the dashed-line meaning when any
    trail is eclipsed.
  - **per crossing** (from `SAT.state.chartCrossings()`): its **whole-timespan
    track** at low alpha (0.16) underneath everything — the object's sky path over
    the entire scan window while above the horizon, computed once per scan and
    cached on the crossing (adaptive step, ≤400 points, built ≤30 tracks per frame
    so the post-scan hiccup is spread) — then the scan's fine `path` (tEnter..tExit)
    as the bright polyline in the object's type colour, the portion already swept
    (before the current clock time) dimmed, with:
    - **time ticks** (`settings.chart.ticks`) at round UTC instants, the finest
      interval of 0.1 s … 1 h that keeps them ≥ 26 px apart (`tickStepS`), so a
      2-second LEO streak is ticked in tenths and a GEO drift in minutes;
    - one **arrowhead** a little past half way (direction of motion);
    - **dashed** when `shadow === 'umbra'` at closest approach: it crosses the
      field but reflects no sunlight, and an optical streak is not that object;
    - the **name** `NAME [NORAD]` (`satLabel`, round 20 format unchanged) set
      beside the trail's exit end, pushed onward along the motion — i.e.
      **outside the frame** for a trail that leaves it — then the entry end,
      then beside either end or the middle (`labelTrail`); an object that sits
      still on the detector (a GEO dot on a parked mount) is named before any
      streak;
    - the current position at `SAT.clock.getDate()` as a filled square, which
      follows the extended track at reduced alpha once the object has left the
      field, so a two-second crossing does not mean a two-second marker.
    The **picked** trail — selected, or under the cursor — is drawn on top with
    a white under-stroke, the others step back, and it is annotated as a clock:
    its ticks labelled (every 1st/2nd/5th/10th, evenly), its entry and exit
    instants printed at its ends.
    **Tracks toggle (round 20)**: `settings.chart.tracks` gates BOTH trail
    layers, ticks and the arrowhead; off leaves only markers + names, for
    holding a clean field against a frame. Extended tracks are still BUILT with
    tracks off — the off-field marker position follows them.
    **Density tiers.** Past 150 trails the ticks are dropped (except on the
    picked trail); past 400 the chart thins everything — 1 px lines at 0.42
    alpha, no arrowheads, no context tracks except the picked object's, at most
    30 names. A 30° field over an hour is 1 600 trails; at full weight that is a
    solid block of colour and 112 ms a frame (measured), thinned it is 23 ms.
  - **Timeline** (`settings.chart.timeline`): a strip under the chart spanning
    the scan window `[t0, t0 + spanMin]`, with a UTC axis (`timelineStepS`), one
    bar per charted crossing from entry to exit in its type colour (lanes packed
    by `packLanes`), and the clock as a playhead (parked at the edge, pointing
    out, when the clock is outside the window). **Press or drag** moves the
    clock (`SAT.clock.setDate`); **click a bar** selects that object and jumps
    to its closest approach; hovering a bar picks the trail on the chart. A
    stale scan dims the bars and says so. WHEN is half of an identification and
    the chart alone only shows where.
  - **Ruler** (toolbar, or `R`): drag along a streak. The two ends are stored
    as SKY positions (so the line stays on its stars under zoom, pan and a
    running clock); the panel shows length, position angle both ways (a streak
    has no direction), and the **four predicted trails that match best**, each
    with its offset from the streak's midpoint and the angle between them
    (`rankTrails`: one streak-length of offset counts like 10° of angle; angles
    compared modulo 180° on the detector, so the ranking is right under any
    rotation and for a parked mount). Clicking a row selects that object.
  - **Parked mount, RA/Dec pointing.** The scan converts the RA/Dec to alt/az
    once, at its start, and holds it; while that scan is current the chart
    holds the same pair (`parkedAzEl`) and reads `rotDeg` at the same instant
    (`scanRefMs`). Re-deriving the alt/az from the RA/Dec at every clock time,
    as before, re-aimed the "parked" mount whenever the clock moved.
- Interaction: moving the cursor shows RA/Dec (and Alt/Az) in the status line.
  **A trail can be hovered and clicked anywhere along its length** — within 7 px
  of its polyline — as well as on its marker (8 px): hover picks it and opens
  the **hover card** (name, type and class; entry → exit and duration; the
  instant at the hovered point; rate, position angle and trail length — on the
  detector when the mount is parked; magnitude, range, sunlit/eclipsed; element
  age and the expected error); click selects, click elsewhere deselects;
  shift-click re-aims but keeps the view still, double-click re-aims centred
  (both mark the scan stale; in alt/az mode the az/el pair is carried along so
  a parked mount re-aims too).
- Performance: dirty flag + rAF, devicePixelRatio aware, `'win-resize'` listener.
  Star cone results are cached and only re-queried when the tangent point or radius
  changes by more than 10% of the field. A trail is two strokes (swept, to come),
  not one per segment.
- Expose: `SAT.chart = { init, requestRender, fitView, autoMagLimit, starDot,
  satLabel, tickStepS, tickLabel, timelineStepS, packLanes, lineAngleDiff,
  rankTrails, circTanDeg, applyStarBudget }` (all but the first three pure, unit-tested in
  tools/test_chart.js, which also drives the real mouse and key handlers and
  asserts that no two pieces of chart text overlap).

### SAT.ui.crossings.init(bodyEl, win) — AGENT T (js/crossings.js) — MAIN LIST

The satellite list. Second-largest default window, docked beside the chart.

- Header: **Scan** button (primary; disabled while running, becomes **Cancel**),
  a progress bar with `done/total` and the current phase, and a summary line
  (`27 843 objects → 9 612 after geometry → 61 crossings in 2.3 s`). When
  `SAT.state.scan.stale`, the header shows an amber "parameters changed — rescan"
  tag rather than silently showing old results.
- Filter rows (order fixed in round 2): sunlit-only, altitude range (geodetic
  height at CA, km), magnitude limit, orbit-class chips, rate range, free-text
  name/NORAD search; a second chip row filters by SATCAT object type
  (payload / rocket body / debris / unknown — typeless objects sit in `unknown`).
  All write to `SAT.state.filters` and emit `'filters-changed'` — filtering never
  triggers a rescan.
- A **pick column** (checkboxes) sits before Name, outside the sortable/togglable
  column set: ticked rows narrow what the sky chart and all-sky view draw
  (`state.chartCrossings()`), while the table keeps listing everything so ticks
  can be undone. The header shows the tick count and clears all on click; ticks
  are runtime-only and reset on every new scan.
- Table columns (all sortable; a **Columns** button toggles visibility, persisted in
  `settings`): Name, NORAD, Int'l, Class, Enter (UTC), CA (UTC), Exit, Dur,
  Sep@CA, RA/Dec (J2000), Az, El, Range, Rate ″/s, PA, Mag, Method, Sunlit, TLE age.
  Rate/PA follow `obs.track` ('sky' ⇒ vs stars, 'mount' ⇒ vs horizon), the header
  names the frame, and the orbit-class chips/column stay — class is the fastest
  first cut a user makes on a candidate list.
  Numeric cells use `.num` (tabular monospace).
- Row click → select the object (`'selection-changed'`, chart highlights + centres if
  off-screen). Row double-click → `SAT.clock.setDate(tCaMs)`, i.e. jump the animation
  to that crossing. Row hover → chart highlights that path.
- **Copy / Export** buttons: copy the visible table as TSV, or download CSV / JSON of
  the filtered crossings (client-side Blob; no backend round-trip).
- Empty states are explicit: no site, no catalogue, not scanned yet, scanned and
  genuinely empty, and truncated — each with the action that fixes it.
- Expose: `SAT.ui.crossings = { init, refresh }`.

### SAT.ui.pointing.init(bodyEl, win) — AGENT I (js/pointing.js)

The input window — everything on the left of the problem statement. **Compact**:
one control row per line, label column narrow ("Start", "Span", "Mode", "RA", …),
no section headers taking their own line, no wrapped rows.

- Site: dropdown of `SAT.state.locations` (active one selected), with a link to open
  the Locations window.
- **Start**: bound to `SAT.clock` (a **Now** button syncs). The field is wide enough
  to show the FULL `YYYY-MM-DD HH:MM:SS` — a truncated timestamp was a round-1
  review complaint. **Span** with quick chips (1 m, 3 m, 5 m, 10 m, 1 h — the 6 h /
  24 h chips were dropped in round 3; a long span is still typable).
- **Mode**: toggle **RA/Dec** ⇄ **Alt/Az** plus the track toggle (Sky/Mount).
  Switching mode converts the current pointing through `SAT.frames` at the current
  time (so the two views agree), and sets `track` to the mode's default.
- Coordinates, four rows (RA, Dec, Az, El): each row carries BOTH a sexagesimal
  field and a decimal-degrees field, **both editable**, kept in sync — editing
  either updates state and rewrites the other. The active mode's pair is live; the
  other pair is derived and read-only. RA accepts `hh mm ss.s`, `hh:mm:ss` or
  decimal; Dec `±dd mm ss` etc. Reject out-of-range sexagesimal fields ("99 99 99"
  wraps into a plausible but wrong pointing — SAT.util.sexParts guards this).
- Presets: **Zenith**, **Sun**, **Moon**, **Anti-sun**, and "from selected object".
- FOV: shape toggle, width/height (or radius) with a °/′ unit toggle, rotation,
  E/W flip, and a **camera preset** dropdown (name, w, h) persisted in settings —
  laid out as a tight grid, not a tall stack. **No built-in presets** (round-2
  review): they were one person's guesses about other people's equipment; the
  dropdown holds only what the user saves.
- There is deliberately NO exposure length and NO plate scale (round-1 review):
  the scan timespan is the only time quantity, and the trail across the field is
  the identification tool.
- Every edit routes through `SAT.state.setObs(patch)`; nothing here starts a scan.
- Expose: `SAT.ui.pointing = { init, refresh }`.

### SAT.allsky.init(bodyEl, win) — (js/allsky.js)

Port of SatObserver's `skychart.js`, reduced to a **context view**: polar alt/az
all-sky chart of the active site. **HUD (round 19 — one line only):** the FOV
line (`FOV AZ … EL … · W° × H° (ONE decimal) · RA … Dec … · sun N°`); the former
footer — site name, sky/map-view label, crossing counts, track-cap notes — is
REMOVED at user request (the crossing bookkeeping lives in the Crossings
window). **All-Sky star background (round 12 — SatObserver
fallback, binding):** the star field is the bright catalogue `SAT.stardata` ONLY
(BSC5/HYG, V ≤ 4.6), drawn whole-hemisphere with SatObserver's radius/alpha law
(`rad = max(0.6, 2.7 − 0.45·mag)`, `alpha = max(0.25, 0.95 − 0.13·mag)`) —
`SAT.stars.cone` and the old `allsky.magLimit` are not used. With it come the
original's SN / CL / CN toggles and the two layers ported alongside:

- **Milky Way** isophotes (`vendor/mwdata.js`, `mw` toggle, default off) with
  SatObserver's rim-parity fill; the per-vertex J2000→horizontal conversion goes
  through a per-frame rotation matrix built from three `SAT.frames.raDecToAltAz`
  probes, so the glow shares the star layer's precession/nutation chain instead of
  re-deriving hour angles inline.
- **Sun & Moon** on a `sunMoon` toggle (default on): rayed sun disc; moon with its
  phase terminator, the mean-parallax elevation correction (−0.95°·cos el), bright
  limb toward the sun's chart position (valid below the horizon too — `project()`
  clamps elevation but keeps azimuth direction). Drawn only above the horizon, as
  in SatObserver.
- **Documented deviation from SatObserver:** NO twilight/daylight sky tint and no
  MW twilight fade — the background stays the fixed dark theme.

Also shows the horizon grid and — the point of it here — the **FOV footprint**
(the projected outline of the current field) plus the tracks of the objects in
`chartCrossings()`. Answers "where am I actually looking, and what else is up".
Secondary window, closed by default. Expose: `SAT.allsky = { init, requestRender }`.

### SAT.ui.sources.init / SAT.ui.locations.init / SAT.ui.satinfo.init

Ported from SatObserver. `sources` loses the family concept AND (round-1 review)
the CelesTrak **group** tab: a group subset invites "identify against Starlink
only", and a negative result from a subset means nothing. Round 13 brings
CelesTrak back as **single-object queries only**, which carry no such trap: a
CelesTrak tab with NORAD IDs (≤ 20; gp.php answers one CATNR per
request) / INTLDES–COSPAR (whole launch; a piece letter narrows it) / Name-contains
queries via `GET /api/celestrak/query`, merged additively under the `celestrak`
source tag (own ✕ clear button, own line in the freshness block, rehydrated via
`catalogRefs` like Space-Track and McCants). Round 21 added the CelesTrak **full
catalogue** (`GET /api/celestrak/full`, below; rebuilt in round 22 on launch-decade
queries after the bulk files proved unreachable): the whole set is not a subset,
so it carries none of the round-1 trap — the ban stays on *group* fetches.

**Top billing (round 21): two full-catalogue buttons, each naming its
provider.** The window's header block carries **Load full catalogue
(CelesTrak)** — no account needed — ABOVE **Load full catalogue (Space-Track)**
— the complete set, analyst objects included, credentials required — each with
its ⟳ force-refresh, its own status line, and a one-line **credentials-only**
hint beneath it (round 21 follow-up: the labels already name the provider, and
provider caveats such as the legacy-file warning surface via payload `notes[]`
on the status line when they apply, never as standing text; tab hints are
likewise one line). Each replaces only its OWN tag's set (`replace:true` on `celestrak` /
`spacetrack`), so the freshness block's provenance stays truthful whichever is
pressed; selected-object queries stay in the tabs below. The CelesTrak tab's
former "Fetch full SATCAT" button is relabelled **Fetch SATCAT metadata**
(round 21, after it was mistaken for a catalogue loader): it downloads
`satcat.csv` into the `satcat_bulk` cache — the exact table that feeds the
rcs/type photometry enrichment and the info panel — and adds NO objects to the
catalogue; its hint says so. It keeps the on-file status line
(`/api/satcat/bulk?status=1`, a slim probe that must never trigger the 7 MB
download by itself). `acceptPayload` surfaces a payload's `notes[]` on the
status line — a caveat like "legacy TLE file: post-2026-07 objects absent"
must reach the user, not just the JSON. Query-value inputs are deliberately
narrow (130 px): the row has to fit type selector, value, and buttons in the
default window width.

The catalogue is thus built from **Space-Track** (full catalogue
`replace:true`, plus one-off NORAD/name queries merged additively),
**CelesTrak** (full catalogue `replace:true` under its own tag, plus object
queries merged additively), **McCants** (files merged additively), and
**Paste** (each paste
merges additively; a clear button removes the pasted set). All loads go through
`SAT.state.addTles`. The
freshness display shows **epoch-age statistics per source** — count, newest, median,
oldest vs the sim clock, from `SAT.state.sourceStats()` — with the >3 d warning per
source, since a single merged "newest" line hides exactly the staleness that breaks
an identification. `satinfo` gains the photometry breakdown (which `method` produced
the magnitude, RCS, standard magnitude) and the SATCAT record.

## Backend — server.py (Python 3.13 stdlib ONLY)

`ThreadingHTTPServer` on `127.0.0.1:8476` (fall back +1.. if busy), same structure,
MIME table, `ApiError`, atomic-write and disk-cache conventions as SatObserver's
`server.py`. Port these hardening patterns verbatim — each of them fixes a bug that
was already paid for once:

- `_route()` resets per-request state (`_head_only`, `_body_cache`) at the top and
  **drains the request body before any error response**. One handler instance serves
  many keep-alive requests; a cached body replayed into the next request wiped
  `state.json` in SatObserver.
- `atomic_write()` creates the temp file with its final mode (never briefly
  world-readable), then `os.replace()`; a module-level `_IO_LOCK` serializes writes.
- Anchored regexes validate every path-ish parameter (`CACHE_KEY_RE`, `GROUP_ID_RE`);
  static files are served only after `target.is_relative_to(APP_DIR)`.
- Download caps (32 MB fetched / 128 MB unzipped) on every outbound fetch.
- Cache reads follow one shape: fresh → serve; stale + network error → serve with
  `"stale": true`; no cache + error → `ApiError(502, ...)`.

Ported endpoints, unchanged in behaviour:

- `GET /api/ping`, `GET /api/celestrak/groups`, `GET /api/celestrak/tle?group=`
- `POST /api/spacetrack/tle`, `GET /api/spacetrack/config`
- `POST /api/mccants/tle`, `POST /api/text/tle`
- `GET|DELETE /api/cache[/<key>]`, `GET|PUT /api/state`
- `GET /api/satcat?norad=N`
- `GET /api/celestrak/query?type=norad|intldes|name&value=…[&refresh=1]` (round 13,
  ported from SatObserver's `celestrak_query_urls` + `_celestrak_query`): gp.php
  single-object lookups — one CATNR request per NORAD id (≤ 20), INTDES takes the
  yyyy-nnn launch with piece letters as a post-filter on OBJECT_ID, NAME is a
  substring. Two SatIdentifier adaptations: the result is **enriched** via
  `enrich_best_effort` (its objects enter the scanning catalogue) and carries
  `cacheKey` (`celestrak_q_<sha1[:12]>`) so `catalogRefs` re-hydration works.

New or changed:

- `GET /api/catalog/full[?refresh=1]` — the object set the scan runs against.
  Space-Track `class/gp/decay_date/null-val/epoch/>now-30` — **Space-Track only**
  (round-1 review removed the CelesTrak fallback: the UI reports provenance per
  source, and a silently swapped dataset would scramble it; round 21's CelesTrak
  full catalogue is a separate, explicitly-labelled endpoint and button, never a
  silent fallback here). 401 with a message
  naming the fix when no credentials are saved. Returns a `TlePayload` **enriched**
  with `rcs`, `type` and `stdMag` per object by joining the two tables below, and
  carrying `cacheKey` so the frontend can re-hydrate the exact payload from
  `/api/cache/<key>` on reload. Cached as `catalog_full.json`, fresh < 6 h, stale
  fallback with `"stale":true`. Every other TLE endpoint (Space-Track queries,
  McCants, pasted text) applies the same enrichment best-effort and carries
  `cacheKey` where a cache exists — their objects enter the same scanning
  catalogue and need the same photometry joins.

### Catalog numbers past 100000 — do not regress this

The public catalogue passed NORAD 100000 in June 2026, so **every provider is fetched
as OMM — `FORMAT=json`, or `FORMAT=csv` for `/api/celestrak/full` — never
`FORMAT=tle`/`3le`** (round 22 removed the one exception, the legacy
`catalog.txt` fallback). The authoritative NORAD id is the
integer `NORAD_CAT_ID` field; the TLE line pair is taken from the record when present
or synthesized by the server-side `omm_to_tle` writer, which encodes columns 3–7 as
Alpha-5 for 100000–339999 and writes the placeholder `'00000'` above that (checksums
recomputed). Propagation never reads `satnum`, so the placeholder is harmless — but
the payload's integer `norad` must always be the true id, because it is the join key
for SATCAT/qsmag and the thing the user types into a search box. Port `catnum()`,
`catnum5()` and `omm_to_tle()` from SatObserver's `server.py` verbatim.

This matters more here than in SatObserver: that app imports hand-picked objects,
whereas this one runs against the **whole** catalogue, where the high-numbered recent
launches and analyst objects are exactly the unidentified trails people are chasing.
- `GET /api/celestrak/full[?refresh=1]` (round 22) — the no-account full
  catalogue, **assembled from gp.php queries**. gp.php offers no all-objects
  query, and the bulk files round 21 used (`/pub/TLE/catalog.csv`,
  `catalog.txt`) answer 403 from any address CelesTrak has rate-blocked for
  them — measured permanent on a shared exit address, and the reason this
  endpoint "always failed". But `INTDES` matches by **prefix**: a three-digit
  launch decade (`INTDES=202`) returns every object launched in the 2020s. One
  query per decade since `195`, plus `GROUP=analyst` for the objects with no
  international designator, is the whole catalogue in nine requests
  (`celestrak_full_parts()`; 32 912 objects, 4.7 MB of OMM CSV, 2026-11-15; the
  decade list grows by itself in 2030), parsed by `parse_omm_csv` through the
  same `omm_to_tle` synthesis path as the JSON endpoints — 6-digit and analyst
  objects included. Three rules from CelesTrak's usage policy shape it, and all
  three are **binding**:
  - **One download per update.** CelesTrak refreshes GP data every 2 h and
    answers 403 to a repeat of a query it already served in that cycle
    (enforced since 2026-03); 50 HTTP errors in 2 h firewalls the address. So
    nothing is re-requested inside `CELESTRAK_UPDATE_S` (2 h): the assembled
    payload is served as-is in that window **even on `refresh=1`** (with a note
    saying so), and each part is cached on its own (`celestrak_full_parts.json`)
    so a load that failed at part 6 resumes at part 6. The same floor applies to
    `/api/celestrak/query` and `/api/celestrak/tle`.
  - **Stop on the first non-200.** No retry, no next part. The reason CelesTrak
    gives in the error body (`http_error_text`, tags stripped) is passed to the
    user, with how many parts are saved.
  - **Sequential**, `CELESTRAK_PAUSE_S` between requests.
  Enriched and counted exactly like `/api/catalog/full` (`enrich_full_catalog`);
  cached as `celestrak_full.json`, served without a request for 6 h
  (`CATALOG_FRESH_S`); its `fetchedUnix` is that of its **oldest** part. On a
  failure with an older copy on disk, that copy is served with `"stale":true`
  and the reason in `notes`. Pinned by `tools/test_server.py` (36 checks, no
  network).
- `GET /api/satcat/bulk[?refresh=1]` — the whole CelesTrak SATCAT
  (`https://celestrak.org/pub/satcat.csv`), parsed to `{norad: {intl, rcs, name,
  launch, owner, opStatus}}`. Cached 30 d as `satcat_bulk.json`. This is what
  supplies `rcs` for the photometry fallback. Round 13 adds `?status=1`: a slim
  `{present, count, fetched, stale}` probe for the Catalogue window's status line —
  alone it only PEEKS at the disk cache (never triggers the 7 MB download);
  combined with `refresh=1` it downloads first, which also warms the enrichment
  join every TLE endpoint uses.
- `GET /api/qsmag[?refresh=1]` — McCants standard magnitudes
  (`https://www.mmccants.org/programs/qsmag.zip`), extracted in memory and parsed to
  `{norad: stdMag}`. Cached 30 d as `qsmag.json`. Missing file ⇒ `{ok:true, mags:{}}`
  and the UI simply falls back to the RCS tier — never a hard failure.
- `GET /api/stars/deep` (round 15) — presence probe for the deep tile set:
  `{ok, present}` plus, when present, the `index.json` fields
  `{magLimit, count, tiles, builtIso, epochYr}`. Reads `DATA_DIR/deepstars/`;
  never touches the network (the round-14 online `/api/stars/cone` endpoint is
  REMOVED — the backend does no star fetching at runtime at all).
- `GET /api/stars/tile/<name>` (round 15) — one deep tile as raw bytes
  (`application/octet-stream`, the STR1 binary). `<name>` must match
  `^t\d{1,2}_\d{1,2}\.bin$` (400 otherwise — the path is user-influenced and
  goes to the filesystem); 404 when the tile set or the tile is absent, which
  the frontend treats as "not built", not as an error to retry.
- `GET /api/state` payload carries `catalogRefs` (per-source cache keys) and
  `pasted` (inline pasted TLEs); cached catalogues themselves are never stored in
  `state.json`.

`TlePayload = {ok:true, source, fetched:"<iso>", count:N,
tles:[{name, l1, l2, norad, intl, rcs, stdMag}]}`.

Shared TLE parser identical to SatObserver's (3-line, 2-line, McCants `0 NAME`,
Alpha-5 catalog numbers, malformed pairs skipped). Fetch timeouts 30 s;
`User-Agent: SatIdentifier/0.1`. On startup print the URL and `webbrowser.open` it
unless `--no-browser`. `--port N`. NO third-party imports.

## House style (binding — agents match this, not their own habits)

**Python.** Module docstring, grouped stdlib imports, constants block with inline unit
comments, `# ---- banner ----` section dividers. `snake_case`, private handler methods
prefixed `_`. PEP 257 one-line docstrings for small helpers, multi-paragraph where
there is subtlety. **No type hints, no logging module, no third-party imports.**
Request logging is one hand-formatted `print(..., flush=True)` line.

**JavaScript.** Two dialects, split by module kind — follow the one that matches:
- *Core / UI modules* (`util, state, clock, propagate, frames, stars, photometry,
  scan, sources, locations, satinfo, pointing, crossings, main`): modern — `const`/
  `let`, arrow functions, `async/await`.
- *Canvas view modules* (`chart, allsky`): conservative ES5 flavour — `var`
  throughout, `function () {}` callbacks, module state hoisted to the top of the IIFE,
  and a boxed `/* ===== file — SAT.x : one-line purpose ===== */` header.

Both: 2-space indent, semicolons, single quotes, one IIFE per file with `'use strict'`,
exactly one `SAT.*` assignment at the bottom. Never `innerHTML` for dynamic content —
build DOM with `SAT.util.el(tag, attrs, children)`, which is the backbone of all UI
code here.

**Comments explain *why*, and name the consequence.** This is the most distinctive
trait of the codebase; a comment that restates the code is worse than none:

```js
// pass tracks are cut at 1° rather than 0°: below that, refraction and TLE
// error dominate and the AOS time is not meaningful to the second
```

**Canvas panels** follow one template: `injectStyle()` guarded by an element id and
prefixed per module (`chart-`, `ask-`); dirty-flag + rAF `requestRender()` that skips
work when the window is closed and swallows render errors after one `console.warn`;
`resize()` driven by both `'win-resize'` and a `ResizeObserver`; `ctx.setTransform(dpr,
0,0,dpr,0,0)` for HiDPI; a top-left toolbar of `.btn.small` chips at `opacity:.85`
(accent outline when active); `rgba(10,14,18,0.62)` HUD pills with
`font-variant-numeric: tabular-nums`; and every label stroked in `rgba(5,8,12,0.85)`
with `lineJoin:'round'` before filling, so text stays legible over the star field.

**Backend calls** go through one `api(path, opts)` wrapper that throws on
`{ok:false}`. Status text uses `✓` success, `✗` failure, `⟳` refresh, `…` in progress,
`⚠` confirm-danger. Destructive actions confirm by requiring a second click on a
re-labelled button within 5 s — no modal dialogs. Empty states use `.msg-empty` and
always name the action that fixes them.

## Packaging

Same as SatObserver: `desktop.py` opens a pywebview window on the local server, and
PyInstaller bundles it. macOS build is a one-liner; Windows is produced by a
`windows-latest` GitHub Actions runner (PyInstaller cannot cross-compile) which
commits the zip back into `release/` with `[skip ci]`.

```sh
.venv-build/bin/pyinstaller --noconfirm --clean --windowed \
  --name "SatIdentifier" --icon build_icon/SatIdentifier.icns \
  --add-data "app:app" --osx-bundle-identifier "local.satidentifier" desktop.py
```

When frozen, static assets come from `sys._MEIPASS` and user data goes to
`~/Library/Application Support/SatIdentifier` (or `%APPDATA%`), never inside the
bundle — port the `IS_BUNDLED` / `DATA_DIR` block from SatObserver's `server.py`.
`data/` is gitignored (it holds Space-Track credentials); `release/` is committed.

## Look & feel

Identical dark technical theme to SatObserver — same CSS variables (`--bg #101418`,
`--fg #e8eaed`, `--accent #4fc3f7`, `--mono`), same `.btn / .input / .select / .table /
.win / .tag` classes, same menubar pattern (title, window toggles, clock + rate on the
right). `app.css` is ported wholesale; per-window styling is injected by each module
with a prefixed class (`chart-`, `xin-`, `pnt-`) exactly as `skychart.js` does.

**Targets are coloured by OBJECT TYPE** (round-5 review), one palette across the
sky chart, all-sky view and the table's Type chips — **user-editable** (round 6)
via swatches in the Crossings filter row, stored in `settings.typeColors` and
resolved everywhere through `SAT.state.typeColorOf(t)` so one override applies to
every view at once (invalid saved values fall back to defaults). Defaults:
`PAY #ffd54f` (deliberately warm — LEO payloads dominate any scan and must not read
as the blue/pale-green UI theme), `R/B #ff7043`, `DEB #f06292` (pink — the round-5
brown-grey read as darker yellow next to PAY at trail alpha), `UNK #90a4ae`.
Orbit-class colours survive only on the table's Class chips:
`leo #4fc3f7`, `meo #7ad97a`, `geo #ffb84f`, `heo #c792ea`.
Every trail carries one arrowhead ~60% along showing the pass motion direction —
a streak on a real frame has no arrow, so the chart must supply the disambiguation.

Default layout on first run: Sky Chart top-left (large), Crossings right (full
height), Pointing bottom-left, everything else closed.
