/* Verification for app/js/worker/scan-worker.js — the scan engine's core.
 * Run: node tools/test_scan.js [path/to/catalogue.tle | cache.json]
 *
 * Three things are checked, in increasing order of how badly a failure would hurt:
 *
 *  (a) CORRECTNESS — every crossing returned really is inside the field at its
 *      tCaMs, recomputed independently through frames.js rather than by trusting
 *      the worker's own numbers.
 *  (b) SOUNDNESS OF THE STAGE 1 CULL — the same scan with the geometric cull
 *      switched off must find the IDENTICAL crossing set. The cull is the only
 *      part of the algorithm that can lose a real object without leaving a trace,
 *      so it gets an exact set comparison, not a tolerance.
 *  (c) COST — wall clock and the per-stage culled counts, which the UI has to
 *      show: a scan that removes 90% of the catalogue must say so, or a bug in
 *      the cull is indistinguishable from "no satellites tonight".
 *
 * Round 22 added the three checks that pin the rewritten stages 2 and 3:
 *  (r) RECALL against an exhaustive brute force that shares nothing with the
 *      engine — every crossing found, sub-second ones included;
 *  (k) the CLEAR-TIME BOUND itself, walked instant by instant;
 *  (h) nothing reported from below the horizon.
 *
 * With no argument the catalogue is the app's own disk cache (data/cache/).
 */
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', 'app', 'js');

global.window = global;
global.satellite = require(path.join(APP, 'vendor', 'satellite.min.js'));
global.SAT = { ui: {} };
require(path.join(APP, 'frames.js'));
const F = SAT.frames;

const worker = require(path.join(APP, 'worker', 'scan-worker.js'));

let failures = 0;
function ok(name, cond, detail) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}

/* ---- catalogue ----------------------------------------------------------- */

const DATA = path.join(__dirname, '..', 'data', 'cache');
const CANDIDATES = [
  process.argv[2],
  // the app's own disk cache: present after any full-catalogue load in dev mode
  path.join(DATA, 'celestrak_full.json'),
  path.join(DATA, 'catalog_full.json'),
  '/tmp/active.tle',
].filter(Boolean);

const src = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
if (!src) {
  console.error('No catalogue found. Load one in the app (dev mode writes data/cache/), ' +
    'or pass a 3LE file:\n  node tools/test_scan.js path/to/catalogue.tle');
  process.exit(2);
}

/** TLE catalogue-number field -> integer, Alpha-5 included ('A0057' = 100057;
 *  I and O are skipped). parseInt alone turns every 6-digit object into NaN, and
 *  an id built from that collides — which is how this harness once "found" a
 *  crossing 160 degrees outside the field: it had looked up the wrong object. */
function catnum(f) {
  const c = f.charCodeAt(0);
  if (c >= 65 && c <= 90) {
    const v = c - 55 - (c > 73 ? 1 : 0) - (c > 79 ? 1 : 0);
    return v * 10000 + parseInt(f.slice(1), 10);
  }
  return parseInt(f, 10);
}

const objs = [];
function addObj(name, l1, l2) {
  if (!l1 || l1[0] !== '1' || !l2 || l2[0] !== '2') return;
  objs.push({
    id: 'o_' + objs.length, norad: catnum(l2.slice(2, 7)), name: (name || '').trim(),
    intl: l1.slice(9, 17).trim(), l1: l1, l2: l2, rcs: null, stdMag: null,
  });
}
if (/\.json$/.test(src)) {
  JSON.parse(fs.readFileSync(src, 'utf8')).tles.forEach((t) => addObj(t.name, t.l1, t.l2));
} else {
  const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/);
  for (let i = 0; i + 2 < lines.length; i += 3) addObj(lines[i], lines[i + 1], lines[i + 2]);
}
console.log(`catalogue: ${src}\n           ${objs.length} objects`);
const byId = new Map(objs.map((o) => [o.id, o]));

let t = Date.now();
const loaded = worker.loadObjs(objs);
console.log(`           ${loaded.count} satrecs built in ${Date.now() - t} ms ` +
  `(${loaded.bad} rejected as invalid)`);

// The catalogue's MEDIAN element epoch fixes a sensible scan time: scanning a week
// away from the elements would exercise TLE decay, not the scan engine. (The
// newest epoch is not safe — a single pre-launch or mis-dated element set sits
// weeks ahead of everything else and drags the whole run there.)
const epochs = [];
for (const o of objs) {
  const r = satellite.twoline2satrec(o.l1, o.l2);
  if (r && isFinite(r.jdsatepoch)) epochs.push(r.jdsatepoch);
}
epochs.sort((x, y) => x - y);
const medianJd = epochs[epochs.length >> 1];
const T0 = new Date(Math.round((medianJd - 2440587.5) * 86400) * 1000);
console.log(`           median element epoch ${T0.toISOString()} — scanning from there`);

/* ---- scan parameters ----------------------------------------------------- */

const SITE = { latDeg: 43.9, lonDeg: -103.5, altM: 1200 };   // mid-latitude, Black Hills

function params(over) {
  return Object.assign({
    t0Ms: T0.getTime(),
    spanMin: 60,
    site: SITE,
    pointing: { track: 'sky', mode: 'radec', raDeg: 260.0, decDeg: 35.0, refract: true },
    fov: { shape: 'circ', rDeg: 30, wDeg: 0, hDeg: 0, rotDeg: 0 },
    filters: { minElDeg: 0 },
    steps: { coarseStepS: 30, fineStepS: 1.0, marginDeg: 0 },
    dut1S: 0,
  }, over || {});
}

const C_KM_S = 299792.458;

/** Astrometric topocentric vector (TEME) at `d`: the satellite where it was when
 *  the light left it. Iterated, re-propagating to the retarded time each pass —
 *  the worker applies the first-order form, so this is a different computation. */
function astrometricTopo(rec, d, obsPos) {
  let topo = null, rho = 0;
  for (let it = 0; it < 3; it++) {
    // a Date holds whole milliseconds: propagate to the millisecond at or before
    // the retarded instant and carry the remaining fraction on the velocity
    const tRet = d.getTime() - rho / C_KM_S * 1000;
    const whole = Math.floor(tRet), rem = (tRet - whole) / 1000;
    const pv = satellite.propagate(rec, new Date(whole));
    if (!pv || !pv.position) return null;
    topo = {
      x: pv.position.x + pv.velocity.x * rem - obsPos.x,
      y: pv.position.y + pv.velocity.y * rem - obsPos.y,
      z: pv.position.z + pv.velocity.z * rem - obsPos.z,
    };
    rho = Math.hypot(topo.x, topo.y, topo.z);
  }
  return topo;
}

/** Recompute a crossing's separation from the field centre from first principles:
 *  raw SGP4 -> astrometric topocentric TEME -> J2000 via frames.js -> Vincenty
 *  separation. Shares nothing with the worker except satellite.js itself. */
function independentSep(cr, p) {
  const o = byId.get(cr.satId);
  const rec = satellite.twoline2satrec(o.l1, o.l2);
  const d = new Date(cr.tCaMs);
  const topo = astrometricTopo(rec, d, F.siteTemeKm(p.site, d, 0));
  if (!topo) return null;
  const rd = F.vecToRaDec(F.temeToJ2000(topo, d));
  const aa = F.raDecToAltAz(rd.raDeg, rd.decDeg, p.site, d, { refract: false });
  return {
    sepDeg: F.sep(rd.raDeg, rd.decDeg, p.pointing.raDeg, p.pointing.decDeg),
    raDeg: rd.raDeg, decDeg: rd.decDeg, elDeg: aa.elDeg, topo: topo,
  };
}

const key = (c) => c.satId + '@' + Math.round(c.tCaMs / 1000);

async function scan(p, label) {
  const t = Date.now();
  const res = await worker.runScan(p);
  const ms = Date.now() - t;
  if (label) {
    const c = res.culled;
    console.log(`  ${label.padEnd(26)} ${String(res.crossings.length).padStart(5)} crossings  ` +
      `${String(ms).padStart(6)} ms  ${(res.propagations / 1e6).toFixed(2)} M props`);
    console.log(`  ${''.padEnd(26)} stage1 culled ${c.stage1} of ${c.total - c.bad} ` +
      `(${(100 * c.stage1 / Math.max(1, c.total - c.bad)).toFixed(1)}%) -> ${c.survivors} survivors; ` +
      `stage2 culled ${c.stage2} -> ${c.candidates} candidates; stage3 dropped ${c.stage3}`);
  }
  res.wallMs = ms;
  return res;
}

/* ========================================================================== */

(async () => {
  // ------------------------------------------------------------------ test a
  console.log('\n[a] wide-field scan: 30 deg radius, mid-latitude site, 1 hour');
  const pA = params();
  const A = await scan(pA, 'stage 1 ON');

  ok('found a plausible number of crossings',
    A.crossings.length > 20 && A.crossings.length < 20000,
    `(${A.crossings.length})`);

  let worstSep = -1, worstName = '', badRa = 0, checked = 0, worstRa = 0;
  for (const c of A.crossings) {
    const ind = independentSep(c, pA);
    if (!ind) continue;
    checked++;
    if (ind.sepDeg > worstSep) { worstSep = ind.sepDeg; worstName = c.name; }
    const dRa = F.sep(ind.raDeg, ind.decDeg, c.raDeg, c.decDeg) * 3600;
    if (dRa > worstRa) worstRa = dRa;
    // 0.5": the reference goes through satellite.propagate(Date), whose Julian
    // date resolves only ~40 us — 0.3 m of LEO motion, 0.2" at 300 km range
    if (dRa > 0.5) badRa++;
  }
  ok('every crossing is inside the FOV at tCaMs (independent recompute)',
    worstSep <= pA.fov.rDeg,
    `worst ${worstSep.toFixed(4)} deg vs ${pA.fov.rDeg} deg limit  [${worstName}]  (${checked} checked)`);
  ok('reported RA/Dec matches an independent ASTROMETRIC recompute to < 0.5 arcsec',
    badRa === 0, `worst ${worstRa.toFixed(4)} arcsec (light time included on both sides)`);

  let monotone = true, pathOk = true, ordered = true;
  let prev = -Infinity;
  for (const c of A.crossings) {
    if (!(c.tEnterMs <= c.tCaMs && c.tCaMs <= c.tExitMs)) monotone = false;
    if (!(c.path && c.path.length >= 2 && c.path.length <= 64)) pathOk = false;
    if (c.tCaMs < prev) ordered = false;
    prev = c.tCaMs;
  }
  ok('tEnter <= tCa <= tExit for every crossing', monotone);
  ok('path has 2..64 samples for every crossing', pathOk);
  ok('crossings are sorted by tCaMs', ordered);

  // Narrow field: this is where the cull actually bites, and where an error in
  // the FOV boundary would show up as a sepCa just outside the radius.
  console.log('\n[a2] narrow-field scan: 4 x 3 deg rectangle, rotated 25 deg, 6 hours');
  const pN = params({
    spanMin: 360,
    fov: { shape: 'rect', wDeg: 4, hDeg: 3, rDeg: 0, rotDeg: 25 },
    steps: { coarseStepS: 30, fineStepS: 0.5, marginDeg: 0 },
  });
  const N = await scan(pN, 'stage 1 ON');
  ok('narrow field finds crossings (otherwise the test below is vacuous)',
    N.crossings.length > 5, `(${N.crossings.length})`);
  let rectOk = true, worstRect = 0;
  for (const c of N.crossings) {
    const ind = independentSep(c, pN);
    if (!ind) continue;
    const p = F.tanProject(ind.raDeg, ind.decDeg, pN.pointing.raDeg, pN.pointing.decDeg);
    if (!p) { rectOk = false; continue; }
    // rotDeg is the position angle of chart +Y, N through E
    const r = pN.fov.rotDeg * F.D2R, cr = Math.cos(r), sr = Math.sin(r);
    const X = p.xi * cr - p.eta * sr, Y = p.xi * sr + p.eta * cr;
    const over = Math.max(Math.abs(X) - pN.fov.wDeg / 2, Math.abs(Y) - pN.fov.hDeg / 2);
    if (over > worstRect) worstRect = over;
    if (over > 1e-6) rectOk = false;
  }
  ok('every crossing is inside the rectangle at tCaMs',
    rectOk, `worst overshoot ${(worstRect * 3600).toFixed(3)} arcsec`);

  // ------------------------------------------------------------------ test b
  console.log('\n[b] stage 1 soundness: cull ON must equal cull OFF');
  for (const [label, p] of [['30 deg circle', pA], ['4 x 3 deg rect', pN]]) {
    const on = (label === '30 deg circle') ? A : N;
    const off = await scan(Object.assign({}, p, { useStage1: false }), 'stage 1 OFF (' + label + ')');
    const sOn = new Set(on.crossings.map(key));
    const sOff = new Set(off.crossings.map(key));
    const lost = [...sOff].filter((k) => !sOn.has(k));
    const gained = [...sOn].filter((k) => !sOff.has(k));
    ok(`identical crossing set, ${label}`,
      lost.length === 0 && gained.length === 0,
      `culled-off found ${sOff.size}, culled-on found ${sOn.size}` +
      (lost.length ? `; LOST BY THE CULL: ${lost.slice(0, 12).join(', ')}` : '') +
      (gained.length ? `; only with cull: ${gained.slice(0, 12).join(', ')}` : ''));
    if (lost.length) {
      console.log('        ^ the stage 1 cull is UNSOUND — it dropped real crossings.');
      for (const k of lost.slice(0, 5)) {
        const c = off.crossings.find((x) => key(x) === k);
        console.log(`          ${c.name} (${c.norad}) ${c.cls} sep ${c.sepCaDeg.toFixed(3)} deg ` +
          `el ${c.elDeg.toFixed(1)} range ${c.rangeKm.toFixed(0)} km`);
      }
    }
  }

  // A pointing at the celestial pole should annihilate the GEO belt — the cull's
  // headline claim in CONTRACT.md. If it does not, the plane test is not working.
  console.log('\n[b2] pole pointing must kill the GEO belt');
  const pPole = params({
    pointing: { track: 'sky', mode: 'radec', raDeg: 0, decDeg: 89.9, refract: true },
    fov: { shape: 'circ', rDeg: 2, wDeg: 0, hDeg: 0, rotDeg: 0 },
  });
  const Pl = await scan(pPole, 'pole, 2 deg circle');
  const off = await scan(Object.assign({}, pPole, { useStage1: false }), 'pole, stage 1 OFF');
  const sOn = new Set(Pl.crossings.map(key)), sOff = new Set(off.crossings.map(key));
  const lost = [...sOff].filter((k) => !sOn.has(k));
  ok('identical crossing set at the pole', lost.length === 0,
    `${sOff.size} vs ${sOn.size}` + (lost.length ? `; LOST: ${lost.slice(0, 8).join(', ')}` : ''));
  ok('cull removes most of the catalogue at the pole',
    Pl.culled.stage1 / Math.max(1, Pl.culled.total - Pl.culled.bad) > 0.5,
    `${(100 * Pl.culled.stage1 / Math.max(1, Pl.culled.total - Pl.culled.bad)).toFixed(1)}% culled`);

  // Alt/az "mount" tracking exercises the per-epoch pointing path.
  console.log('\n[b3] mount tracking (field fixed in alt/az)');
  const pM = params({
    pointing: { track: 'mount', mode: 'altaz', azDeg: 180, elDeg: 55, refract: true },
    fov: { shape: 'circ', rDeg: 5, wDeg: 0, hDeg: 0, rotDeg: 0 },
  });
  const M = await scan(pM, 'mount, 5 deg circle');
  const Moff = await scan(Object.assign({}, pM, { useStage1: false }), 'mount, stage 1 OFF');
  const mOn = new Set(M.crossings.map(key)), mOff = new Set(Moff.crossings.map(key));
  const mLost = [...mOff].filter((k) => !mOn.has(k));
  ok('identical crossing set under mount tracking', mLost.length === 0,
    `${mOff.size} vs ${mOn.size}` + (mLost.length ? `; LOST: ${mLost.slice(0, 8).join(', ')}` : ''));

  // ------------------------------------------------------------------ test b4
  // Stage 1 soundness is an exact set comparison; stage 2 recall cannot be, because
  // there is no ground truth. The closest available proxy: re-run with the coarse
  // step equal to the fine step, so the coarse sweep can barely miss anything, and
  // check the 30 s sweep found the same objects.
  console.log('\n[b4] stage 2 recall: 30 s coarse sweep vs a 1 s sweep, 15 deg, 15 min');
  const pFast = params({ spanMin: 15, fov: { shape: 'circ', rDeg: 15, wDeg: 0, hDeg: 0, rotDeg: 0 } });
  const R30 = await scan(pFast, 'coarse 30 s');
  const R1 = await scan(Object.assign({}, pFast,
    { steps: { coarseStepS: 1, fineStepS: 1.0, marginDeg: 0 } }), 'coarse 1 s (reference)');
  const sat30 = new Set(R30.crossings.map((c) => c.satId));
  const sat1 = new Set(R1.crossings.map((c) => c.satId));
  const missed = [...sat1].filter((s) => !sat30.has(s));
  ok('the 1 s reference sweep finds objects (otherwise this test is vacuous)',
    sat1.size > 10, `(${sat1.size})`);
  ok('30 s coarse sweep misses no object the 1 s sweep found',
    missed.length === 0,
    `1 s found ${sat1.size} objects, 30 s found ${sat30.size}` +
    (missed.length ? `; MISSED: ${missed.slice(0, 10).join(', ')}` : ''));

  // ------------------------------------------------------------------ test b5
  // Both rate pairs must be present and in the right frame. The discriminating case
  // is GEO: it co-rotates with the Earth, so it drifts through the STAR field at
  // very nearly the sidereal rate while sitting still against the HORIZON. Getting
  // the omega x rho term backwards (or omitting it) doubles the mount rate to ~30"/s
  // instead of collapsing it to ~0, which this catches immediately.
  console.log('\n[b5] sky vs mount angular rates');
  // Aim at the GEO belt on the meridian: RA = local apparent sidereal time, and the
  // declination the belt sits at when viewed from this latitude (parallax pulls it
  // below the equator). Hard-coding an RA would put the field under the horizon,
  // which is how this test first came out empty.
  const lstDeg = ((F.lastRad(SITE, T0) * F.R2D) % 360 + 360) % 360;
  const pGeo = params({
    spanMin: 120,
    pointing: { track: 'sky', mode: 'radec', raDeg: lstDeg, decDeg: -5.7, refract: true },
    fov: { shape: 'circ', rDeg: 12, wDeg: 0, hDeg: 0, rotDeg: 0 },
  });
  console.log(`  field centre RA ${lstDeg.toFixed(2)} deg (= LST), Dec -5.7 deg`);
  const G = await scan(pGeo, 'GEO belt, 12 deg circle');

  const haveBoth = G.crossings.every((c) =>
    isFinite(c.rateAsPerS) && isFinite(c.paDeg) &&
    isFinite(c.rateMountAsPerS) && isFinite(c.paMountDeg));
  ok('every crossing carries both rate/PA pairs', haveBoth);

  const geos = G.crossings.filter((c) => c.cls === 'geo');
  ok('the scan found GEO objects (otherwise this test is vacuous)', geos.length > 3,
    `(${geos.length})`);
  if (geos.length) {
    const worstSkyErr = Math.max(...geos.map((c) => Math.abs(c.rateAsPerS - 15.0)));
    ok('GEO sky rate is ~15 arcsec/s (sidereal drift through the star field)',
      worstSkyErr < 3.0, `worst departure from 15"/s is ${worstSkyErr.toFixed(2)}"/s`);
    // "stationary against the horizon" is only true of an UNINCLINED bird: an
    // old GEO drifted to inclination i traces a daily figure-8 and moves at up
    // to ~omega_E*sin(i) against the horizon (i = 13 deg -> 3.4"/s, observed in
    // the wild 2026-07-25). Restrict the ~0 claim to i <= 0.5 deg, where the
    // physics actually promises < ~0.3"/s: this is what discriminates a
    // backwards (or omitted) omega x rho term, which reads ~30"/s.
    const incOf = new Map(objs.map((o) => {
      let inc = NaN;
      try { inc = parseFloat(o.l2.slice(8, 16)); } catch (e) { /* leave NaN */ }
      return [o.norad, inc];
    }));
    const flatGeos = geos.filter((c) => (incOf.get(c.norad) || 99) <= 0.5);
    if (flatGeos.length) {
      const worstMount = Math.max(...flatGeos.map((c) => c.rateMountAsPerS));
      ok('uninclined GEO mount rate is ~0 arcsec/s (stationary against the horizon)',
        worstMount < 1.0,
        `worst ${worstMount.toFixed(3)}"/s over ${flatGeos.length} birds with i <= 0.5 deg`);
    } else {
      console.log('  (no i <= 0.5 deg GEO in this field — mount-rate ~0 check skipped)');
    }
  }

  const leos = G.crossings.filter((c) => c.cls === 'leo');
  ok('LEO found for the rate-difference check', leos.length > 3, `(${leos.length})`);
  if (leos.length) {
    // The two frames differ by exactly the observer's rotation, which projects onto
    // the sky at no more than the ~15.04"/s sidereal rate whatever the geometry.
    const worstDiff = Math.max(...leos.map((c) => Math.abs(c.rateAsPerS - c.rateMountAsPerS)));
    ok('LEO sky and mount rates differ by no more than Earth rotation (~15"/s)',
      worstDiff <= 15.1, `worst difference ${worstDiff.toFixed(3)}"/s`);
  }

  // ------------------------------------------------------------------ test o
  // ORBITAL OBSERVING STATION (CONTRACT "Orbital observing stations"): the site
  // is a satellite from the catalogue itself. The proofs are the same shape the
  // ground pipeline shipped with — cull on/off identity, independent recompute —
  // plus the physics the amendment added: limb occlusion and self-exclusion.
  console.log('\n[o] orbital observing station');
  const issObj = objs.find((o) => o.norad === 25544 && /ZARYA/.test(o.name)) ||
    objs.find((o) => /^ISS \(ZARYA\)/.test(o.name));
  ok('catalogue contains an ISS to observe from (test scaffold)', !!issObj,
    issObj ? issObj.name : 'NOT FOUND');
  if (issObj) {
    const issRec = satellite.twoline2satrec(issObj.l1, issObj.l2);
    const OSITE = { kind: 'orbit', norad: issObj.norad, l1: issObj.l1, l2: issObj.l2,
      name: issObj.name };
    const RE = 6378.137;

    // observer/target geometry from first principles, sharing only satellite.js
    const stateOf = (rec, d) => {
      const pv = satellite.propagate(rec, d);
      return pv && pv.position ? pv : null;
    };
    const occludedLos = (s, r) => {
      const dx = r.x - s.x, dy = r.y - s.y, dz = r.z - s.z;
      const rho = Math.hypot(dx, dy, dz);
      const tStar = -(s.x * dx + s.y * dy + s.z * dz) / rho;
      if (!(tStar > 0 && tStar < rho)) return false;
      const s2 = s.x * s.x + s.y * s.y + s.z * s.z;
      return s2 - tStar * tStar < RE * RE;
    };

    // o1 — a GEO target seen from LEO: find a visible window and an occluded one.
    // GEO-from-ISS hides behind the Earth for a ~half-hour stretch once per orbit,
    // so both windows exist within any couple of hours.
    const geoObj = objs.find((o) => {
      const r = satellite.twoline2satrec(o.l1, o.l2);
      if (!r) return false;
      const rpd = (r.no_kozai != null ? r.no_kozai : r.no) * 1440 / (2 * Math.PI);
      return rpd >= 0.99 && rpd <= 1.01 && r.ecco < 0.01 && r.inclo < 3 * Math.PI / 180;
    });
    ok('catalogue contains a clean GEO target (test scaffold)', !!geoObj,
      geoObj ? geoObj.name : 'NOT FOUND');
    if (geoObj) {
      const geoRec = satellite.twoline2satrec(geoObj.l1, geoObj.l2);
      let tVis = null, tOcc = null;
      for (let m = 0; m <= 180 && !(tVis && tOcc); m += 2) {
        const d = new Date(T0.getTime() + m * 60000);
        // the whole 2-min scan window must sit inside the state, not just its start
        const states = [0, 60000, 120000].map((off) => {
          const dd = new Date(d.getTime() + off);
          const s = stateOf(issRec, dd), g = stateOf(geoRec, dd);
          return s && g ? occludedLos(s.position, g.position) : null;
        });
        if (states.some((x) => x == null)) continue;
        if (!tVis && states.every((x) => x === false)) tVis = d;
        if (!tOcc && states.every((x) => x === true)) tOcc = d;
      }
      ok('found both a visible and an occluded window (test scaffold)', !!(tVis && tOcc),
        `visible ${tVis && tVis.toISOString()}, occluded ${tOcc && tOcc.toISOString()}`);

      if (tVis && tOcc) {
        // aim at the target's topocentric direction at the window's midpoint;
        // GEO-from-LEO parallax drifts the LOS ~44"/s, well inside a 3 deg field
        // over 2 min
        const aimAt = (d) => {
          const s = stateOf(issRec, d), g = stateOf(geoRec, d);
          const topo = { x: g.position.x - s.position.x, y: g.position.y - s.position.y,
            z: g.position.z - s.position.z };
          const rd = F.vecToRaDec(F.temeToJ2000(topo, d));
          return { raDeg: rd.raDeg, decDeg: rd.decDeg };
        };
        const mkP = (t, aim) => params({
          t0Ms: t.getTime(), spanMin: 2, site: OSITE,
          pointing: { track: 'sky', mode: 'radec', raDeg: aim.raDeg, decDeg: aim.decDeg,
            refract: false },
          fov: { shape: 'circ', rDeg: 3, wDeg: 0, hDeg: 0, rotDeg: 0 },
        });
        const mid = (t) => new Date(t.getTime() + 60000);

        const V = await scan(mkP(tVis, aimAt(mid(tVis))), 'orbital: GEO visible');
        ok('the visible GEO is found from the orbital station',
          V.crossings.some((c) => c.norad === geoObj.norad),
          `${V.crossings.length} crossings in the field`);

        const O = await scan(mkP(tOcc, aimAt(mid(tOcc))), 'orbital: GEO occluded');
        ok('the SAME pointing finds nothing while the Earth is in the way (limb test)',
          !O.crossings.some((c) => c.norad === geoObj.norad),
          `${O.crossings.length} crossings in the field`);

        // o2 — independent recompute of every reported position, orbital site:
        // raw SGP4 for BOTH bodies -> TEME difference -> J2000 via frames.js.
        if (V.crossings.length) {
          let worstAs = 0;
          let n = 0;
          for (const cr of V.crossings) {
            const o = byId.get(cr.satId);
            const rec2 = satellite.twoline2satrec(o.l1, o.l2);
            const d = new Date(cr.tCaMs);
            const s = stateOf(issRec, d);
            const topo = s && astrometricTopo(rec2, d, s.position);
            if (!topo) continue;
            const rd = F.vecToRaDec(F.temeToJ2000(topo, d));
            worstAs = Math.max(worstAs, F.sep(rd.raDeg, rd.decDeg, cr.raDeg, cr.decDeg) * 3600);
            n++;
          }
          ok('orbital RA/Dec matches an independent astrometric recompute to < 0.5 arcsec',
            worstAs < 0.5, `worst ${worstAs.toFixed(4)} arcsec over ${n}`);
        }
      }
    }

    // o3 — cull on/off identity, the same soundness proof the ground cull ships
    // with, over an orbital geometry: LVLH zenith stare (track 'mount'), 20 min.
    const pZen = params({
      t0Ms: T0.getTime(), spanMin: 20, site: OSITE,
      pointing: { track: 'mount', mode: 'altaz', azDeg: 0, elDeg: 90, refract: false },
      fov: { shape: 'circ', rDeg: 15, wDeg: 0, hDeg: 0, rotDeg: 0 },
    });
    const Z1 = await scan(pZen, 'orbital zenith, cull ON');
    const Z0 = await scan(Object.assign({}, pZen, { useStage1: false }), 'orbital zenith, cull OFF');
    const z1 = new Set(Z1.crossings.map(key)), z0 = new Set(Z0.crossings.map(key));
    const zLost = [...z0].filter((k) => !z1.has(k));
    ok('identical crossing set from the orbital station (cull on/off)',
      z1.size === z0.size && zLost.length === 0,
      `${z1.size} vs ${z0.size}` + (zLost.length ? `; LOST: ${zLost.slice(0, 8).join(', ')}` : ''));
    ok('orbital stage 1 still culls something (or it is only fail-open)',
      Z1.culled.stage1 > 0,
      `culled ${Z1.culled.stage1} of ${Z1.culled.total - Z1.culled.bad}`);

    // o4 — self-exclusion: the observer is in the catalogue it scans, and a zenith
    // stare's field contains everything co-planar above it. It must never
    // identify itself, on either the culled or the brute-force path.
    ok('the observer never identifies itself (cull ON)',
      !Z1.crossings.some((c) => c.norad === issObj.norad));
    ok('the observer never identifies itself (cull OFF)',
      !Z0.crossings.some((c) => c.norad === issObj.norad));

    // o5 — LVLH sanity: everything in a zenith-stare field sits near the local
    // zenith, so every reported (LVLH) elevation must be >= 90 - fov - slop.
    if (Z1.crossings.length) {
      const worstEl = Math.min(...Z1.crossings.map((c) => c.elDeg));
      ok('zenith-stare crossings all report near-zenith LVLH elevation',
        worstEl > 90 - 15 - 10, `lowest ElL ${worstEl.toFixed(1)} deg`);
    }
  }

  // ------------------------------------------------------------------ test r
  // RECALL AGAINST BRUTE FORCE. Rounds 1-21 sampled each candidate window once a
  // second and kept what landed inside, so a LEO object crossing a small field in
  // 0.3 s was found only when a sample happened to fall in it. The reference here
  // shares nothing with the engine: every object, every second, a plain TEME
  // angle to the boresight with a margin no orbit can beat (3 deg/s — an object
  // 150 km overhead manages 2.9), and every second that passes it is re-sampled
  // every 5 ms through frames.js with iterated light time.
  console.log('\n[r] recall against brute force: 6 x 0.5 deg strip near the zenith, 12 min, every object');
  {
    // A long thin strip high in the sky: plenty of LEO traffic, and almost all of
    // it crosses the 0.5 deg dimension in well under a second.
    const SPAN = 12;
    const aim = F.altAzToRaDec(180, 78, SITE, new Date(T0.getTime() + SPAN * 30000), { refract: false });
    const pR = params({
      spanMin: SPAN,
      pointing: { track: 'sky', mode: 'radec', raDeg: aim.raDeg, decDeg: aim.decDeg, refract: true },
      fov: { shape: 'rect', wDeg: 6, hDeg: 0.5, rDeg: 0, rotDeg: 35 },
    });
    const R = await scan(pR, 'engine');
    const t0 = pR.t0Ms, t1 = t0 + SPAN * 60000;
    const halfW = 3, halfH = 0.25, Rc = Math.hypot(halfW, halfH);
    const rot = 35 * F.D2R, cr = Math.cos(rot), sr = Math.sin(rot);
    const bJ = F.raDecToVec(aim.raDeg, aim.decDeg);
    const inside = (rec, tMs) => {
      const d = new Date(tMs);
      const site = F.siteTemeKm(pR.site, d, 0);
      const topo = astrometricTopo(rec, d, site);
      if (!topo) return false;
      if (topo.x * site.x + topo.y * site.y + topo.z * site.z <= 0) return false;   // horizon
      const rd = F.vecToRaDec(F.temeToJ2000(topo, d));
      const tp = F.tanProject(rd.raDeg, rd.decDeg, aim.raDeg, aim.decDeg);
      if (!tp) return false;
      const X = tp.xi * cr - tp.eta * sr, Y = tp.xi * sr + tp.eta * cr;
      return Math.abs(X) <= halfW && Math.abs(Y) <= halfH;
    };
    const tBrute = Date.now();
    const cosGate = Math.cos((Rc + 3.0) * F.D2R);
    const truth = [];                       // [{id, a, b}]
    const nSec = Math.round((t1 - t0) / 1000);
    const bT = [], sT = [];
    for (let k = 0; k <= nSec; k++) {
      const d = new Date(t0 + k * 1000);
      bT.push(F.j2000ToTeme(bJ, d));
      sT.push(F.siteTemeKm(pR.site, d, 0));
    }
    for (const o of objs) {
      const rec = satellite.twoline2satrec(o.l1, o.l2);
      if (!rec || !isFinite(rec.jdsatepoch)) continue;
      const ts0 = (t0 / 86400000 + 2440587.5 - rec.jdsatepoch) * 1440;
      let open = null, lastFine = -Infinity;
      for (let k = 0; k <= nSec; k++) {
        const pv = satellite.sgp4(rec, ts0 + k / 60);
        if (!pv || !pv.position) continue;
        const s = sT[k], b = bT[k];
        const wx = pv.position.x - s.x, wy = pv.position.y - s.y, wz = pv.position.z - s.z;
        if ((wx * b.x + wy * b.y + wz * b.z) < cosGate * Math.sqrt(wx * wx + wy * wy + wz * wz)) continue;
        const from = Math.max(t0 + (k - 1) * 1000, lastFine + 5, t0), to = Math.min(t0 + (k + 1) * 1000, t1);
        for (let t = from; t <= to; t += 5) {
          const v = inside(rec, t);
          if (v && open == null) open = t;
          if (!v && open != null) { truth.push({ id: o.id, a: open, b: t - 5 }); open = null; }
          lastFine = t;
        }
      }
      if (open != null) truth.push({ id: o.id, a: open, b: lastFine });
    }
    console.log(`  brute force: ${truth.length} crossings in ${Date.now() - tBrute} ms ` +
      `(${truth.filter((x) => x.b - x.a < 1000).length} of them shorter than 1 s)`);
    const tol = 25;                         // 5 ms reference grid + 10 ms bisection, with room
    const match = (x, c) => c.satId === x.id && Math.abs(c.tEnterMs - x.a) <= tol &&
      Math.abs(c.tExitMs - x.b) <= tol;
    const missed = truth.filter((x) => !R.crossings.some((c) => match(x, c)));
    const spurious = R.crossings.filter((c) => !truth.some((x) => match(x, c)));
    ok('brute force finds crossings, sub-second ones among them (else vacuous)',
      truth.length > 3 && truth.some((x) => x.b - x.a < 1000), `(${truth.length})`);
    ok('the engine finds EVERY crossing the brute force finds, entry and exit within 25 ms',
      missed.length === 0,
      missed.length ? `MISSED ${missed.length}: ` + missed.slice(0, 5).map((x) =>
        `${byId.get(x.id).name} ${((x.b - x.a) / 1000).toFixed(2)} s`).join(', ') : `${truth.length} of ${truth.length}`);
    ok('and reports nothing the brute force does not', spurious.length === 0,
      spurious.length ? spurious.slice(0, 5).map((c) => c.name + ' ' +
        ((c.tExitMs - c.tEnterMs) / 1000).toFixed(2) + ' s').join(', ') : '');
  }

  // ------------------------------------------------------------------ test k
  // THE CLEAR-TIME BOUND, checked directly. Stage 2 skips ahead by clearTime()
  // and stage 3 steps by it, so if the bound were ever too long an object would
  // be skipped past the field and never looked at. For random objects at random
  // times: take the bound, then walk the whole interval it vouches for — forwards
  // and backwards — and check the object stays outside the field's circumscribing
  // circle throughout. Sidereal, parked-mount and LVLH pointings.
  console.log('\n[k] the clear-time bound holds: nothing reaches the field inside it');
  {
    const issK = objs.find((o) => /^ISS \(ZARYA\)/.test(o.name));
    const cases = [
      ['sidereal 3 deg', params({ spanMin: 360, fov: { shape: 'circ', rDeg: 3, wDeg: 0, hDeg: 0, rotDeg: 0 } })],
      ['parked mount 5x4 deg', params({ spanMin: 360,
        pointing: { track: 'mount', mode: 'altaz', azDeg: 200, elDeg: 50, refract: true },
        fov: { shape: 'rect', wDeg: 5, hDeg: 4, rDeg: 0, rotDeg: 0 } })],
    ];
    if (issK) {
      cases.push(['LVLH-fixed 10 deg, from orbit', params({ spanMin: 180,
        site: { kind: 'orbit', norad: issK.norad, l1: issK.l1, l2: issK.l2, name: issK.name },
        pointing: { track: 'mount', mode: 'altaz', azDeg: 60, elDeg: 25, refract: false },
        fov: { shape: 'circ', rDeg: 10, wDeg: 0, hDeg: 0, rotDeg: 0 } })]);
    }
    let seed = 20261115;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (const [label, pK] of cases) {
      const P = worker.prepare(pK);
      P.field = worker.fieldSetup(P);
      const tabs = worker.buildTables(P);
      const stepMs = P.coarseStepS * 1000;
      const Rdeg = P.fovRadiusDeg;
      // boresight and observer at an arbitrary instant, by interpolating nothing:
      // evaluate on the table's own grid, which is what stage 2 does
      const geom = (rec, k) => {
        const pv = satellite.sgp4(rec, (P.t0Ms / 86400000 + 2440587.5 - rec.jdsatepoch) * 1440 + k * P.coarseStepS / 60);
        if (!pv || !pv.position) return null;
        const o = k * 3, r = pv.position;
        const dx = r.x - tabs.tabS[o], dy = r.y - tabs.tabS[o + 1], dz = r.z - tabs.tabS[o + 2];
        const rho = Math.hypot(dx, dy, dz);
        const proj = dx * tabs.tabP[o] + dy * tabs.tabP[o + 1] + dz * tabs.tabP[o + 2];
        return { r: r, v: pv.velocity, rho: rho, proj: proj,
          D: proj > 0 ? Math.sqrt(Math.max(0, rho * rho - proj * proj)) : rho,
          sepDeg: Math.acos(Math.max(-1, Math.min(1, proj / rho))) * F.R2D };
      };
      let trials = 0, violations = 0, worst = Infinity, longest = 0, checked = 0;
      while (trials < 4000) {
        const o = objs[Math.floor(rnd() * objs.length)];
        const rec = satellite.twoline2satrec(o.l1, o.l2);
        if (!rec || !isFinite(rec.jdsatepoch)) continue;
        const k = Math.floor(rnd() * P.nSteps);
        const g = geom(rec, k);
        if (!g) continue;
        const clear = worker.clearTime(P, g.rho, g.D, g.r, g.v);
        if (!(clear >= P.coarseStepS)) continue;        // the bound is only USED from one step up
        trials++;
        longest = Math.max(longest, clear);
        const nk = Math.floor(clear * 1000 / stepMs);
        for (const dir of [1, -1]) {
          for (let j = 1; j <= nk; j++) {
            const kk = k + dir * j;
            if (kk < 0 || kk >= P.nSteps) break;
            const h = geom(rec, kk);
            if (!h) continue;
            checked++;
            const margin = h.sepDeg - Rdeg;             // > 0 means outside the field
            if (margin < worst) worst = margin;
            if (margin <= 0) violations++;
          }
        }
      }
      ok(`${label}: no object is inside the field anywhere within its clear time`,
        violations === 0,
        `${trials} bounds, ${checked} instants walked, longest ${(longest / 60).toFixed(0)} min, ` +
        `closest approach to the field edge ${worst.toFixed(2)} deg` +
        (violations ? `; ${violations} VIOLATIONS` : ''));
    }
  }

  // ------------------------------------------------------------------ test h
  // A ground target is in the field only while it is above the horizon. A field
  // low on the horizon (centre at 6 deg, 10 deg wide) hangs partly below it, and
  // rounds 1-21 reported the below-horizon part whenever a neighbouring coarse
  // sample happened to be above.
  console.log('\n[h] a low field reports nothing from below the horizon');
  {
    const pH = params({
      spanMin: 60,
      pointing: { track: 'mount', mode: 'altaz', azDeg: 120, elDeg: 6, refract: true },
      fov: { shape: 'rect', wDeg: 10, hDeg: 10, rDeg: 0, rotDeg: 0 },
    });
    const H = await scan(pH, 'field centred at El 6 deg');
    let lowest = Infinity, n = 0;
    for (const c of H.crossings) {
      const o = byId.get(c.satId), rec = satellite.twoline2satrec(o.l1, o.l2);
      for (const t of [c.tEnterMs, c.tCaMs, c.tExitMs]) {
        const d = new Date(t), site = F.siteTemeKm(pH.site, d, 0);
        const topo = astrometricTopo(rec, d, site);
        if (!topo) continue;
        const el = Math.asin((topo.x * site.x + topo.y * site.y + topo.z * site.z) /
          (Math.hypot(topo.x, topo.y, topo.z) * Math.hypot(site.x, site.y, site.z))) * F.R2D;
        lowest = Math.min(lowest, el); n++;
      }
    }
    ok('the low field finds crossings (else vacuous)', H.crossings.length > 20, `(${H.crossings.length})`);
    ok('entry, closest approach and exit are all at or above the horizon',
      lowest > -0.01, `lowest ${lowest.toFixed(3)} deg over ${n} instants`);
  }

  // ------------------------------------------------------------------ test c
  console.log('\n[c] timing and cull budget');
  const pDay = params({ spanMin: 360, steps: { coarseStepS: 30, fineStepS: 1.0, marginDeg: 0 } });
  const D = await scan(pDay, '6 h @ 30 s, 30 deg');
  console.log(`\n  single-thread wall clock, ${objs.length} objects:`);
  console.log(`    1 h  @ 30 s, 30 deg circle : ${A.wallMs} ms  (${A.crossings.length} crossings)`);
  console.log(`    6 h  @ 30 s, 4x3 deg rect  : ${N.wallMs} ms  (${N.crossings.length} crossings)`);
  console.log(`    6 h  @ 30 s, 30 deg circle : ${D.wallMs} ms  (${D.crossings.length} crossings)`);
  console.log(`    -> across 6 workers, roughly ${(D.wallMs / 6 / 1000).toFixed(2)} s for the 6 h scan`);

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
