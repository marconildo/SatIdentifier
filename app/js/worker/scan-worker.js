/* scan-worker.js — worker side of SAT.scan: the three-stage field-of-view scan.
 *
 * One of these runs per pool worker. It owns a *shard* of the catalogue and, per
 * CONTRACT.md's first structural rule, builds that shard's satrecs exactly once —
 * when the 'load' message arrives — never per scan and never per step.
 *
 * The three stages, in order (CONTRACT.md "Algorithm"):
 *   1. static geometric cull, no SGP4 at all;
 *   2. coarse sweep in TEME, object by object, SKIPPING every stretch of time in
 *      which the object provably cannot reach the field;
 *   3. refinement of the surviving candidate windows by adaptive stepping against
 *      the true field boundary — no fixed sampling grid, so a crossing shorter
 *      than any "fine step" cannot fall between two samples.
 *
 * Stages 2 and 3 share one idea (round 22): the DISTANCE FROM THE SATELLITE TO
 * THE SIGHTLINE, in kilometres, can only shrink as fast as things move. Divide the
 * gap by the largest closing speed physics allows and you have a time during which
 * the object cannot be in the field, whatever its orbit — see clearTime().
 *
 * The other thing that makes this interactive is that the POINTING is rotated
 * into TEME once per epoch and the 33 000 satellite vectors are left alone. Only
 * confirmed crossings are converted to J2000, at the end, for display.
 *
 * Structured so its core is callable from node: tools/test_scan.js drives loadObjs()
 * and runScan() directly, which is how the cull is proved sound (running with
 * useStage1:false must return the identical crossing set).
 */
(function () {
  'use strict';

  // Classic worker; in node tools/test_scan.js puts satellite.js on the global first.
  if (typeof importScripts === 'function') importScripts('../vendor/satellite.min.js');

  /* ===========================================================================
   * DUPLICATED FROM app/js/frames.js — DO NOT EDIT HERE FIRST.
   *
   * A classic worker cannot see the main thread's SAT namespace, so the handful of
   * frame transformations the scan needs are copied verbatim below. frames.js is
   * the REFERENCE IMPLEMENTATION and is the one with the verification suite
   * (tools/test_frames.js, agreement to 1e-5 arcsec); this block must stay
   * behaviourally identical to it. If you change a formula, change frames.js first,
   * re-run its tests, then mirror it here.
   *
   * Deliberately omitted (unused by the scan): moonJ2000, tanProject (field
   * membership is three dot products since round 22 — see fieldSetup),
   * tanDeproject, topoTeme, sunJ2000, and siteTemeKm — the last replaced by obsStateAt() below, which is the
   * same arithmetic with the site's constant ECEF vector hoisted out of a function
   * that stage 3 calls once per fine sample, and which is also where an ORBIT site
   * swaps in SGP4 (CONTRACT.md "Orbital observing stations").
   * =========================================================================== */

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const AS2R = (Math.PI / 180) / 3600;
  const J2000 = 2451545.0;

  const RE_EQ = 6378.137;                   // WGS-84 semi-major axis, km
  const WGS84_F = 1 / 298.257223563;
  const WGS84_E2 = WGS84_F * (2 - WGS84_F);

  const LEAPS = [
    [Date.UTC(1999, 0, 1), 32], [Date.UTC(2006, 0, 1), 33],
    [Date.UTC(2009, 0, 1), 34], [Date.UTC(2012, 6, 1), 35],
    [Date.UTC(2015, 6, 1), 36], [Date.UTC(2017, 0, 1), 37],
  ];

  function taiMinusUtc(date) {
    const t = date.getTime();
    let s = LEAPS[0][1];
    for (let i = 0; i < LEAPS.length; i++) if (t >= LEAPS[i][0]) s = LEAPS[i][1];
    return s;
  }

  function jdUTC(date) { return date.getTime() / 86400000 + 2440587.5; }
  function jdTT(date) { return jdUTC(date) + (taiMinusUtc(date) + 32.184) / 86400; }
  function tCen(date) { return (jdTT(date) - J2000) / 36525; }

  function gmstRad(date, dut1S) {
    const d = dut1S ? new Date(date.getTime() + dut1S * 1000) : date;
    return satellite.gstime(d);
  }

  const NUT = [
    [0, 0, 0, 0, 1, -171996, -174.2, 92025, 8.9],
    [0, 0, 2, -2, 2, -13187, -1.6, 5736, -3.1],
    [0, 0, 2, 0, 2, -2274, -0.2, 977, -0.5],
    [0, 0, 0, 0, 2, 2062, 0.2, -895, 0.5],
    [0, 1, 0, 0, 0, 1426, -3.4, 54, -0.1],
    [1, 0, 0, 0, 0, 712, 0.1, -7, 0],
    [0, 1, 2, -2, 2, -517, 1.2, 224, -0.6],
    [0, 0, 2, 0, 1, -386, -0.4, 200, 0],
    [1, 0, 2, 0, 2, -301, 0, 129, -0.1],
    [0, -1, 2, -2, 2, 217, -0.5, -95, 0.3],
    [1, 0, 0, -2, 0, -158, 0, -1, 0],
    [0, 0, 2, -2, 1, 129, 0.1, -70, 0],
    [-1, 0, 2, 0, 2, 123, 0, -53, 0],
    [1, 0, 0, 0, 1, 63, 0.1, -33, 0],
    [0, 0, 0, 2, 0, 63, 0, -2, 0],
    [-1, 0, 2, 2, 2, -59, 0, 26, 0],
    [-1, 0, 0, 0, 1, -58, -0.1, 32, 0],
    [1, 0, 2, 0, 1, -51, 0, 27, 0],
    [2, 0, 0, -2, 0, 48, 0, 1, 0],
    [-2, 0, 2, 0, 1, 46, 0, -24, 0],
  ];

  let nutCache = { t: NaN, v: null };

  function nutation(date) {
    const T = tCen(date);
    if (T === nutCache.t) return nutCache.v;
    const T2 = T * T, T3 = T2 * T;
    const l = 134.96298139 + (1325 * 360 + 198.8673981) * T + 0.0086972 * T2 + 1.78e-5 * T3;
    const lp = 357.52772333 + (99 * 360 + 359.0503400) * T - 0.0001603 * T2 - 3.3e-6 * T3;
    const F = 93.27191028 + (1342 * 360 + 82.0175381) * T - 0.0036825 * T2 + 3.1e-6 * T3;
    const D = 297.85036306 + (1236 * 360 + 307.1114800) * T - 0.0019142 * T2 + 5.3e-6 * T3;
    const Om = 125.04452222 - (5 * 360 + 134.1362608) * T + 0.0020708 * T2 + 2.2e-6 * T3;

    let dPsi = 0, dEps = 0;
    for (let i = 0; i < NUT.length; i++) {
      const c = NUT[i];
      const arg = (c[0] * l + c[1] * lp + c[2] * F + c[3] * D + c[4] * Om) * D2R;
      dPsi += (c[5] + c[6] * T) * Math.sin(arg);
      dEps += (c[7] + c[8] * T) * Math.cos(arg);
    }
    dPsi *= 1e-4 * AS2R;
    dEps *= 1e-4 * AS2R;

    const epsA = (84381.448 - 46.8150 * T - 0.00059 * T2 + 0.001813 * T3) * AS2R;
    const v = {
      dPsiRad: dPsi, dEpsRad: dEps, epsARad: epsA, epsRad: epsA + dEps,
      eqEqRad: dPsi * Math.cos(epsA),
    };
    nutCache = { t: T, v: v };
    return v;
  }

  function apply(M, v) {
    return {
      x: M[0] * v.x + M[1] * v.y + M[2] * v.z,
      y: M[3] * v.x + M[4] * v.y + M[5] * v.z,
      z: M[6] * v.x + M[7] * v.y + M[8] * v.z,
    };
  }

  function applyT(M, v) {
    return {
      x: M[0] * v.x + M[3] * v.y + M[6] * v.z,
      y: M[1] * v.x + M[4] * v.y + M[7] * v.z,
      z: M[2] * v.x + M[5] * v.y + M[8] * v.z,
    };
  }

  let precCache = { t: NaN, m: null };

  /* IAU-1976 equatorial precession, J2000 -> mean of date. The ONLY precession
   * primitive; every other direction is its transpose. See frames.js for why. */
  function precessionMatrix(date) {
    const T = tCen(date);
    if (T === precCache.t) return precCache.m;
    const zeta = T * (2306.2181 + T * (0.30188 + 0.017998 * T)) * AS2R;
    const z = T * (2306.2181 + T * (1.09468 + 0.018203 * T)) * AS2R;
    const theta = T * (2004.3109 + T * (-0.42665 - 0.041833 * T)) * AS2R;
    const cze = Math.cos(zeta), sze = Math.sin(zeta);
    const cz = Math.cos(z), sz = Math.sin(z);
    const cth = Math.cos(theta), sth = Math.sin(theta);
    const m = [
      cze * cth * cz - sze * sz, -sze * cth * cz - cze * sz, -sth * cz,
      cze * cth * sz + sze * cz, -sze * cth * sz + cze * cz, -sth * sz,
      cze * sth, -sze * sth, cth,
    ];
    precCache = { t: T, m: m };
    return m;
  }

  let nutMatCache = { t: NaN, m: null };

  function nutationMatrix(date) {
    const T = tCen(date);
    if (T === nutMatCache.t) return nutMatCache.m;
    const n = nutation(date);
    const ce = Math.cos(n.epsARad), se = Math.sin(n.epsARad);
    const cp = Math.cos(n.dPsiRad), sp = Math.sin(n.dPsiRad);
    const ct = Math.cos(n.epsRad), st = Math.sin(n.epsRad);
    const m = [
      cp, -sp * ce, -sp * se,
      sp * ct, cp * ct * ce + st * se, cp * ct * se - st * ce,
      sp * st, cp * st * ce - ct * se, cp * st * se + ct * ce,
    ];
    nutMatCache = { t: T, m: m };
    return m;
  }

  function rot3(v, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    return { x: c * v.x + s * v.y, y: -s * v.x + c * v.y, z: v.z };
  }

  function temeToJ2000(v, date) {
    const tod = rot3(v, -nutation(date).eqEqRad);
    const mod = applyT(nutationMatrix(date), tod);
    return applyT(precessionMatrix(date), mod);
  }

  function j2000ToTeme(v, date) {
    const mod = apply(precessionMatrix(date), v);
    const tod = apply(nutationMatrix(date), mod);
    return rot3(tod, nutation(date).eqEqRad);
  }

  function j2000ToTod(v, date) {
    return apply(nutationMatrix(date), apply(precessionMatrix(date), v));
  }

  function todToJ2000(v, date) {
    return applyT(precessionMatrix(date), applyT(nutationMatrix(date), v));
  }

  function siteEcefKm(loc) {
    const lat = loc.latDeg * D2R, lon = loc.lonDeg * D2R;
    const h = (loc.altM || 0) / 1000;
    const sp = Math.sin(lat), cp = Math.cos(lat);
    const N = RE_EQ / Math.sqrt(1 - WGS84_E2 * sp * sp);
    return {
      x: (N + h) * cp * Math.cos(lon),
      y: (N + h) * cp * Math.sin(lon),
      z: (N * (1 - WGS84_E2) + h) * sp,
    };
  }

  function vecToRaDec(v) {
    const r = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    let ra = Math.atan2(v.y, v.x) * R2D;
    if (ra < 0) ra += 360;
    return { raDeg: ra, decDeg: Math.asin(r ? v.z / r : 0) * R2D, rKm: r };
  }

  function raDecToVec(raDeg, decDeg) {
    const a = raDeg * D2R, d = decDeg * D2R, cd = Math.cos(d);
    return { x: cd * Math.cos(a), y: cd * Math.sin(a), z: Math.sin(d) };
  }

  function sep(ra1, dec1, ra2, dec2) {
    const d1 = dec1 * D2R, d2 = dec2 * D2R, dA = (ra2 - ra1) * D2R;
    const s1 = Math.sin(d1), c1 = Math.cos(d1);
    const s2 = Math.sin(d2), c2 = Math.cos(d2);
    const sdA = Math.sin(dA), cdA = Math.cos(dA);
    const a = c2 * sdA, b = c1 * s2 - s1 * c2 * cdA;
    return Math.atan2(Math.sqrt(a * a + b * b), s1 * s2 + c1 * c2 * cdA) * R2D;
  }

  function posAngle(ra1, dec1, ra2, dec2) {
    const d1 = dec1 * D2R, d2 = dec2 * D2R, dA = (ra2 - ra1) * D2R;
    const p = Math.atan2(Math.sin(dA) * Math.cos(d2),
      Math.cos(d1) * Math.sin(d2) - Math.sin(d1) * Math.cos(d2) * Math.cos(dA)) * R2D;
    return (p + 360) % 360;
  }

  function refractionDeg(elDeg, opts) {
    if (elDeg < -1) return 0;
    const o = opts || {};
    const P = o.pressureMb == null ? 1010 : o.pressureMb;
    const T = o.tempC == null ? 10 : o.tempC;
    const r = 1.02 / Math.tan((elDeg + 10.3 / (elDeg + 5.11)) * D2R);
    return Math.max(0, (r / 60) * (P / 1010) * (283 / (273 + T)));
  }

  function refractionInvDeg(elAppDeg, opts) {
    if (elAppDeg < -1) return 0;
    let el = elAppDeg - refractionDeg(elAppDeg, opts);
    for (let i = 0; i < 4; i++) el = elAppDeg - refractionDeg(el, opts);
    return elAppDeg - el;
  }

  function lastRad(loc, date, dut1S) {
    return gmstRad(date, dut1S) + nutation(date).eqEqRad + loc.lonDeg * D2R;
  }

  function raDecToAltAz(raDeg, decDeg, loc, date, opts) {
    const o = opts || {};
    const tod = vecToRaDec(j2000ToTod(raDecToVec(raDeg, decDeg), date));
    const H = lastRad(loc, date, o.dut1S) - tod.raDeg * D2R;
    const phi = loc.latDeg * D2R, dec = tod.decDeg * D2R;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const sd = Math.sin(dec), cd = Math.cos(dec);
    const cH = Math.cos(H), sH = Math.sin(H);
    let el = Math.asin(Math.max(-1, Math.min(1, sp * sd + cp * cd * cH))) * R2D;
    let az = Math.atan2(-cd * sH, sd * cp - cd * sp * cH) * R2D;
    if (az < 0) az += 360;
    if (o.refract) el += refractionDeg(el, o);
    return { azDeg: az, elDeg: el };
  }

  function altAzToRaDec(azDeg, elDeg, loc, date, opts) {
    const o = opts || {};
    let el = elDeg;
    if (o.refract) el -= refractionInvDeg(el, o);
    const a = azDeg * D2R, e = el * D2R, phi = loc.latDeg * D2R;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const se = Math.sin(e), ce = Math.cos(e);
    const dec = Math.asin(Math.max(-1, Math.min(1, sp * se + cp * ce * Math.cos(a))));
    const H = Math.atan2(-ce * Math.sin(a), se * cp - ce * sp * Math.cos(a));
    const ra = (lastRad(loc, date, o.dut1S) - H) * R2D;
    const j = todToJ2000(raDecToVec(((ra % 360) + 360) % 360, dec * R2D), date);
    const rd = vecToRaDec(j);
    return { raDeg: rd.raDeg, decDeg: rd.decDeg };
  }

  function sunTodRaDec(date) {
    const n = jdUTC(date) - J2000;
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * D2R;
    const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
    const eps = (23.439 - 0.0000004 * n) * D2R;
    let ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) * R2D;
    if (ra < 0) ra += 360;
    const rAu = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
    return { raDeg: ra, decDeg: Math.asin(Math.sin(eps) * Math.sin(lam)) * R2D, rAu: rAu };
  }

  function sunTemeKm(date) {
    const s = sunTodRaDec(date);
    const v = raDecToVec(s.raDeg, s.decDeg);
    const r = s.rAu * 149597870.7;
    const t = rot3(v, nutation(date).eqEqRad);
    return { x: t.x * r, y: t.y * r, z: t.z * r };
  }

  /* LVLH frame — mirrors frames.js lvlhBasis/lvlhToVec/vecToLvlh exactly.
   * R = zenith (radially out), W = orbit normal (r x v), S = along-track (W x R);
   * az from S toward W, el from the local-horizontal plane toward R. */
  function lvlhBasis(r, v) {
    const rn = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
    if (!(rn > 0)) return null;
    const R = { x: r.x / rn, y: r.y / rn, z: r.z / rn };
    const w = { x: r.y * v.z - r.z * v.y, y: r.z * v.x - r.x * v.z, z: r.x * v.y - r.y * v.x };
    const wn = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
    if (!(wn > 0)) return null;
    const W = { x: w.x / wn, y: w.y / wn, z: w.z / wn };
    const S = { x: W.y * R.z - W.z * R.y, y: W.z * R.x - W.x * R.z, z: W.x * R.y - W.y * R.x };
    return { R: R, S: S, W: W };
  }

  function lvlhToVec(azDeg, elDeg, basis) {
    const a = azDeg * D2R, e = elDeg * D2R;
    const ce = Math.cos(e), se = Math.sin(e);
    const cs = ce * Math.cos(a), cw = ce * Math.sin(a);
    return {
      x: cs * basis.S.x + cw * basis.W.x + se * basis.R.x,
      y: cs * basis.S.y + cw * basis.W.y + se * basis.R.y,
      z: cs * basis.S.z + cw * basis.W.z + se * basis.R.z,
    };
  }

  function vecToLvlh(vec, basis) {
    const s = vec.x * basis.S.x + vec.y * basis.S.y + vec.z * basis.S.z;
    const w = vec.x * basis.W.x + vec.y * basis.W.y + vec.z * basis.W.z;
    const r = vec.x * basis.R.x + vec.y * basis.R.y + vec.z * basis.R.z;
    const n = Math.sqrt(s * s + w * w + r * r) || 1;
    let az = Math.atan2(w, s) * R2D;
    if (az < 0) az += 360;
    return { azDeg: az, elDeg: Math.asin(Math.max(-1, Math.min(1, r / n))) * R2D };
  }

  /* ======================= end of frames.js duplication ===================== */

  // Physical constants used only by the scan.
  // Earth rotation rate, rad/s. Same value as SAT.prop's OMEGA_E to the last digit:
  // it sets the site's velocity here and the sky/mount rate difference in stage 3,
  // and the two modules' rates are compared against each other in the UI.
  const OMEGA_E = 7.292115146706979e-5;
  const R_SUN_KM = 696000;        // solar photospheric radius, for the penumbra test
  const J2 = 1.08262668e-3;       // for the nodal regression that widens the plane test
  const RE_WGS72 = 6378.135;      // satrec.a / alta / altp are in THESE Earth radii
  const MU = 398600.8;            // km^3/s^2, WGS-72 — matches satellite.js's SGP4

  // TLE error model for the per-object slop (CONTRACT.md stage 2, Bill Gray's
  // "# Max error"). A fresh element set is good to ~1 km; error grows roughly
  // linearly at a couple of km/day, badly for decaying LEO. Converted to an ANGLE
  // by dividing by the range, so the same km buys a huge slop on a close pass and
  // almost nothing on GEO. Capped so one ancient element cannot swamp the scan.
  const TLE_ERR_KM0 = 1.0;
  const TLE_ERR_KM_PER_DAY = 2.5;
  const TLE_ERR_KM_MAX = 150;
  const TLE_SLOP_MAX_RAD = 8 * D2R;

  // Stage 1 pads. The horizon test compares a *geocentric* site latitude against an
  // inclination bound on the sub-point's geodetic latitude; those differ by up to
  // 0.19 deg, and J2 wobbles the osculating inclination by a few hundredths. One
  // degree of pad makes the test unarguably conservative for the ~nothing it costs.
  const CULL_PAD_DEG = 1.0;
  const SLICE_MS = 40;            // work budget per chunk, so 'cancel' can be heard

  const C_KM_S = 299792.458;      // light time: the satellite is seen where it WAS

  // ---- the clear-time bound (stages 2 and 3) -------------------------------
  // PAD_ANG_DEG widens the field for the bound only: it absorbs the bucketed
  // frame rotation below (<= 1e-3") and the precession of an "inertially fixed"
  // pointing in TEME, with four orders of magnitude to spare. PAD_KM and LT_PAD
  // absorb the light-time displacement stage 3 applies and stage 2 does not
  // (v/c <= 3.7e-5, i.e. 37 m per 1000 km of range).
  const PAD_ANG_DEG = 0.02;
  const PAD_KM = 1.0;
  const LT_PAD = 4e-5;
  // Osculating perigee speed bounds the speed for the whole orbit; J2 wobbles it
  // by ~0.15% in LEO. 3% + 50 m/s is a twenty-fold allowance.
  const VMAX_PAD = 1.03, VMAX_PAD_KMS = 0.05;
  const MAX_SKIP_S = 7200;        // re-examine every object at least this often

  // ---- stage 3 adaptive stepping -------------------------------------------
  // A step is SAFETY x (distance to the field edge) / (speed toward it), so the
  // edge can only be overshot if the speed more than doubles inside one step —
  // and RANGE_FRAC caps the step at the time the range could change by a quarter,
  // which is what would have to happen for the angular speed to do that.
  const SAFETY = 0.5;
  const RANGE_FRAC = 0.25;
  const CO_ORBIT_RATE = 1.25e-3;  // rad/s, a LEO mean motion: how fast a co-flying
                                  // object's relative geometry can turn
  const H_MIN_S = 0.01;           // never step finer than 10 ms
  const H_MAX_S = 600;            // nor coarser than 10 min, however still the object
  const EDGE_TOL_MS = 10;         // entry/exit bisection tolerance
  const CA_TOL_MS = 5;            // closest-approach refinement tolerance
  const MAX_PROBES = 200000;      // per window; a runaway guard, never reached in practice
  const BUCKET_MS = 600000;       // TEME<->J2000 rotation re-derived every 10 min:
                                  // precession+nutation move < 1e-3" in half of that

  /* ---- module state: the shard, built ONCE at 'load' ----------------------- */

  let objs = [];        // ObjEntry-ish records, minus the TLE lines once parsed
  let recs = [];        // satrecs, index-parallel to objs; null when the TLE is bad
  let epochJd = null;   // Float64Array of satrec epochs, hoisted out of the hot loop
  let badCount = 0;
  let cancelled = false;

  /** Mean motion in rad/min.
   *
   *  satellite.js 5.0 as vendored here writes the un-Kozai'd mean motion into
   *  `no` and leaves `no_kozai` undefined; other builds do the opposite. Reading
   *  the wrong one is silent poison rather than an error — `undefined > 5` is
   *  false and cbrt(MU/undefined^2) is NaN, so every object would sail through the
   *  cull with NaN altitudes instead of failing visibly. Take whichever exists. */
  function meanMotion(rec) {
    return (rec.no_kozai != null && isFinite(rec.no_kozai)) ? rec.no_kozai : rec.no;
  }

  /** twoline2satrec returns error === 0 for total garbage — feed it '1 garbage' and
   *  you get back a satrec with NaN inclo, ecco and jdsatepoch. A NaN object never
   *  matches anything and never throws, so it would just quietly not be scanned.
   *  Validate the numbers, not the error flag. Mirrors SAT.prop.ensureSatrec. */
  function validSatrec(r) {
    if (!r || r.error) return false;
    const n = meanMotion(r);
    return isFinite(n) && n > 0 && isFinite(r.inclo) && isFinite(r.nodeo) &&
      isFinite(r.ecco) && r.ecco >= 0 && r.ecco < 1 && isFinite(r.jdsatepoch);
  }

  /** Build every satrec for this shard. Called once per catalogue load — 6.6 us
   *  each, 106 ms for 16 k objects, and then never again for the session. */
  function loadObjs(list) {
    objs = new Array(list.length);
    recs = new Array(list.length);
    epochJd = new Float64Array(list.length);
    badCount = 0;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      objs[i] = {
        id: o.id, norad: o.norad, name: o.name, intl: o.intl,
        rcs: o.rcs == null ? null : o.rcs, stdMag: o.stdMag == null ? null : o.stdMag,
      };
      let r = null;
      try {
        r = satellite.twoline2satrec(o.l1, o.l2);
        if (!validSatrec(r)) r = null;
      } catch (e) { r = null; }
      recs[i] = r;
      epochJd[i] = r ? r.jdsatepoch : 0;
      if (!r) badCount++;
    }
    return { count: objs.length, bad: badCount };
  }

  /* ---- small geometry helpers --------------------------------------------- */

  /** True when A*rho^2 + B*rho + C <= 0 somewhere in [lo, hi].
   *
   *  CONTRACT.md prescribes sweeping ~24 log-spaced ranges along the sightline for
   *  both stage-1 range tests. Both tests turn out to be quadratics in rho (the
   *  orbit-plane one because f(rho) = s.n + rho*(r.n) is LINEAR, squared against
   *  |p|^2; the declination one likewise), so we minimise them in closed form
   *  instead: same test, but it cannot fall through a gap between samples, and it
   *  is O(1) rather than O(24) per epoch. A sampled sweep that straddles a narrow
   *  admissible band would silently drop a real object, which is the one failure
   *  mode a cull must not have. */
  function quadMinLE0(A, B, C, lo, hi) {
    const ev = (x) => (A * x + B) * x + C;
    let m = Math.min(ev(lo), ev(hi));
    if (A > 0) {
      const xv = -B / (2 * A);
      if (xv > lo && xv < hi) m = Math.min(m, ev(xv));
    }
    return m <= 0;
  }

  function classOf(rec) {
    const revPerDay = meanMotion(rec) * 1440 / (2 * Math.PI);
    if (revPerDay >= 0.9 && revPerDay <= 1.1 && rec.ecco < 0.05) return 'geo';
    if (rec.ecco >= 0.25) return 'heo';
    if (revPerDay > 5) return 'leo';
    return 'meo';
  }

  /** Geocentric radii of perigee and apogee, km.
   *
   *  Prefer satrec.alta / satrec.altp — SGP4's own initialisation computed them, so
   *  the cull geometry is guaranteed to match what the propagator will actually do
   *  rather than a re-derivation that could disagree at the edges. They are heights
   *  in WGS-72 Earth radii, hence the +1 and the 6378.135. Kepler's third law is the
   *  fallback for any element set that leaves them unset. */
  function orbitRadii(rec) {
    if (isFinite(rec.alta) && isFinite(rec.altp) && rec.altp > -1) {
      const rApo = (rec.alta + 1) * RE_WGS72, rPeri = (rec.altp + 1) * RE_WGS72;
      return { rPeri: rPeri, rApo: rApo, aKm: (rApo + rPeri) / 2 };
    }
    let a = rec.a;
    if (!(a > 0) || !isFinite(a)) {
      const nRadS = meanMotion(rec) / 60;
      a = Math.cbrt(MU / (nRadS * nRadS)) / RE_WGS72;
    }
    const aKm = a * RE_WGS72;
    return { rPeri: aKm * (1 - rec.ecco), rApo: aKm * (1 + rec.ecco), aKm: aKm };
  }

  /** Angular velocity of a topocentric direction, resolved into the north/east sky
   *  basis at that direction, so the position angle is directly comparable to a
   *  streak measured on an image. Mirrors SAT.prop.look()'s skyRate() exactly —
   *  the crossings table shows these numbers next to that module's. */
  function skyRate(rhoJ, vel, rangeKm) {
    const ux = rhoJ.x / rangeKm, uy = rhoJ.y / rangeKm, uz = rhoJ.z / rangeKm;
    let ex = -uy, ey = ux, ez = 0;               // east = zhat x uhat
    const en = Math.sqrt(ex * ex + ey * ey);
    if (en < 1e-12) { ex = 1; ey = 0; ez = 0; } else { ex /= en; ey /= en; }
    const nx = uy * ez - uz * ey, ny = uz * ex - ux * ez, nz = ux * ey - uy * ex;
    const radial = vel.x * ux + vel.y * uy + vel.z * uz;
    const tx = vel.x - radial * ux, ty = vel.y - radial * uy, tz = vel.z - radial * uz;
    const dE = (tx * ex + ty * ey + tz * ez) / rangeKm;      // rad/s
    const dN = (tx * nx + ty * ny + tz * nz) / rangeKm;
    return {
      rate: Math.sqrt(dE * dE + dN * dN) * R2D * 3600,
      pa: (Math.atan2(dE, dN) * R2D + 360) % 360,
    };
  }

  /** Conical Earth shadow with the solar angular radius. Oblateness ignored —
   *  worth <= 0.3 s of timing error at the terminator, far inside TLE noise. */
  function shadowState(satTeme, sunTeme) {
    const rs = Math.sqrt(satTeme.x * satTeme.x + satTeme.y * satTeme.y + satTeme.z * satTeme.z);
    if (rs <= RE_EQ) return { state: 'umbra', frac: 0 };
    const dx = sunTeme.x - satTeme.x, dy = sunTeme.y - satTeme.y, dz = sunTeme.z - satTeme.z;
    const ds = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const thE = Math.asin(Math.min(1, RE_EQ / rs));
    const thS = Math.asin(Math.min(1, R_SUN_KM / ds));
    // angle at the satellite between the Earth's centre and the Sun's centre
    const cosT = (-satTeme.x * dx - satTeme.y * dy - satTeme.z * dz) / (rs * ds);
    const th = Math.acos(Math.max(-1, Math.min(1, cosT)));
    if (th >= thE + thS) return { state: 'none', frac: 1 };
    if (th <= thE - thS) return { state: 'umbra', frac: 0 };
    // partial: unobscured fraction of the solar disc, exact circle-circle overlap
    const r1 = thS, r2 = thE, d = Math.max(th, 1e-12);
    const a1 = Math.acos(Math.max(-1, Math.min(1, (d * d + r1 * r1 - r2 * r2) / (2 * d * r1))));
    const a2 = Math.acos(Math.max(-1, Math.min(1, (d * d + r2 * r2 - r1 * r1) / (2 * d * r2))));
    const overlap = r1 * r1 * (a1 - Math.sin(2 * a1) / 2) + r2 * r2 * (a2 - Math.sin(2 * a2) / 2);
    const frac = Math.max(0, Math.min(1, 1 - overlap / (Math.PI * r1 * r1)));
    return { state: 'penumbra', frac: frac };
  }

  /* ---- scan --------------------------------------------------------------- */

  /** Resolve the scan parameters into the derived quantities every stage needs.
   *  Nothing here depends on a satellite, so it happens exactly once. */
  function prepare(params) {
    const p = params || {};
    const site = p.site;
    const dut1S = p.dut1S || 0;
    const fov = p.fov || {};
    const steps = p.steps || {};
    const filters = p.filters || {};

    const shape = fov.shape === 'circ' ? 'circ' : 'rect';
    const halfW = (fov.wDeg || 0) / 2, halfH = (fov.hDeg || 0) / 2;
    // Coarse stage works with a single circumscribing radius; the true rectangle
    // is only imposed in stage 3, where the cost of getting it exactly right is paid
    // on a handful of objects instead of the whole catalogue.
    const fovRadiusDeg = shape === 'circ'
      ? (fov.rDeg || 0)
      : Math.sqrt(halfW * halfW + halfH * halfH);

    const obsKind = site && site.kind === 'orbit' ? 'orbit' : 'ground';

    // Orbit sites clamp the coarse step to <= 10 s (CONTRACT "Stage 2/3 under a
    // moving observer"): the chord rescue assumes near-rectilinear RELATIVE motion
    // across one step, and the residual curvature scales with dt^2. scan.js clamps
    // its estimate the same way so the refusal maths stay honest.
    const coarseStepS = obsKind === 'orbit'
      ? Math.max(0.5, Math.min(10, steps.coarseStepS || 30))
      : Math.max(0.5, steps.coarseStepS || 30);
    const fineStepS = Math.max(0.05, steps.fineStepS || 1);
    const spanMin = Math.max(0, p.spanMin || 0);
    const t0Ms = p.t0Ms;
    const t1Ms = t0Ms + spanMin * 60000;
    // A UNIFORM grid that covers the span: the last step may overshoot t1 by less
    // than one step, and the satellite, the observer and the pointing are all
    // evaluated at that same instant. (Rounding the count and clamping only the
    // observer's clock to t1, as rounds 1-21 did, propagated the satellite to one
    // time and the observer to another on the final step.)
    const nSteps = Math.max(1, Math.ceil(spanMin * 60 / coarseStepS - 1e-9)) + 1;

    // Ground: hoist the constant ECEF vector (stage 3 calls the provider once per
    // fine sample). Orbit: build the observer satrec ONCE, here. An invalid
    // observer TLE fails the scan loudly at prepare time — it must never fail open
    // into "scanned from (0,0,0)" (CONTRACT "The observer provider").
    let ecef = { x: 0, y: 0, z: 0 }, siteR = 0, siteGcLatDeg = 0, obs = null;
    if (obsKind === 'orbit') {
      let rec = null;
      try { rec = satellite.twoline2satrec(site.l1, site.l2); } catch (e) { rec = null; }
      if (!validSatrec(rec)) {
        throw new Error('observer TLE for NORAD ' + site.norad +
          (site.name ? ' (' + site.name + ')' : '') + ' cannot be propagated');
      }
      const rad = orbitRadii(rec);
      const jd0 = t0Ms / 86400000 + 2440587.5;
      const ageDays = Math.abs(jd0 - rec.jdsatepoch);
      obs = {
        rec: rec, epochJd: rec.jdsatepoch, norad: site.norad,
        rObsMin: rad.rPeri, rObsMax: rad.rApo,
        nRadS: meanMotion(rec) / 60,
        slopKm: Math.min(TLE_ERR_KM_MAX, TLE_ERR_KM0 + TLE_ERR_KM_PER_DAY * ageDays),
        tsince0: (jd0 - rec.jdsatepoch) * 1440,     // minutes since epoch at t0
      };
    } else {
      ecef = siteEcefKm(site);
      siteR = Math.sqrt(ecef.x * ecef.x + ecef.y * ecef.y + ecef.z * ecef.z);
      // geocentric, not geodetic: the inclination bound is on geocentric latitude
      siteGcLatDeg = Math.asin(ecef.z / siteR) * R2D;
    }

    return {
      site: site, dut1S: dut1S, filters: filters,
      pointing: p.pointing || { track: 'sky', raDeg: 0, decDeg: 0 },
      shape: shape, halfW: halfW, halfH: halfH,
      rotDeg: fov.rotDeg || 0,
      fovRadiusDeg: fovRadiusDeg, fovRadiusRad: fovRadiusDeg * D2R,
      coarseStepS: coarseStepS, fineStepS: fineStepS,
      marginDeg: steps.marginDeg || 0,
      spanMin: spanMin, t0Ms: t0Ms, t1Ms: t1Ms, nSteps: nSteps,
      // minEl is a ground concept (horizon obstruction / extinction); an orbit
      // site's equivalent is the limb-occlusion gate, so the filter is forced off.
      minElDeg: obsKind === 'orbit' ? 0 : (filters.minElDeg || 0),
      sinMinEl: obsKind === 'orbit' ? 0 : Math.sin((filters.minElDeg || 0) * D2R),
      siteEcef: ecef, siteR: siteR, siteGcLatDeg: siteGcLatDeg,
      obsKind: obsKind, obs: obs,
      obsSlopKm: obs ? obs.slopKm : 0,
      excludeNorad: obs ? obs.norad : null,
      useStage1: p.useStage1 !== false,
      maxCrossings: p.maxCrossings || 5000,
      // clear-time bound: the field's circumscribing radius, padded. A field of
      // 90 deg or more leaves no room outside it, the bound returns 0 and every
      // step is examined — correct, just not accelerated.
      sinR: Math.sin(Math.min(90, fovRadiusDeg + (steps.marginDeg || 0) + PAD_ANG_DEG) * D2R),
      Vs: 0, OmP: 0, omObs: 0,        // filled by buildTables()
      field: null,                    // filled by fieldSetup()
    };
  }

  /** Observer state in TEME km and km/s — THE one place observer kind matters
   *  downstream of prepare() (CONTRACT "Orbital observing stations").
   *
   *  ground — v_TEME = R3(-gmst) . v_ECEF with the ECEF vector hoisted, plus the
   *           inertial site velocity omega_z x r that stage 2's rate margin and
   *           stage 3's range-rate always needed and used to rebuild inline;
   *  orbit  — one sgp4() on the observer satrec. A failure THROWS and fails the
   *           whole scan: a scan quietly run from (0,0,0) is the worst bug here. */
  function obsStateAt(P, date) { return obsStateMs(P, date.getTime()); }

  /** obsStateAt on a millisecond clock, fractional milliseconds included.
   *
   *  The orbit branch forms the observer's time-since-epoch EXACTLY as every
   *  target's is formed — an offset from the scan start, not a fresh Julian date.
   *  A Julian date near 2.46 million days resolves only ~40 us, and a Date drops
   *  the fraction of a millisecond; at 7.7 km/s those are 0.3 m and 7.7 m of
   *  observer jitter. Harmless against a target a thousand kilometres away, but a
   *  catalogue also holds objects that fly WITH the observer — the other ISS
   *  modules carry the station's own elements — and for those the jitter was the
   *  entire topocentric vector: a direction made of rounding noise, flickering
   *  through the field a thousand times a minute. Formed identically, a
   *  co-located object has range exactly zero and is never "in the field". */
  function obsStateMs(P, tMs) {
    if (P.obsKind === 'orbit') {
      const tsince = P.obs.tsince0 + (tMs - P.t0Ms) / 60000;
      let pv = null;
      try { pv = satellite.sgp4(P.obs.rec, tsince); } catch (e) { pv = null; }
      if (!pv || !pv.position || pv.position === false || !isFinite(pv.position.x)) {
        throw new Error('observer SGP4 failed at ' + new Date(tMs).toISOString() +
          ' (NORAD ' + P.obs.norad + ')');
      }
      return {
        x: pv.position.x, y: pv.position.y, z: pv.position.z,
        vx: pv.velocity.x, vy: pv.velocity.y, vz: pv.velocity.z,
      };
    }
    const e = P.siteEcef;
    // gstime() of a numeric Julian date: identical to the Date path at integer
    // milliseconds, and it does not truncate between them
    const g = satellite.gstime(tMs / 86400000 + 2440587.5 + P.dut1S / 86400);
    const c = Math.cos(g), s = Math.sin(g);
    const x = e.x * c - e.y * s, y = e.x * s + e.y * c;
    return { x: x, y: y, z: e.z, vx: -OMEGA_E * y, vy: OMEGA_E * x, vz: 0 };
  }

  /* ---- the clear-time bound -------------------------------------------------
   *
   * THE QUESTION both stage 2 and stage 3 ask: the satellite is at range rho and
   * D km from the sightline. How long before it could possibly be in the field?
   *
   * In the field means within angle R of the boresight, i.e. within rho*sin(R) km
   * of the sightline ray. So the gap to close is  C = D - rho*sin(R).  It closes
   * no faster than things move:
   *
   *   - the satellite, at most its perigee speed  V_sat  (from its osculating
   *     state, padded);
   *   - the ray's origin, at most the observer's speed  V_s;
   *   - the ray's direction, turning at most  Om_p  rad/s, which sweeps the point
   *     of the ray nearest the satellite at Om_p x (its range) — and that range is
   *     at most rho + V_r*t, with  V_r = V_sat + V_s  the fastest the range grows.
   *
   * And rho*sin(R) itself grows no faster than V_r*sin(R). In-field is therefore
   * impossible while
   *
   *   C  >  [V_r (1 + sin R) + Om_p rho] t  +  (Om_p V_r / 2) t^2 ,
   *
   * a quadratic whose positive root is the returned time. It holds BACKWARDS in
   * time as well, by the same argument. Nothing here assumes a kind of orbit, a
   * kind of observer or a kind of tracking: V_s and Om_p are measured off the
   * per-step observer/pointing tables (buildTables), so a ground site, an orbit
   * site, a sidereal field and an LVLH-fixed one are all the same code.
   *
   * Returns seconds; 0 when the object may already be in the field (or when its
   * state is not a bound orbit and no speed limit can be vouched for).
   */
  function clearTime(P, rho, D, r, v) {
    const C = D - rho * P.sinR - PAD_KM - rho * LT_PAD;
    if (!(C > 0)) return 0;
    const rr = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
    const eps = 0.5 * (v.x * v.x + v.y * v.y + v.z * v.z) - MU / rr;
    if (!(eps < 0)) return 0;                       // not a bound orbit
    const hx = r.y * v.z - r.z * v.y, hy = r.z * v.x - r.x * v.z, hz = r.x * v.y - r.y * v.x;
    const h2 = hx * hx + hy * hy + hz * hz;
    if (!(h2 > 0)) return 0;
    const e2 = 1 + 2 * eps * h2 / (MU * MU);        // osculating eccentricity^2
    const vPeri = MU * (1 + (e2 > 0 ? Math.sqrt(e2) : 0)) / Math.sqrt(h2);
    const Vr = VMAX_PAD * vPeri + VMAX_PAD_KMS + P.Vs;
    const A = Vr * (1 + P.sinR) + P.OmP * rho;
    const b = 0.5 * P.OmP * Vr;
    return 2 * C / (A + Math.sqrt(A * A + 4 * b * C));
  }

  /* ---- the detector frame, as vectors ---------------------------------------
   *
   * The field is a rectangle (or circle) on a tangent plane whose axes are the
   * boresight b and the two detector axes ex, ey — rotDeg being the position
   * angle of +Y from J2000 north. Membership is then three dot products,
   *     X = (w.ex)/(w.b),  Y = (w.ey)/(w.b),
   * with no RA/Dec and no trigonometry per sample. What differs between tracking
   * modes is only WHICH FRAME those three vectors are constant in:
   *
   *   mode 0  track 'sky'            — fixed in J2000 (rotated to TEME per bucket)
   *   mode 1  track 'mount', ground  — fixed to the Earth (a parked mount)
   *   mode 2  track 'mount', orbit   — fixed in LVLH (a body-mounted sensor)
   *
   * For the two mount modes rotDeg is read AT THE SCAN START and the detector is
   * then carried rigidly with the mount. On the ground that changes nothing — a
   * fixed alt/az has a fixed hour angle and declination, so its parallactic angle
   * is constant — but in LVLH the sky turns under the sensor once per orbit, and
   * a rectangle held at a constant angle to celestial north (rounds 8-21) was not
   * the rectangle a body-fixed detector sweeps.
   */
  function fieldSetup(P) {
    const d0 = new Date(P.t0Ms);
    const s0 = obsStateAt(P, d0);
    const pt = pointingAt(P, d0, s0);
    const a = pt.raDeg * D2R, d = pt.decDeg * D2R;
    const sa = Math.sin(a), ca = Math.cos(a), sd = Math.sin(d), cd = Math.cos(d);
    const bJ = { x: cd * ca, y: cd * sa, z: sd };
    const eJ = { x: -sa, y: ca, z: 0 };                    // east
    const nJ = { x: -sd * ca, y: -sd * sa, z: cd };        // north
    const r = P.rotDeg * D2R, cr = Math.cos(r), sr = Math.sin(r);
    // X = xi cos(rot) - eta sin(rot), Y = xi sin(rot) + eta cos(rot): a point at
    // position angle rotDeg lands on +Y (frames.js tanProject, then the chart's rot)
    const xJ = { x: eJ.x * cr - nJ.x * sr, y: eJ.y * cr - nJ.y * sr, z: eJ.z * cr - nJ.z * sr };
    const yJ = { x: eJ.x * sr + nJ.x * cr, y: eJ.y * sr + nJ.y * cr, z: eJ.z * sr + nJ.z * cr };
    const flat = (u, v, w) => new Float64Array([u.x, u.y, u.z, v.x, v.y, v.z, w.x, w.y, w.z]);
    if (P.pointing.track !== 'mount') {
      return { mode: 0, c: flat(bJ, xJ, yJ), teme: new Float64Array(9), bucket: NaN };
    }
    const bT = j2000ToTeme(bJ, d0), xT = j2000ToTeme(xJ, d0), yT = j2000ToTeme(yJ, d0);
    if (P.obsKind === 'orbit') {
      const B = lvlhBasis({ x: s0.x, y: s0.y, z: s0.z }, { x: s0.vx, y: s0.vy, z: s0.vz });
      if (!B) throw new Error('degenerate observer state (r parallel to v) — cannot form LVLH');
      const co = (u) => ({
        x: u.x * B.S.x + u.y * B.S.y + u.z * B.S.z,
        y: u.x * B.W.x + u.y * B.W.y + u.z * B.W.z,
        z: u.x * B.R.x + u.y * B.R.y + u.z * B.R.z,
      });
      return { mode: 2, c: flat(co(bT), co(xT), co(yT)) };
    }
    const g = gmstRad(d0, P.dut1S), c = Math.cos(g), sn = Math.sin(g);
    const toE = (u) => ({ x: u.x * c + u.y * sn, y: -u.x * sn + u.y * c, z: u.z });
    return { mode: 1, c: flat(toE(bT), toE(xT), toE(yT)) };
  }

  /** J2000 -> TEME as a 3x3 (row-major), re-derived once per BUCKET_MS. The search
   *  samples of stage 3 use this instead of running the 20-term nutation series
   *  per sample; everything REPORTED still goes through the exact functions. */
  let rotBucket = NaN;
  const ROT = new Float64Array(9);
  function rotJ2T(tMs) {
    const bk = Math.floor(tMs / BUCKET_MS);
    if (bk !== rotBucket) {
      const dt = new Date((bk + 0.5) * BUCKET_MS);
      const ex = j2000ToTeme({ x: 1, y: 0, z: 0 }, dt);
      const ey = j2000ToTeme({ x: 0, y: 1, z: 0 }, dt);
      const ez = j2000ToTeme({ x: 0, y: 0, z: 1 }, dt);
      ROT[0] = ex.x; ROT[1] = ey.x; ROT[2] = ez.x;
      ROT[3] = ex.y; ROT[4] = ey.y; ROT[5] = ez.y;
      ROT[6] = ex.z; ROT[7] = ey.z; ROT[8] = ez.z;
      rotBucket = bk;
    }
    return ROT;
  }

  /** One fast sample: where the object is relative to the field at tMs, and how
   *  long it is safe to step before looking again.
   *
   *  Returns { t, ok, in, sep, h }:
   *    in  — inside the true field boundary AND visible (above the horizon / the
   *          minimum elevation on the ground; clear of the Earth's limb in orbit);
   *    sep — angle from the boresight, degrees (closest approach minimises this);
   *    h   — seconds until the membership could change (see SAFETY / RANGE_FRAC),
   *          or, while the object is well outside, the rigorous clearTime().
   *  With `sky` set it also returns the J2000 raDeg/decDeg, for the path samples.
   */
  function probe(P, rec, tsince0Min, tMs, sky) {
    let pv;
    try { pv = satellite.sgp4(rec, tsince0Min + (tMs - P.t0Ms) / 60000); } catch (e) { pv = null; }
    if (!pv || !pv.position || pv.position === false || !pv.velocity) {
      return { t: tMs, ok: false, in: false, sep: 999, h: P.fineStepS };
    }
    const r = pv.position, v = pv.velocity;

    // observer state; the ground branch keeps cos/sin(GMST) for the field frame
    let sx, sy, sz, svx, svy, svz, gc = 1, gs = 0;
    if (P.obsKind === 'orbit') {
      const st = obsStateMs(P, tMs);
      sx = st.x; sy = st.y; sz = st.z; svx = st.vx; svy = st.vy; svz = st.vz;
    } else {
      const g = satellite.gstime(tMs / 86400000 + 2440587.5 + P.dut1S / 86400);
      gc = Math.cos(g); gs = Math.sin(g);
      const e = P.siteEcef;
      sx = e.x * gc - e.y * gs; sy = e.x * gs + e.y * gc; sz = e.z;
      svx = -OMEGA_E * sy; svy = OMEGA_E * sx; svz = 0;
    }

    // topocentric vector, light-time corrected to first order: the photon left
    // rho/c ago, when the satellite was v*rho/c further back along its track
    let wx = r.x - sx, wy = r.y - sy, wz = r.z - sz;
    let rho = Math.sqrt(wx * wx + wy * wy + wz * wz);
    const tau = rho / C_KM_S;
    wx -= v.x * tau; wy -= v.y * tau; wz -= v.z * tau;
    rho = Math.sqrt(wx * wx + wy * wy + wz * wz);
    // exactly co-located with the observer: no direction exists, and it will not
    // acquire one — look again in ten minutes rather than every 10 ms
    if (!(rho > 0)) return { t: tMs, ok: false, in: false, sep: 999, h: H_MAX_S };

    // detector frame in TEME at this instant, and its rotation rate (Ox,Oy,Oz)
    const F = P.field, c = F.c;
    let bx, by, bz, exx, exy, exz, eyx, eyy, eyz, Ox = 0, Oy = 0, Oz = 0;
    const sR2 = sx * sx + sy * sy + sz * sz, sR = Math.sqrt(sR2);
    if (F.mode === 0) {
      const bk = Math.floor(tMs / BUCKET_MS);
      const T = F.teme;
      if (bk !== F.bucket) {
        const M = rotJ2T(tMs);
        for (let i = 0; i < 9; i += 3) {
          T[i] = M[0] * c[i] + M[1] * c[i + 1] + M[2] * c[i + 2];
          T[i + 1] = M[3] * c[i] + M[4] * c[i + 1] + M[5] * c[i + 2];
          T[i + 2] = M[6] * c[i] + M[7] * c[i + 1] + M[8] * c[i + 2];
        }
        F.bucket = bk;
      }
      bx = T[0]; by = T[1]; bz = T[2];
      exx = T[3]; exy = T[4]; exz = T[5];
      eyx = T[6]; eyy = T[7]; eyz = T[8];
    } else if (F.mode === 1) {
      bx = c[0] * gc - c[1] * gs; by = c[0] * gs + c[1] * gc; bz = c[2];
      exx = c[3] * gc - c[4] * gs; exy = c[3] * gs + c[4] * gc; exz = c[5];
      eyx = c[6] * gc - c[7] * gs; eyy = c[6] * gs + c[7] * gc; eyz = c[8];
      Oz = OMEGA_E;
    } else {
      // LVLH basis from the observer state: R zenith, W orbit normal, S along-track
      const Rx = sx / sR, Ry = sy / sR, Rz = sz / sR;
      let Wx = sy * svz - sz * svy, Wy = sz * svx - sx * svz, Wz = sx * svy - sy * svx;
      const wn = Math.sqrt(Wx * Wx + Wy * Wy + Wz * Wz);
      Ox = Wx / sR2; Oy = Wy / sR2; Oz = Wz / sR2;         // Omega_LVLH = (r x v)/|r|^2
      Wx /= wn; Wy /= wn; Wz /= wn;
      const Sx = Wy * Rz - Wz * Ry, Sy = Wz * Rx - Wx * Rz, Sz = Wx * Ry - Wy * Rx;
      bx = c[0] * Sx + c[1] * Wx + c[2] * Rx; by = c[0] * Sy + c[1] * Wy + c[2] * Ry;
      bz = c[0] * Sz + c[1] * Wz + c[2] * Rz;
      exx = c[3] * Sx + c[4] * Wx + c[5] * Rx; exy = c[3] * Sy + c[4] * Wy + c[5] * Ry;
      exz = c[3] * Sz + c[4] * Wz + c[5] * Rz;
      eyx = c[6] * Sx + c[7] * Wx + c[8] * Rx; eyy = c[6] * Sy + c[7] * Wy + c[8] * Ry;
      eyz = c[6] * Sz + c[7] * Wz + c[8] * Rz;
    }

    const zc = wx * bx + wy * by + wz * bz;                // along the boresight
    const D = zc > 0 ? Math.sqrt(Math.max(0, rho * rho - zc * zc)) : rho;
    const dtRig = clearTime(P, rho, D, r, v);

    // relative velocity, inertial, and the inertial angular speed of the direction
    const ux = v.x - svx, uy = v.y - svy, uz = v.z - svz;
    const radial = (ux * wx + uy * wy + uz * wz) / rho;
    const wDir = Math.sqrt(Math.max(0, ux * ux + uy * uy + uz * uz - radial * radial)) / rho;

    // ---- visibility: gV <= 0 visible, > 0 hidden by that many degrees ----------
    const up = wx * sx + wy * sy + wz * sz;
    let gV, sV;
    if (P.obsKind === 'orbit') {
      // Earth-limb occlusion (CONTRACT v0.2 gate 1): hidden iff the target lies
      // beyond the line of sight's closest point to the Earth's centre AND that
      // point is inside the hard sphere. In angles: nadir distance < limb angle.
      const tStar = -up / rho;
      if (tStar > 0 && tStar < rho) {
        gV = (Math.asin(Math.min(1, RE_EQ / sR))
          - Math.asin(Math.min(1, Math.sqrt(Math.max(0, sR2 - tStar * tStar)) / sR))) * R2D;
      } else gV = -90;
      sV = (wDir + P.omObs) * R2D;
    } else {
      // The site vector IS the local up (geocentric), as in rounds 1-21. A ground
      // target is in the field only while above the horizon — or minElDeg.
      gV = P.minElDeg - Math.asin(Math.max(-1, Math.min(1, up / (rho * sR)))) * R2D;
      sV = (wDir + OMEGA_E) * R2D;
    }

    // ---- field: gF <= 0 inside, > 0 outside by that many (tangent-plane) degrees
    let gF, sF = 0, sep, tx = 0, ty = 0;
    const cosSep = Math.max(-1, Math.min(1, zc / rho));
    if (zc > 1e-9 * rho) {
      tx = (wx * exx + wy * exy + wz * exz) / zc;
      ty = (wx * eyx + wy * eyy + wz * eyz) / zc;
      const tr2 = tx * tx + ty * ty;
      sep = Math.atan(Math.sqrt(tr2)) * R2D;
      // velocity as the DETECTOR sees it: relative velocity minus the frame's turning
      const fx = ux - (Oy * wz - Oz * wy), fy = uy - (Oz * wx - Ox * wz), fz = uz - (Ox * wy - Oy * wx);
      const dz = fx * bx + fy * by + fz * bz;
      const dX = ((fx * exx + fy * exy + fz * exz) - tx * dz) / zc;
      const dY = ((fx * eyx + fy * eyy + fz * eyz) - ty * dz) / zc;
      const sp = Math.sqrt(dX * dX + dY * dY) * R2D;       // tangent-plane deg/s
      if (P.shape === 'circ') {
        gF = sep - P.fovRadiusDeg;
        sF = sp / (1 + tr2);                               // d(sep)/dt <= that
      } else {
        const qx = Math.abs(tx) * R2D - P.halfW, qy = Math.abs(ty) * R2D - P.halfH;
        gF = (qx > 0 || qy > 0)
          ? Math.sqrt((qx > 0 ? qx * qx : 0) + (qy > 0 ? qy * qy : 0))
          : Math.max(qx, qy);
        sF = sp;
      }
    } else {
      sep = Math.acos(cosSep) * R2D;
      gF = 1e9;
    }

    const inF = gF <= 0 && gV <= 0;
    // RANGE_FRAC cap: the time in which the viewing geometry can change by a
    // quarter — the range at the relative speed, or, for an object flying WITH
    // the observer (relative speed ~0), the relative orbit at the orbital rate.
    const cap = RANGE_FRAC / (Math.sqrt(ux * ux + uy * uy + uz * uz) / rho + CO_ORBIT_RATE);
    const hF = SAFETY * Math.abs(gF) / Math.max(sF, 1e-12);
    const hV = SAFETY * Math.abs(gV) / Math.max(sV, 1e-12);
    let h;
    if (inF) {
      h = Math.min(hF, hV, cap);
    } else {
      let hf = 0;
      if (gF > 0) {
        // near the field the tangent-plane distance is trusted; further out only
        // the angle to the circumscribing circle — and always at least the
        // rigorous clear time, which is the only thing trusted far away
        let heur = 0;
        if (zc > 0 && sep < 60) heur = hF;
        else {
          const gA = sep - P.fovRadiusDeg;
          if (gA > 0) heur = SAFETY * gA / Math.max((wDir + P.OmP) * R2D, 1e-12);
        }
        hf = Math.max(dtRig, Math.min(cap, heur));
      }
      h = Math.max(hf, gV > 0 ? Math.min(hV, cap) : 0);
    }
    if (!(h > H_MIN_S)) h = H_MIN_S; else if (h > H_MAX_S) h = H_MAX_S;

    const out = { t: tMs, ok: true, in: inF, sep: sep, h: h };
    if (sky) {
      // TEME -> J2000 is the transpose of the bucketed J2000 -> TEME rotation
      const M = rotJ2T(tMs);
      const jx = M[0] * wx + M[3] * wy + M[6] * wz;
      const jy = M[1] * wx + M[4] * wy + M[7] * wz;
      const jz = M[2] * wx + M[5] * wy + M[8] * wz;
      let ra = Math.atan2(jy, jx) * R2D;
      if (ra < 0) ra += 360;
      out.raDeg = ra;
      out.decDeg = Math.asin(Math.max(-1, Math.min(1, jz / rho))) * R2D;
    }
    return out;
  }

  /** Pointing at one epoch: the TEME unit vector the hot loop compares against,
   *  plus the J2000 RA/Dec stage 3 needs for the chart-frame boundary test.
   *
   *  track 'sky'   — the field is fixed on the celestial sphere, so the J2000
   *                  RA/Dec is constant and only the J2000->TEME rotation moves.
   *  track 'mount' — ground: fixed in alt/az (parked telescope, drift scan), so
   *                  the RA/Dec is re-derived every epoch. Orbit: fixed in LVLH
   *                  (a body-mounted staring sensor) — azDeg/elDeg are LVLH
   *                  angles, the boresight comes straight off the observer PV in
   *                  TEME, and refraction never applies (CONTRACT v0.2).
   *
   *  Either way this is ONE call per epoch, outside the satellite loop, and the
   *  caller hands in the observer state it already has. Rotating the pointing
   *  rather than the catalogue is worth more than everything else in this file
   *  combined. */
  function pointingAt(P, date, obsSt) {
    const pt = P.pointing;
    if (pt.track === 'mount' && P.obsKind === 'orbit') {
      const basis = lvlhBasis(
        { x: obsSt.x, y: obsSt.y, z: obsSt.z },
        { x: obsSt.vx, y: obsSt.vy, z: obsSt.vz });
      if (!basis) {
        throw new Error('degenerate observer state (r parallel to v) — cannot form LVLH');
      }
      const t = lvlhToVec(pt.azDeg || 0, pt.elDeg || 0, basis);   // already TEME
      const rd = vecToRaDec(temeToJ2000(t, date));
      return { x: t.x, y: t.y, z: t.z, raDeg: rd.raDeg, decDeg: rd.decDeg };
    }
    let raDeg, decDeg;
    if (pt.track === 'mount') {
      const rd = altAzToRaDec(pt.azDeg, pt.elDeg, P.site, date,
        { refract: !!pt.refract, dut1S: P.dut1S });
      raDeg = rd.raDeg; decDeg = rd.decDeg;
    } else {
      raDeg = pt.raDeg; decDeg = pt.decDeg;
    }
    const t = j2000ToTeme(raDecToVec(raDeg, decDeg), date);
    return { x: t.x, y: t.y, z: t.z, raDeg: raDeg, decDeg: decDeg };
  }

  /** Stage 1 — static geometric cull, no SGP4 at all.
   *
   *  Bill Gray's sat_id has no such cull: it brute-forces the catalogue at a single
   *  epoch, which is cheap. We scan a timespan, so every object removed here is
   *  removed from every one of the N coarse steps. Typical survival on a 27 k
   *  catalogue is 10-40%; a pointing near the pole kills the whole GEO belt.
   *
   *  Returns a Uint8Array of keep flags. Everything it uses comes out of the
   *  satrec — inclo, nodeo, no, ecco — so it never touches SGP4.
   */
  function stage1(P) {
    const n = recs.length;
    const keep = new Uint8Array(n);

    // Sample the sightline geometry at a handful of epochs, because the tests below
    // OR over samples — too sparse a cadence would CULL REAL OBJECTS, the one
    // failure a cull must never have (CONTRACT "Stage 1 under a moving observer").
    //   ground — the site vector sweeps at 15 deg/h with Earth rotation (and for
    //            track 'mount' the ray sweeps with it): a 15-minute cadence plus
    //            the pads below covers it, as v0.1 always did;
    //   orbit  — the observer sweeps its own orbit at up to ~4 deg/min, so sample
    //            ~2 deg of observer ARC per epoch, capped at 600 samples (SGP4 on
    //            ONE object is ~0.6 us — a full cap's worth costs under a
    //            millisecond). Whatever arc the cap leaves unresolved is repaid
    //            below as chordKm, charged per object as a tolerance pad.
    const spanS = P.spanMin * 60;
    const nT = P.obsKind === 'orbit'
      ? Math.max(2, Math.min(600, Math.ceil((P.obs.nRadS * spanS) / (2 * D2R)) + 1))
      : Math.max(2, Math.min(25, Math.ceil(P.spanMin / 15) + 1));
    const ep = [];
    for (let j = 0; j < nT; j++) {
      const d = new Date(P.t0Ms + (P.spanMin * 60000) * (nT === 1 ? 0 : j / (nT - 1)));
      const s = obsStateAt(P, d);
      const u = pointingAt(P, d, s);
      const un = Math.sqrt(u.x * u.x + u.y * u.y + u.z * u.z) || 1;
      const r = { x: u.x / un, y: u.y / un, z: u.z / un };
      ep.push({
        sx: s.x, sy: s.y, sz: s.z, rx: r.x, ry: r.y, rz: r.z,
        S: s.x * s.x + s.y * s.y + s.z * s.z,          // |s|^2
        Pr: s.x * r.x + s.y * r.y + s.z * r.z,          // s . r_hat
      });
    }

    // Between-sample observer motion, as a chord: a true observer position is
    // within chordKm of SOME sample, and the candidate point p = s + rho*r it
    // shifts satisfies |p| >= rPeri_target, so chordKm / rPeri_target radians of
    // extra tolerance makes the sampled tests provably conservative. Zero on the
    // ground, where the 15-min cadence was always resolved by CULL_PAD_DEG.
    let chordKm = 0;
    if (P.obsKind === 'orbit') {
      const dTheta = nT > 1 ? (P.obs.nRadS * spanS) / (nT - 1) : 0;
      chordKm = 2 * P.obs.rObsMax * Math.sin(Math.min(Math.PI, dTheta) / 2);
    }

    const obsRad = P.obsKind === 'orbit' ? P.obs.rObsMax : P.siteR;
    const spanDays = P.spanMin / 1440;
    const jd0 = P.t0Ms / 86400000 + 2440587.5;
    const fovR = P.fovRadiusDeg + P.marginDeg + CULL_PAD_DEG;
    const sinFov = Math.sin(Math.min(Math.PI / 2, fovR * D2R));

    for (let i = 0; i < n; i++) {
      const rec = recs[i];
      if (!rec) continue;

      const rad = orbitRadii(rec);
      // A cull must fail OPEN. If any of the derived geometry is not finite we keep
      // the object and let stage 2 decide with real SGP4, rather than silently
      // dropping it — "no satellites tonight" is the worst possible bug here.
      if (!(rad.rApo > 0) || !(rad.rPeri > 0) || !isFinite(rec.inclo) || !isFinite(rec.nodeo)) {
        keep[i] = 1;
        continue;
      }
      const incDeg = rec.inclo * R2D;
      // a retrograde orbit at i = 100 deg still only reaches |lat| = 80 deg
      const iEff = incDeg <= 90 ? incDeg : 180 - incDeg;

      // --- horizon reachability (GROUND ONLY) -------------------------------
      // The sub-satellite point never leaves |lat| <= iEff, so the smallest
      // possible ground arc between site and sub-point is |phi| - iEff. The object
      // can only ever be above the horizon if that is inside the horizon
      // half-angle acos(Re / r_apogee). Compared as a cosine so no acos is needed.
      // An orbit site has no fixed latitude and nothing is permanently hidden —
      // only limb-occluded per sample, which is stage 2's gate — so this cull is
      // skipped there (fail open; the plane test was always the strong one).
      if (P.obsKind !== 'orbit') {
        const minArc = Math.max(0, Math.abs(P.siteGcLatDeg) - iEff - CULL_PAD_DEG);
        if (Math.cos(minArc * D2R) < P.siteR / rad.rApo) continue;
      }

      // Range interval along the sightline: closest possible is perigee straight
      // overhead, furthest is apogee on the far side of the Earth (for an orbit
      // site, of the observer's own apogee-radius sphere).
      const rhoLo = Math.max(1, rad.rPeri - obsRad);
      const rhoHi = rad.rApo + obsRad;

      // observer between-sample motion, charged as an angle at this object's
      // closest possible geocentric radius — see chordKm above
      const padRad = chordKm > 0 ? chordKm / Math.max(rad.rPeri, RE_EQ) : 0;

      // --- declination reachability ---------------------------------------
      // A satellite seen along the ray sits at p = s + rho*r_hat. Its geocentric
      // declination is bounded by |dec| <= iEff, so we need some rho with
      // p_z^2 <= K |p|^2, K = sin^2(iEff + fov + pad). Quadratic in rho.
      const decLim = Math.min(90, iEff + fovR + padRad * R2D);
      const sk = Math.sin(decLim * D2R), K = sk * sk;

      // --- orbit-plane test (the strong one) ------------------------------
      // The satellite is always IN its orbital plane, so p_hat . n_hat == 0 exactly.
      // Tolerance absorbs the field radius plus the nodal regression of Omega:
      // nodedot = -1.5 J2 (Re/p)^2 n cos i. The regression runs from the ELEMENT
      // EPOCH, not from the scan start — nodeo is Omega at epoch, and a 5-day-old
      // LEO element set has already swept ~25 deg of node before the scan even
      // begins. Charging spanDays alone lost real boundary objects the moment the
      // catalogue was older than the CULL_PAD (caught by the cull on/off identity
      // test on a stale snapshot, 2026-07-25). Fresh short scans still get a very
      // tight test; only stale elements pay. Unlike the declination test this
      // uses Omega, so it discriminates WHICH polar orbits can reach this field,
      // not merely whether the inclination is big enough.
      const semiLatus = rad.aKm * (1 - rec.ecco * rec.ecco) / RE_WGS72;
      const nRadDay = meanMotion(rec) * 1440;
      const nodeDot = Math.abs(1.5 * J2 * (1 / (semiLatus * semiLatus)) * nRadDay * Math.cos(rec.inclo));
      const nodeDays = spanDays + Math.abs(jd0 - epochJd[i]);
      const tol = Math.min(1, sinFov + nodeDot * nodeDays + padRad);
      const tol2 = tol * tol;

      const si = Math.sin(rec.inclo), ci = Math.cos(rec.inclo);
      const nx = si * Math.sin(rec.nodeo), ny = -si * Math.cos(rec.nodeo), nz = ci;

      let okDec = false, okPlane = false;
      for (let j = 0; j < nT && !(okDec && okPlane); j++) {
        const e = ep[j];
        if (!okDec) {
          // (sz + rho rz)^2 - K(|s|^2 + 2 rho (s.r) + rho^2) <= 0
          okDec = quadMinLE0(e.rz * e.rz - K,
            2 * (e.sz * e.rz - K * e.Pr),
            e.sz * e.sz - K * e.S, rhoLo, rhoHi);
        }
        if (!okPlane) {
          // (s.n + rho (r.n))^2 - tol^2 |p|^2 <= 0
          const b = e.sx * nx + e.sy * ny + e.sz * nz;
          const c = e.rx * nx + e.ry * ny + e.rz * nz;
          okPlane = quadMinLE0(c * c - tol2,
            2 * (b * c - tol2 * e.Pr),
            b * b - tol2 * e.S, rhoLo, rhoHi);
        }
      }
      if (okDec && okPlane) keep[i] = 1;
    }
    return keep;
  }

  /** Per-step observer and pointing tables for stage 2, plus the three speed
   *  limits the clear-time bound needs, MEASURED off those same tables:
   *    P.Vs    — fastest the observer moves (km/s);
   *    P.OmP   — fastest the boresight turns in TEME (rad/s): ~0 for a sidereal
   *              field, the Earth's rate for a parked mount, the orbital rate for
   *              an LVLH-fixed sensor;
   *    P.omObs — fastest the nadir direction turns (orbit sites; limb test).
   *  One observer state and one pointing per step, outside every satellite loop
   *  (CONTRACT rule 4). An unpropagatable observer throws here and fails the scan
   *  loudly — see obsStateAt. */
  function buildTables(P) {
    const n = P.nSteps, stepMs = P.coarseStepS * 1000;
    const tabS = new Float64Array(n * 3), tabP = new Float64Array(n * 3);
    let Vs = 0, OmP = 0, omObs = 0;
    for (let k = 0; k < n; k++) {
      const date = new Date(P.t0Ms + k * stepMs);
      const st = obsStateAt(P, date);
      const pt = pointingAt(P, date, st);
      const pn = Math.sqrt(pt.x * pt.x + pt.y * pt.y + pt.z * pt.z) || 1;
      const o = k * 3;
      tabS[o] = st.x; tabS[o + 1] = st.y; tabS[o + 2] = st.z;
      tabP[o] = pt.x / pn; tabP[o + 1] = pt.y / pn; tabP[o + 2] = pt.z / pn;
      Vs = Math.max(Vs, Math.sqrt(st.vx * st.vx + st.vy * st.vy + st.vz * st.vz));
      const s2 = st.x * st.x + st.y * st.y + st.z * st.z;
      const hx = st.y * st.vz - st.z * st.vy, hy = st.z * st.vx - st.x * st.vz,
        hz = st.x * st.vy - st.y * st.vx;
      omObs = Math.max(omObs, Math.sqrt(hx * hx + hy * hy + hz * hz) / s2);
      if (k > 0) {
        const ax = tabP[o - 3], ay = tabP[o - 2], az = tabP[o - 1];
        const bx = tabP[o], by = tabP[o + 1], bz = tabP[o + 2];
        const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
        const ang = Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), ax * bx + ay * by + az * bz);
        OmP = Math.max(OmP, ang / P.coarseStepS);
      }
    }
    // chord-vs-arc and between-sample maxima: a few percent is far more than either
    P.Vs = Vs * 1.02 + 1e-3;
    P.OmP = OmP * 1.05 + 1e-12;
    P.omObs = omObs * 1.05;
    return { tabS: tabS, tabP: tabP };
  }

  /** The whole scan. Chunked with setTimeout so a 'cancel' message can land and so
   *  progress is reported; resolves with crossings plus the per-stage cull counts. */
  function runScan(params, onProgress) {
    const P = prepare(params);
    cancelled = false;
    const t0Wall = Date.now();
    const now = (typeof performance !== 'undefined' && performance.now)
      ? () => performance.now() : () => Date.now();
    // the detector frame and the step tables both need the observer, so an
    // unusable observer fails here, synchronously, before any work is queued
    P.field = fieldSetup(P);
    const tT = now();
    const tabs = buildTables(P);
    const tabS = tabs.tabS, tabP = tabs.tabP;

    return new Promise((resolve, reject) => {
      const n = recs.length;
      let propagations = 0;
      const timing = { stage1Ms: 0, stage2Ms: now() - tT, stage3Ms: 0 };

      // ---- stage 1 -------------------------------------------------------
      let tS = now();
      const keep = P.useStage1 ? stage1(P) : (() => {
        const k = new Uint8Array(n);
        for (let i = 0; i < n; i++) if (recs[i]) k[i] = 1;
        return k;
      })();

      const live = [];
      for (let i = 0; i < n; i++) {
        if (!keep[i]) continue;
        // Self-exclusion (CONTRACT v0.2 gate 5): the observer never identifies
        // itself. Applied here so it holds on the useStage1:false path too.
        if (P.excludeNorad != null && objs[i].norad === P.excludeNorad) continue;
        live.push(i);
      }
      const culledStage1 = n - badCount - live.length;
      timing.stage1Ms = now() - tS;

      // Per-survivor constants, hoisted out of the step loop.
      const nLive = live.length;
      const tsince0 = new Float64Array(nLive);   // minutes since element epoch at t0
      const slopKm = new Float64Array(nLive);
      const ageDays = new Float64Array(nLive);
      const jd0 = P.t0Ms / 86400000 + 2440587.5;
      for (let k = 0; k < nLive; k++) {
        tsince0[k] = (jd0 - epochJd[live[k]]) * 1440;
        const age = Math.abs(tsince0[k]) / 1440;
        ageDays[k] = age;
        slopKm[k] = Math.min(TLE_ERR_KM_MAX, TLE_ERR_KM0 + TLE_ERR_KM_PER_DAY * age);
      }

      // ---- stage 2: coarse sweep with skipping ---------------------------
      // Object by object, so one satrec stays hot and each object keeps its own
      // clock. At a step, clearTime() says how long the object provably cannot
      // be in the field:
      //   >= one step  -> jump that many whole steps (the bound holds for all of
      //                   them, and for the step just behind as well);
      //   <  one step  -> the object may be in the field within one step either
      //                   side: open the window [t - step, t + step].
      // A LEO object on the far side of the Earth is ~13 000 km from the
      // sightline and closes at <= ~8.5 km/s, so it is not looked at again for
      // 25 minutes; a typical orbit costs a dozen propagations instead of 190.
      // There is no horizon test here and no angular margin: an object below the
      // horizon is simply far from a sightline that points above it, and
      // visibility is imposed exactly, per sample, in stage 3.
      const nSteps = P.nSteps;
      const stepS = P.coarseStepS, stepMin = stepS / 60, stepMs = stepS * 1000;
      const maxSkip = Math.max(1, Math.floor(MAX_SKIP_S / stepS));
      const cands = [];                          // [{k, wins: [[a,b], ...]}]
      let ki = 0;

      const coarseChunk = () => {
        if (cancelled) { reject(new Error('cancelled')); return; }
        const tC = now();
        const deadline = Date.now() + SLICE_MS;
        let tick = 0;
        while (ki < nLive && ((++tick & 15) !== 0 || Date.now() < deadline)) {
          const rec = recs[live[ki]];
          const ts0 = tsince0[ki];
          let wins = null, wA = 0, wB = 0, open = false;
          let k = 0;
          while (k < nSteps) {
            let pv;
            try { pv = satellite.sgp4(rec, ts0 + k * stepMin); } catch (e) { pv = null; }
            propagations++;
            if (!pv || !pv.position || pv.position === false || !pv.velocity) { k++; continue; }
            const r = pv.position, o = k * 3;
            const dx = r.x - tabS[o], dy = r.y - tabS[o + 1], dz = r.z - tabS[o + 2];
            const rho2 = dx * dx + dy * dy + dz * dz;
            const proj = dx * tabP[o] + dy * tabP[o + 1] + dz * tabP[o + 2];
            const rho = Math.sqrt(rho2);
            // distance to the sightline RAY: behind the observer it is the range
            const D = proj > 0 ? Math.sqrt(Math.max(0, rho2 - proj * proj)) : rho;
            const clear = clearTime(P, rho, D, r, pv.velocity);
            if (clear >= stepS) {
              k += Math.min(maxSkip, Math.floor(clear / stepS));
              continue;
            }
            const tMs = P.t0Ms + k * stepMs;
            const a = tMs - stepMs, b = tMs + stepMs;
            if (open && a <= wB) wB = b;
            else {
              if (open) (wins || (wins = [])).push([wA, wB]);
              wA = a; wB = b; open = true;
            }
            k++;
          }
          if (open) (wins || (wins = [])).push([wA, wB]);
          if (wins) cands.push({ k: ki, wins: wins });
          ki++;
        }
        timing.stage2Ms += now() - tC;
        if (onProgress) onProgress({ done: ki, total: nLive, phase: 'coarse' });
        setTimeout(ki < nLive ? coarseChunk : fineChunk, 0);
      };

      // ---- stage 3 -------------------------------------------------------
      const crossings = [];
      let ci = 0;
      let culledStage3 = 0;

      const fineChunk = () => {
        if (cancelled) { reject(new Error('cancelled')); return; }
        const tF = now();
        const deadline = Date.now() + SLICE_MS;
        while (ci < cands.length && Date.now() < deadline) {
          const c = cands[ci++];
          const before = crossings.length;
          try { refine(P, live[c.k], tsince0[c.k], ageDays[c.k], slopKm[c.k], c.wins, crossings); }
          catch (e) { /* defensive: never let one bad object kill a scan */ }
          if (crossings.length === before) culledStage3++;
        }
        timing.stage3Ms += now() - tF;
        if (onProgress) onProgress({ done: ci, total: cands.length, phase: 'fine' });
        if (ci < cands.length) { setTimeout(fineChunk, 0); return; }

        crossings.sort((a, b) => a.tCaMs - b.tCaMs);
        resolve({
          crossings: crossings,
          culled: {
            total: n, bad: badCount,
            stage1: culledStage1,
            stage2: live.length - cands.length,
            stage3: culledStage3,
            survivors: live.length, candidates: cands.length,
          },
          propagations: propagations,
          // what a fixed-step sweep of the same survivors would have cost — the
          // skip factor is the ratio, and the UI may as well be able to say so
          gridPropagations: live.length * nSteps,
          timing: timing,
          ms: Date.now() - t0Wall,
        });
      };

      setTimeout(coarseChunk, 0);
    });
  }

  /** Full topocentric solution at one instant, through the EXACT frame functions.
   *  Used only for what is reported — the closest-approach row of each confirmed
   *  crossing — so it can afford the full nutation series; the search samples go
   *  through probe(). The direction is the ASTROMETRIC one: light-time corrected
   *  (the satellite as it was rho/c ago), no aberration — the place a plate
   *  solution against catalogue stars measures. */
  function solveAt(P, rec, tsinceMin, tMs) {
    const date = new Date(tMs);
    let pv;
    try { pv = satellite.sgp4(rec, tsinceMin); } catch (e) { return null; }
    if (!pv || !pv.position || pv.position === false) return null;

    const s = obsStateAt(P, date);
    const topo = { x: pv.position.x - s.x, y: pv.position.y - s.y, z: pv.position.z - s.z };
    let rho = Math.sqrt(topo.x * topo.x + topo.y * topo.y + topo.z * topo.z);
    const tau = rho / C_KM_S;
    topo.x -= pv.velocity.x * tau; topo.y -= pv.velocity.y * tau; topo.z -= pv.velocity.z * tau;
    rho = Math.sqrt(topo.x * topo.x + topo.y * topo.y + topo.z * topo.z);
    const j = temeToJ2000(topo, date);
    const rd = vecToRaDec(j);
    const pt = pointingAt(P, date, s);
    const sR = Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z);

    return {
      date: date, tMs: tMs, satTeme: pv.position, velTeme: pv.velocity,
      siteTeme: { x: s.x, y: s.y, z: s.z },
      siteVel: { x: s.vx, y: s.vy, z: s.vz },
      siteR: sR, topo: topo, rho: rho,
      raDeg: rd.raDeg, decDeg: rd.decDeg,
      sepDeg: sep(rd.raDeg, rd.decDeg, pt.raDeg, pt.decDeg),
    };
  }

  /** Refine one object's candidate windows into Crossings.
   *
   *  There is no sampling grid. Each window is WALKED: probe, step by however long
   *  probe() says the membership cannot change, probe again. Where two consecutive
   *  probes disagree the boundary between them is bisected to EDGE_TOL_MS against
   *  the same predicate, so entry/exit and membership can never disagree; closest
   *  approach is then a golden-section minimum of the boresight angle, bracketed
   *  by the samples either side of the smallest one.
   *
   *  Rounds 1-21 sampled every window at fineStepS and kept the samples that
   *  landed inside. At the default 1 s that MISSED any crossing shorter than a
   *  second whenever no sample fell in it — measured on the 2026-11-15 catalogue,
   *  9 of the 14 objects that crossed a 0.2 deg field in two hours, 12 of 32 for
   *  0.5 deg. fineStepS now only sets the spacing of the drawn path samples.
   *
   *  Photometry is deliberately NOT done here: magEst/streak need SAT.photo, which
   *  lives on the main thread and would otherwise become a third copy of the same
   *  maths. The worker returns the geometry photometry needs (rangeKm, phaseDeg,
   *  shadow) and scan.js fills the rest in for the handful of crossings. */
  function refine(P, idx, tsince0Min, ageD, slopKmVal, wins, out) {
    const rec = recs[idx];
    const obj = objs[idx];
    const fineMs = P.fineStepS * 1000;
    const at = (tMs) => probe(P, rec, tsince0Min, tMs, false);
    const exact = (tMs) => solveAt(P, rec, tsince0Min + (tMs - P.t0Ms) / 60000, tMs);

    // boundary between an outside instant and an inside one
    const edge = (tOut, tIn) => {
      for (let it = 0; it < 60 && Math.abs(tIn - tOut) > EDGE_TOL_MS; it++) {
        const mid = (tIn + tOut) / 2;
        if (at(mid).in) tIn = mid; else tOut = mid;
      }
      return tIn;
    };

    const emit = (tEnterF, tExitF, run) => {
      // integer milliseconds, clamped so rounding can never step outside the run
      const tEnter = Math.min(Math.ceil(tEnterF), Math.floor(tExitF));
      const tExit = Math.max(Math.floor(tExitF), tEnter);

      // ---- closest approach: golden-section minimum of the boresight angle ----
      // `run` holds every probe that landed inside; add the two ends, take the
      // smallest, and its neighbours bracket the true minimum.
      const pts = [{ t: tEnter, sep: at(tEnter).sep }];
      for (let q = 0; q < run.length; q++) {
        if (run[q].t > tEnter && run[q].t < tExit) pts.push(run[q]);
      }
      if (tExit > tEnter) pts.push({ t: tExit, sep: at(tExit).sep });
      let bi = 0;
      for (let q = 1; q < pts.length; q++) if (pts[q].sep < pts[bi].sep) bi = q;
      let lo = pts[Math.max(0, bi - 1)].t, hi = pts[Math.min(pts.length - 1, bi + 1)].t;
      let tCa = pts[bi].t;
      if (hi - lo > CA_TOL_MS) {
        const G = 0.6180339887498949;
        let x1 = hi - G * (hi - lo), x2 = lo + G * (hi - lo);
        let f1 = at(x1).sep, f2 = at(x2).sep;
        for (let it = 0; it < 80 && hi - lo > CA_TOL_MS; it++) {
          if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - G * (hi - lo); f1 = at(x1).sep; }
          else { lo = x1; x1 = x2; f1 = f2; x2 = lo + G * (hi - lo); f2 = at(x2).sep; }
        }
        tCa = (lo + hi) / 2;
      }
      // Round BEFORE the final solve: the crossing reports integer-ms tCaMs, and
      // solving at the unrounded instant leaves the reported RA/Dec up to ~2"
      // ahead of its own timestamp on a fast overhead pass (2000"/s x 0.5 ms).
      tCa = Math.round(Math.max(tEnter, Math.min(tExit, tCa)));

      const ca = exact(tCa);
      if (!ca) return;

      // TWO angular rates, because which one streaks the exposure depends on how
      // the instrument was tracking, and they can differ by everything:
      //
      //   sky   — d(RA,Dec)/dt, motion against the STARS: the streak on a
      //           sidereally-guided exposure. A geostationary satellite is NOT
      //           stationary here — it co-rotates with the Earth and so drifts
      //           through the star field at very nearly the sidereal rate, ~15"/s.
      //   mount — motion against the observer's OWN frame: the horizon for a
      //           parked ground mount (omega_E z), the LVLH frame for a staring
      //           orbital sensor (Omega = r x v / |r|^2) — CONTRACT v0.2 gate 2.
      //
      // Subtracting omega x rho converts the inertial rate into the rotating frame.
      // The cross product is formed in TEME and only then rotated to J2000, because
      // the north/east basis the position angles are measured in lives in J2000.
      // This is a frame change on vectors we already have, not a new propagation.
      const siteVel = ca.siteVel;
      const rhoDot = {
        x: ca.velTeme.x - siteVel.x,
        y: ca.velTeme.y - siteVel.y,
        z: ca.velTeme.z - siteVel.z,
      };
      const rangeRateKmS =
        (ca.topo.x * rhoDot.x + ca.topo.y * rhoDot.y + ca.topo.z * rhoDot.z) / ca.rho;
      const rhoJ = temeToJ2000(ca.topo, ca.date);
      const rhoDotJ = temeToJ2000(rhoDot, ca.date);
      let frameOm;                     // the observer frame's rotation, TEME rad/s
      if (P.obsKind === 'orbit') {
        const st = ca.siteTeme, sv = ca.siteVel;
        const r2o = st.x * st.x + st.y * st.y + st.z * st.z;
        frameOm = {
          x: (st.y * sv.z - st.z * sv.y) / r2o,
          y: (st.z * sv.x - st.x * sv.z) / r2o,
          z: (st.x * sv.y - st.y * sv.x) / r2o,
        };
      } else {
        frameOm = { x: 0, y: 0, z: OMEGA_E };
      }
      const omegaCrossRho = temeToJ2000({
        x: frameOm.y * ca.topo.z - frameOm.z * ca.topo.y,
        y: frameOm.z * ca.topo.x - frameOm.x * ca.topo.z,
        z: frameOm.x * ca.topo.y - frameOm.y * ca.topo.x,
      }, ca.date);
      const sky = skyRate(rhoJ, rhoDotJ, ca.rho);
      const mount = skyRate(rhoJ, {
        x: rhoDotJ.x - omegaCrossRho.x,
        y: rhoDotJ.y - omegaCrossRho.y,
        z: rhoDotJ.z - omegaCrossRho.z,
      }, ca.rho);
      const rateAsPerS = sky.rate, paDeg = sky.pa;

      const sun = sunTemeKm(ca.date);
      const sh = shadowState(ca.satTeme, sun);

      // phase angle: Sun - satellite - observer
      const s2o = {
        x: ca.siteTeme.x - ca.satTeme.x, y: ca.siteTeme.y - ca.satTeme.y,
        z: ca.siteTeme.z - ca.satTeme.z,
      };
      const s2s = { x: sun.x - ca.satTeme.x, y: sun.y - ca.satTeme.y, z: sun.z - ca.satTeme.z };
      const n1 = Math.sqrt(s2o.x * s2o.x + s2o.y * s2o.y + s2o.z * s2o.z);
      const n2 = Math.sqrt(s2s.x * s2s.x + s2s.y * s2s.y + s2s.z * s2s.z);
      const phaseDeg = Math.acos(Math.max(-1, Math.min(1,
        (s2o.x * s2s.x + s2o.y * s2s.y + s2o.z * s2s.z) / (n1 * n2)))) * R2D;

      // Sun's height above the observer's LOCAL HORIZONTAL — twilight on the
      // ground, the observer's own day/night state in orbit (CONTRACT v0.2
      // gate 3). Same formula either way; only the radius is per-epoch now.
      const sunHatDot = (sun.x * ca.siteTeme.x + sun.y * ca.siteTeme.y + sun.z * ca.siteTeme.z)
        / (Math.sqrt(sun.x * sun.x + sun.y * sun.y + sun.z * sun.z) * ca.siteR);
      const sunElDeg = 90 - Math.acos(Math.max(-1, Math.min(1, sunHatDot))) * R2D;

      // azDeg/elDeg are alt/az on the ground, LVLH angles in orbit (gate 4).
      let aa;
      if (P.obsKind === 'orbit') {
        const basis = lvlhBasis(ca.siteTeme, ca.siteVel);
        aa = basis ? vecToLvlh(ca.topo, basis) : { azDeg: 0, elDeg: 90 };
      } else {
        aa = raDecToAltAz(ca.raDeg, ca.decDeg, P.site, ca.date,
          { refract: !!P.pointing.refract, dut1S: P.dut1S });
      }

      // <= 64 path samples spanning tEnter..tExit, for the chart polyline
      const nP = Math.max(2, Math.min(64, Math.ceil((tExit - tEnter) / fineMs) + 1));
      const path = [];
      for (let q = 0; q < nP; q++) {
        const t = tEnter + (tExit - tEnter) * (q / (nP - 1));
        const sk = probe(P, rec, tsince0Min, t, true);
        if (sk.ok) path.push({ t: Math.round(t), raDeg: sk.raDeg, decDeg: sk.decDeg });
      }

      out.push({
        satId: obj.id, norad: obj.norad, name: obj.name, intl: obj.intl,
        tEnterMs: tEnter, tExitMs: tExit, tCaMs: tCa,
        sepCaDeg: ca.sepDeg,
        raDeg: ca.raDeg, decDeg: ca.decDeg,
        azDeg: aa.azDeg, elDeg: aa.elDeg,
        rangeKm: ca.rho, rangeRateKmS: rangeRateKmS,
        rateAsPerS: rateAsPerS, paDeg: paDeg,
        rateMountAsPerS: mount.rate, paMountDeg: mount.pa,
        phaseDeg: phaseDeg, shadow: sh.state, sunFrac: sh.frac,
        cls: classOf(rec), sunElDeg: sunElDeg,
        // surfaced so the UI never presents a match found only inside the TLE
        // slop as a confident identification (CONTRACT.md, stage 2)
        tleAgeDays: ageD, tleSlopDeg: Math.min(TLE_SLOP_MAX_RAD, slopKmVal / ca.rho) * R2D,
        rcs: obj.rcs, stdMag: obj.stdMag,
        path: path,
      });
    };

    // merge overlapping windows, then clamp to the scan span
    const merged = [];
    wins.slice().sort((a, b) => a[0] - b[0]).forEach((w) => {
      const a = Math.max(P.t0Ms, w[0]), b = Math.min(P.t1Ms, w[1]);
      if (b < a) return;
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    });

    for (let wi = 0; wi < merged.length; wi++) {
      const wa = merged[wi][0], wb = merged[wi][1];
      let cur = at(wa);
      let run = cur.in ? [cur] : null;
      let tEnter = cur.in ? wa : NaN;
      for (let guard = 0; cur.t < wb && guard < MAX_PROBES; guard++) {
        const nxt = at(Math.min(wb, cur.t + cur.h * 1000));
        if (cur.in && !nxt.in) {
          emit(tEnter, edge(nxt.t, cur.t), run);
          run = null;
        } else if (!cur.in && nxt.in) {
          tEnter = edge(cur.t, nxt.t);
          run = [nxt];
        } else if (nxt.in) run.push(nxt);
        cur = nxt;
      }
      if (run) emit(tEnter, wb, run);
    }
  }

  /* ---- worker message plumbing (skipped under node) ------------------------ */

  const core = {
    loadObjs: loadObjs, runScan: runScan, stage1: stage1, prepare: prepare,
    clearTime: clearTime, buildTables: buildTables, fieldSetup: fieldSetup, probe: probe,
    cancel: () => { cancelled = true; },
    count: () => objs.length,
  };

  if (typeof self !== 'undefined' && self.postMessage) {
    self.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.cmd === 'load') {
        const r = loadObjs(msg.objs || []);
        self.postMessage({ type: 'loaded', count: r.count, bad: r.bad });
      } else if (msg.cmd === 'scan') {
        // prepare() throws SYNCHRONOUSLY for an unpropagatable observer TLE
        // (CONTRACT v0.2) — that must become an 'error' message, not an uncaught
        // exception that surfaces as a generic worker crash.
        let job = null;
        try {
          job = runScan(msg.params, (p) => self.postMessage({
            type: 'progress', done: p.done, total: p.total, phase: p.phase,
          }));
        } catch (err) {
          self.postMessage({ type: 'error', error: String(err && err.message || err) });
        }
        if (job) job.then((res) => {
          self.postMessage({
            type: 'result', crossings: res.crossings, culled: res.culled,
            propagations: res.propagations, gridPropagations: res.gridPropagations,
            timing: res.timing, ms: res.ms,
          });
        }).catch((err) => {
          if (err && err.message === 'cancelled') {
            self.postMessage({ type: 'result', cancelled: true, crossings: [], culled: null });
          } else {
            self.postMessage({ type: 'error', error: String(err && err.message || err) });
          }
        });
      } else if (msg.cmd === 'cancel') {
        cancelled = true;
      }
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = core;
})();
