/* ===== chart.js — SAT.chart : gnomonic (TAN) sky chart, the main view ===== */
/*
 * Tangent plane at the pointing, drawn in the DETECTOR frame: the FOV rectangle is
 * axis-aligned on screen and `obs.rotDeg` / `obs.flipEW` turn the sky underneath it.
 * That is the orientation an observer can actually check against a real frame,
 * and it is why the scan defines its rectangular boundary in the same rotated frame.
 *
 * Projection and orientation are deliberately separate stages:
 *   frames.tanProject -> {xi, eta} degrees (xi east, eta north)   [sky geometry]
 *   skyToScreen       -> pixels, applying rot, flip, zoom and pan  [display only]
 * Nothing downstream of skyToScreen ever feeds back into the geometry, so a crossing
 * lands on the same star whichever way the user has the chart turned.
 *
 * The tangent point is a FUNCTION OF TIME, not a constant, and that is the whole of
 * `obs.track`. Sidereally guided ('sky'), the frame is pinned to the celestial sphere:
 * stars are dots and satellites streak, a geostationary object included — it drifts
 * through the star field at ~15"/s. Parked ('mount'), the frame is pinned to the
 * horizon: the sky turns under it, so the STARS trail and a geostationary object is
 * the fixed dot. Same pass, opposite pictures. Everything drawn across a time span
 * therefore asks frameAt() for the frame at that sample's own time; the two cases
 * are one code path, and 'sky' is just the case where frameAt is constant.
 *
 * ROUND 22 — the panel was redesigned around one job: HOLD THIS AGAINST A FRAME.
 *   - The window is four stacked parts, none overlapping the sky: a labelled
 *     toolbar, the chart, a TIME SLIDER over the scan window, and a status line.
 *     (Round 25: the slider lost its per-crossing colour bars — axis and thumb only.)
 *   - The field interior carries only what the image carries — stars and trails.
 *     Object names sit OUTSIDE the frame at each trail's end, placed so they never
 *     overlap; RA/Dec labels sit where each grid line leaves the frame.
 *   - Every trail is a clock: ticks at round UTC instants, so "where was it at
 *     12:30:10" can be read off the chart.
 *   - A trail can be hovered and clicked anywhere along its length, not only on
 *     the marker at the current instant.
 *   - The RULER measures a streak on the chart (length, position angle) and ranks
 *     the predicted trails by how well they match it.
 */
(function () {
  'use strict';

  // ---- module state --------------------------------------------------------
  var body = null, winRef = null, canvas = null, ctx = null;
  var viewEl = null, timeEl = null, tcanvas = null, tctx = null;
  var cssW = 0, cssH = 0, dpr = 1;            // chart canvas, CSS px
  var tlW = 0, tlH = 0;                       // timeline canvas, CSS px
  var dirty = false, rafQueued = false, warned = false;
  var view = { zoom: 1, panX: 0, panY: 0 };   // zoom is relative to the fit scale
  var markerHits = [];                        // [{id, x, y}]
  var trails = [];                            // this frame's in-field trails, in screen px
  var tlRange = null;                         // {t0, t1, x0, x1} of the drawn timeline
  var labelBoxes = [];                        // rectangles already taken by text this frame
  var hover = { id: null, t: null };          // crossing under the cursor, and WHEN on its trail
  var mouse = { x: 0, y: 0, inside: false };
  // Ruler end points are SKY positions, so the line stays on its stars under
  // zoom, pan and a running clock.
  var ruler = { on: false, a: null, b: null, dragging: false };
  var elHud = null, elStale = null, elCursor = null, elTip = null, elRuler = null, elZoom = null;
  var elPop = null, elMag = null, elMagAuto = null, elMirror = null;
  var toolBtns = {}, layerChecks = {};
  var drag = null, tlDrag = null, tlHover = false;

  // Star cone results. Re-queried only when the tangent point or the view radius
  // moves by more than 10% of the field — a cone query walks 130k stars, and doing
  // that on every animation frame is the difference between 60 fps and 6.
  var starCache = {
    ok: false, ra0: 0, dec0: 0, radiusDeg: 0, queryDeg: 0, magLimit: -99,
    stars: [], named: [], lines: [], cons: [],
  };

  // Detector frame, rebuilt once per render. `ref` is the frame at the clock time;
  // `knots` is the drift table used when the mount is parked (null when tracking).
  var frameRef = null;                  // {raDeg, decDeg, rotDeg}
  var mountFrameOf = null;              // parked mount: Date -> frame; null when tracking
  var starPts = [];                     // this frame's drawn stars [{x, y, mag}], for hover
  var frameKnots = null;                // {t0, dt, n, f: [frame, ...]}
  var curScale = 1, curCx = 0, curCy = 0;
  var xfCache = { rot: NaN, flip: null, scale: NaN, cx: NaN, cy: NaN, t: null };

  var D2R = Math.PI / 180, R2D = 180 / Math.PI;
  var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  var ACCENT = '#4fc3f7';
  // Targets are coloured by OBJECT TYPE (round-5 review), not orbit class: "is it
  // debris or a payload" is the first identification question. The palette lives in
  // SAT.state.typeColorOf — user-editable (round 6) and shared with the all-sky
  // view and the table's chips, so one override applies everywhere at once.
  function typeColorOf(cr) {
    try { return SAT.state.typeColorOf(cr && cr.type); }
    catch (e) { return '#90a4ae'; }        // stub states in tests may lack the helper
  }

  // Grid / scale-bar steps, degrees. Runs 90° down to 1″ so the same table serves a
  // whole-sky view and a 30″ field.
  var NICE_DEG = [
    90, 60, 30, 20, 10, 5, 2, 1,
    30 / 60, 20 / 60, 10 / 60, 5 / 60, 2 / 60, 1 / 60,
    30 / 3600, 20 / 3600, 10 / 3600, 5 / 3600, 2 / 3600, 1 / 3600,
  ];

  function cfg() {
    var s = SAT.state.settings;
    if (!s.chart) s.chart = {};
    var c = s.chart;
    if (c.stars == null) c.stars = true;
    if (c.starTrails == null) c.starTrails = true;   // round 23: parked mount only
    if (c.starNames == null) c.starNames = false;
    if (c.constLines == null) c.constLines = true;
    if (c.constNames == null) c.constNames = false;
    if (c.sunMoon == null) c.sunMoon = true;
    // round 20: chart.mw retired — the Milky Way layer lives in All-Sky only;
    // a stored chart.mw is simply never read again.
    if (c.magAuto == null) c.magAuto = true;    // round 14: depth follows the field
    if (c.magLimit == null) c.magLimit = 9.0;   // the pinned MANUAL limit
    if (c.grid == null) c.grid = true;
    if (c.labels == null) c.labels = true;
    if (c.tracks == null) c.tracks = true;      // round 20: off = markers+labels only
    if (c.ticks == null) c.ticks = true;        // round 22: UTC time ticks on trails
    if (c.legend == null) c.legend = true;      // round 22: type-colour key
    if (c.timeline == null) c.timeline = true;  // round 22: scan-window strip
    if (c.padFrac == null) c.padFrac = 0.7;
    return c;
  }

  function hexA(hex, a) {
    var h = (hex || ACCENT).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) n = 0x4fc3f7;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // ---- orientation and view transform (pure; unit-tested in tools/test_chart.js) --

  /** Bundle the display-only parameters into one immutable transform.
   *
   *  Kept pure and argument-fed so the orientation maths can be tested under node
   *  with no DOM — see tools/test_chart.js. Nothing here reads SAT.state. */
  function makeTransform(rotDeg, flipEW, scale, cx, cy) {
    var r = (rotDeg || 0) * D2R;
    return {
      cosRot: Math.cos(r), sinRot: Math.sin(r), flip: !!flipEW,
      scale: scale, cx: cx, cy: cy,
    };
  }

  /** Standard coordinates (xi east, eta north, DEGREES) -> screen pixels.
   *
   *  Convention: SKY VIEW — north up, EAST LEFT when flipEW is false. That is the
   *  orientation of a direct astronomical image (and of every FITS viewer's default),
   *  because we are looking outwards at the sphere rather than down onto a map;
   *  `flipEW` then represents an optical train with an odd number of reflections,
   *  which is exactly how the field is described in state.js. Consequences, with
   *  rotDeg = 0 and flipEW = false: a star 0.5° north of centre is at NEGATIVE screen
   *  y, and one 0.5° east is at NEGATIVE screen x.
   *
   *  rotDeg is the position angle (north through east) of chart +Y, so a point at
   *  position angle PA sits at angle (PA - rotDeg) from screen-up, measured in the
   *  same north-through-east sense — which on an east-left chart is counter-clockwise.
   *  The E/W flip is applied last and mirrors x only. */
  function skyToScreen(xi, eta, t) {
    var u = xi * t.cosRot - eta * t.sinRot;      // "chart east" component
    var v = eta * t.cosRot + xi * t.sinRot;      // "chart north" component
    return {
      x: t.cx + (t.flip ? u : -u) * t.scale,
      y: t.cy - v * t.scale,
    };
  }

  /** Exact inverse of skyToScreen. */
  function screenToSky(x, y, t) {
    var u = ((x - t.cx) / t.scale) * (t.flip ? 1 : -1);
    var v = -(y - t.cy) / t.scale;
    return {
      xi: u * t.cosRot + v * t.sinRot,
      eta: -u * t.sinRot + v * t.cosRot,
    };
  }

  /** Screen direction (unit vector) of increasing eta (north) and xi (east).
   *  This is what the compass rosette draws — the whole point of the rosette is that
   *  it is derived from the same transform the sky is, not from a stored guess. */
  function axisDirs(t) {
    // skyToScreen of the unit sky basis with the translation and scale stripped out,
    // so these stay exactly the directions the chart is actually drawn in
    var zero = { cosRot: t.cosRot, sinRot: t.sinRot, flip: t.flip, scale: 1, cx: 0, cy: 0 };
    return {
      n: skyToScreen(0, 1, zero),
      e: skyToScreen(1, 0, zero),
    };
  }

  /** Largest nice step that still gives at least `divs` divisions across `spanDeg`. */
  function gridStepDeg(spanDeg, divs) {
    var want = divs || 4;
    for (var i = 0; i < NICE_DEG.length; i++) {
      if (spanDeg / NICE_DEG[i] >= want) return NICE_DEG[i];
    }
    return NICE_DEG[NICE_DEG.length - 1];
  }

  /** Largest nice step not exceeding v — for the scale bar. */
  function niceAtMost(v) {
    for (var i = 0; i < NICE_DEG.length; i++) if (NICE_DEG[i] <= v) return NICE_DEG[i];
    return NICE_DEG[NICE_DEG.length - 1];
  }

  // ---- pointing ------------------------------------------------------------

  /** The tangent point at `date`, J2000.
   *
   *  In alt/az mode this is recomputed from az/el every frame, so a parked mount's
   *  field visibly drifts across the star background as the clock runs — which is
   *  the entire reason someone would choose alt/az here (drift scans, meteor cameras,
   *  a fixed all-sky lens). Returns null when alt/az is asked for without a site,
   *  because there is then no answer to give. */
  function tangentPoint(date) {
    var o = SAT.state.obs;
    if (o.mode === 'altaz') {
      var loc = SAT.state.activeLocation();
      if (!loc) return null;
      try {
        // kind-dispatching: LVLH on an orbit site, refracted alt/az on the ground
        return SAT.prop.siteAltAzToRaDec(loc, o.azDeg, o.elDeg, date,
          { refract: true, dut1S: o.dut1S });
      } catch (e) { return null; }
    }
    return { raDeg: o.raDeg, decDeg: o.decDeg };
  }

  /** Radius of a circular field on the tangent plane, in "tangent degrees".
   *  The scan's circular field is a true angular radius R, and the gnomonic
   *  projection puts that at tan(R), not R: 30 deg lands at 33.1. Drawing the
   *  outline at R (rounds 1-21) left a ring of in-field trails outside it on any
   *  wide field. (A rectangular field is DEFINED on the tangent plane, in the
   *  scan as here, so its half-sizes need no such correction.) Pure; unit-tested. */
  function circTanDeg(rDeg) {
    return Math.tan(Math.min(85, Math.max(0, rDeg)) * D2R) * R2D;
  }

  /** Fit scale in px/deg: the FOV occupies padFrac of the binding viewport axis. */
  function fitScale() {
    var o = SAT.state.obs, c = cfg();
    var pad = SAT.util.clamp(c.padFrac || 0.7, 0.2, 0.98);
    if (o.fovShape === 'circ') {
      return pad * Math.min(cssW, cssH) / Math.max(1e-6, 2 * circTanDeg(o.fovRDeg));
    }
    return pad * Math.min(cssW / Math.max(1e-6, o.fovWDeg),
      cssH / Math.max(1e-6, o.fovHDeg));
  }

  /** The display transform at the clock time. The rotation is the DETECTOR's at
   *  that instant (frameRef, set by buildFrames) — equal to obs.rotDeg except on a
   *  parked mount that has turned against the sky since the scan started. */
  function transform() {
    var o = SAT.state.obs;
    return makeTransform(frameRef ? frameRef.rotDeg : o.rotDeg, o.flipEW, fitScale() * view.zoom,
      cssW / 2 + view.panX, cssH / 2 + view.panY);
  }

  /** Transform for a frame, memoised on its rotation: a parked mount asks for this
   *  once per drawn sample and the answer changes only when the frame does. */
  function xf(fr) {
    var o = SAT.state.obs;
    var c = xfCache;
    if (c.t && c.rot === fr.rotDeg && c.flip === o.flipEW && c.scale === curScale
        && c.cx === curCx && c.cy === curCy) {
      return c.t;
    }
    c.rot = fr.rotDeg; c.flip = o.flipEW; c.scale = curScale; c.cx = curCx; c.cy = curCy;
    c.t = makeTransform(fr.rotDeg, o.flipEW, curScale, curCx, curCy);
    return c.t;
  }

  /** Radius in degrees of the circle enclosing the viewport — the star cone radius. */
  function viewRadiusDeg(t) {
    return 0.5 * Math.hypot(cssW, cssH) / Math.max(1e-9, t.scale);
  }

  // ---- the detector frame as a function of time ----------------------------

  /** Shortest-way angular interpolation, degrees. A frame table that crosses 0h RA
   *  would otherwise sweep the long way round for exactly one knot interval. */
  function lerpAngle(a, b, f) {
    var d = ((b - a + 540) % 360) - 180;
    return a + d * f;
  }

  function lerpFrame(a, b, f) {
    return {
      raDeg: ((lerpAngle(a.raDeg, b.raDeg, f) % 360) + 360) % 360,
      decDeg: a.decDeg + (b.decDeg - a.decDeg) * f,
      rotDeg: lerpAngle(a.rotDeg, b.rotDeg, f),
    };
  }

  /** Position angle of the mount's +altitude direction at a parked az/el.
   *
   *  This is what makes a parked field ROTATE as well as drift: chart +Y is fixed to
   *  the mount, so its position angle on the sky walks with the parallactic angle.
   *  Measured numerically off a 0.01 deg probe rather than from the closed-form
   *  parallactic angle, so it inherits whatever refraction setting the pointing uses
   *  instead of quietly disagreeing with it. */
  function verticalPA(azDeg, elDeg, loc, date, opts, tp) {
    var up = SAT.prop.siteAltAzToRaDec(loc, azDeg, Math.min(89.99, elDeg + 0.01), date, opts);
    if (!up) throw new Error('unresolvable site');   // caught by buildFrames -> fixed frame
    return SAT.frames.posAngle(tp.raDeg, tp.decDeg, up.raDeg, up.decDeg);
  }

  /** What a PARKED mount is actually pointed at: an alt/az pair (LVLH angles on an
   *  orbit site), or null when the field tracks the sky.
   *
   *  Alt/az pointing: the pair the user typed. RA/Dec pointing with the mount
   *  parked: the scan converted that RA/Dec to alt/az ONCE, at its start, and held
   *  it — so while a current scan exists the chart holds the very same pair
   *  (round 22). Re-deriving it from the RA/Dec at every clock time, as before,
   *  re-aimed the "parked" mount whenever the clock moved, and the field the chart
   *  showed at any instant but the scan start was not the field the scan had
   *  searched. */
  function parkedAzEl(now, loc) {
    var o = SAT.state.obs;
    if (o.track !== 'mount' || !loc) return null;
    if (o.mode === 'altaz') return { azDeg: o.azDeg, elDeg: o.elDeg, refMs: scanRefMs(now) };
    var sc = SAT.state.scan, pp = sc && !sc.stale && sc.params && sc.params.pointing;
    if (pp && pp.track === 'mount' && isFinite(pp.azDeg) && isFinite(pp.elDeg)) {
      return { azDeg: pp.azDeg, elDeg: pp.elDeg, refMs: sc.params.t0Ms };
    }
    var aa = SAT.prop.siteRaDecToAltAz(loc, o.raDeg, o.decDeg, now,
      { refract: true, dut1S: o.dut1S });
    return aa ? { azDeg: aa.azDeg, elDeg: aa.elDeg, refMs: now.getTime() } : null;
  }

  /** The instant at which obs.rotDeg is the detector's position angle: the start
   *  of the current scan, where the worker reads it (scan-worker fieldSetup), or
   *  the clock time when there is no current scan. */
  function scanRefMs(now) {
    var sc = SAT.state.scan;
    return (sc && !sc.stale && sc.params && sc.params.t0Ms != null)
      ? sc.params.t0Ms : now.getTime();
  }

  /** Build the frame table covering [t0, t1] around the clock time.
   *
   * Tracking sidereally there is nothing to build — one constant frame. Parked, we
   * sample the drift every ~15 s and interpolate, because altAzToRaDec runs the full
   * nutation series and calling it per path sample per crossing per animation frame
   * is thousands of evaluations a second for a drift that is smooth to well under a
   * pixel between knots.
   *
   * The detector is carried RIGIDLY with the mount: its position angle at time t is
   * obs.rotDeg plus however far the mount's own "up" has turned against celestial
   * north since the reference instant. On the ground that turn is zero (a fixed
   * alt/az has a fixed parallactic angle); in LVLH it is a full turn per orbit. */
  function buildFrames(nowMs, t0Ms, t1Ms) {
    var o = SAT.state.obs;
    var now = new Date(nowMs);
    var loc = SAT.state.activeLocation();
    var opts = { refract: true, dut1S: o.dut1S };
    frameKnots = null;
    mountFrameOf = null;

    var park = null;
    try { park = parkedAzEl(now, loc); } catch (e) { park = null; }
    if (!park) {
      var base = tangentPoint(now);
      if (!base) { frameRef = null; return null; }
      frameRef = { raDeg: base.raDeg, decDeg: base.decDeg, rotDeg: o.rotDeg };
      return frameRef;
    }

    try {
      var ref = new Date(park.refMs);
      var tpRef = SAT.prop.siteAltAzToRaDec(loc, park.azDeg, park.elDeg, ref, opts);
      if (!tpRef) throw new Error('unresolvable site');
      var pa0 = verticalPA(park.azDeg, park.elDeg, loc, ref, opts, tpRef);
      var frameOf = function (d) {
        var tp = SAT.prop.siteAltAzToRaDec(loc, park.azDeg, park.elDeg, d, opts);
        if (!tp) throw new Error('unresolvable site');
        var pa = verticalPA(park.azDeg, park.elDeg, loc, d, opts, tp);
        return { raDeg: tp.raDeg, decDeg: tp.decDeg, rotDeg: o.rotDeg + (pa - pa0) };
      };
      frameRef = frameOf(now);
      mountFrameOf = frameOf;
      if (t1Ms > t0Ms) {
        var n = SAT.util.clamp(Math.ceil((t1Ms - t0Ms) / 15000) + 1, 2, 128);
        var dt = (t1Ms - t0Ms) / (n - 1);
        var f = [];
        for (var i = 0; i < n; i++) f.push(frameOf(new Date(t0Ms + dt * i)));
        frameKnots = { t0: t0Ms, dt: dt, n: n, f: f };
      }
    } catch (e) {
      // a bad site or epoch degrades to a fixed frame at the nominal pointing
      frameKnots = null;
      mountFrameOf = null;
      var b2 = tangentPoint(now);
      if (!b2) { frameRef = null; return null; }
      frameRef = { raDeg: b2.raDeg, decDeg: b2.decDeg, rotDeg: o.rotDeg };
    }
    return frameRef;
  }

  /** The detector frame at tMs. Constant when tracking the sky. */
  function frameAt(tMs) {
    var k = frameKnots;
    if (!k) return frameRef;
    var u = (tMs - k.t0) / k.dt;
    if (!(u > 0)) return k.f[0];
    if (u >= k.n - 1) return k.f[k.n - 1];
    var i = Math.floor(u);
    return lerpFrame(k.f[i], k.f[i + 1], u - i);
  }

  /** Project a sky position into the detector frame that applies at tMs. */
  function projAt(raDeg, decDeg, tMs) {
    var fr = frameAt(tMs);
    if (!fr) return null;
    return proj(raDeg, decDeg, fr.raDeg, fr.decDeg, xf(fr));
  }

  // ---- view manipulation ---------------------------------------------------

  function clampZoom(z) { return SAT.util.clamp(z, 0.2, 20); }

  /** Zoom keeping the sky point under (mx,my) pinned to the cursor. The transform is
   *  linear about (cx,cy), so the fixed point falls out algebraically. */
  function zoomAt(mx, my, factor) {
    var z0 = view.zoom, z1 = clampZoom(z0 * factor);
    if (z1 === z0) return;
    var cx0 = cssW / 2 + view.panX, cy0 = cssH / 2 + view.panY;
    var k = z1 / z0;
    view.zoom = z1;
    view.panX = (mx - k * (mx - cx0)) - cssW / 2;
    view.panY = (my - k * (my - cy0)) - cssH / 2;
    requestRender();
  }

  function fitView() {
    view.zoom = 1; view.panX = 0; view.panY = 0;
    requestRender();
  }

  // ---- star layer ----------------------------------------------------------
  // Round 12: the deep catalogue is REAFFIRMED as this chart's star background —
  // round 11 briefly made it bright-only on a misread instruction; the SatObserver
  // bright-only fallback belongs to the All-Sky panel. See CONTRACT
  // "Chart star background".
  // Round 14: the depth is adaptive by default (settings.chart.magAuto).
  // autoMagLimit() is the law; ensureStars() decides which catalogue can serve it.

  // Round 24 — "more stars on wider fields". The depth law now holds the NUMBER
  // of stars on screen roughly constant (~4 000 on an average sky) instead of
  // shedding it: the sky has ~10^(0.45 m) stars per square degree brighter than
  // m, the view covers ~D^2 square degrees, so constant count means the limit
  // falls 5*log10(D) — the same slope as rounds 14-23, anchored 4.6 MAGNITUDES
  // deeper (a 12 deg view draws to V 12.1 where it drew to 7.5). Measured on
  // the drawing side first: the whole layer cost 0.2-0.4 ms a frame for the
  // 60-420 stars the old law allowed, so the count was never a rendering limit;
  // 5 000 stars cost under 4 ms.
  var AUTO_FULL_DEPTH_DEG = 8;     // views up to this wide get the tiles' full V 13
  var AUTO_FLOOR_MAG = 6.5;        // reached at ~160 deg: the naked-eye sky
  // Deep tiles serve views up to this wide (was 3 deg). The law crosses the
  // bundled catalogue's V 10.5 at 25.3 deg, so past this the tiles are not
  // needed — and a wider cone would pull in hundreds of them.
  var DEEP_MAX_VIEW_DEG = 26;
  // However deep the request, at most this many stars are kept — the brightest
  // (about 40% of them land inside the window). In the Milky Way an 8 deg view
  // holds 40 000 stars to V 13; the budget keeps the frame time flat there, and
  // the drawn depth is reported as what it is.
  var STAR_BUDGET = 12000;

  /** The auto-mode star depth for a view `fieldDeg` degrees across (the
   *  enclosing-circle diameter of the WINDOW, not of the field frame). Pure;
   *  unit-tested in tools/test_chart.js. 13 (the deep tiles' depth) up to 8 deg,
   *  then 13 - 5*log10(D/8): 12.1 at 12 deg, 11.0 at 20, 10.1 at 30, 8.6 at 60,
   *  7.7 at 90, floor 6.5 from ~160 deg. Quantised to 0.1 mag so wheel-zoom
   *  ticks don't re-query per frame. */
  function autoMagLimit(fieldDeg) {
    if (!(fieldDeg > 0)) return 10.5;
    if (fieldDeg <= AUTO_FULL_DEPTH_DEG) return 13;
    var m = 13 - 5 * Math.log(fieldDeg / AUTO_FULL_DEPTH_DEG) / Math.LN10;
    return Math.round(Math.max(AUTO_FLOOR_MAG, Math.min(13, m)) * 10) / 10;
  }

  /** Keep the brightest `budget` stars. Returns the magnitude of the faintest
   *  one kept (the depth actually drawn), or null when nothing was cut.
   *  Sorts `stars` in place only when it has to. Pure; unit-tested. */
  function applyStarBudget(stars, budget) {
    if (stars.length <= budget) return null;
    stars.sort(function (u, v) { return u.mag - v.mag; });
    stars.length = budget;
    return stars[budget - 1].mag;
  }

  /** Magnitude -> dot {rad, lum}, or null when the star is too faint to draw.
   *  Round 15, derived from Stellarium's StelSkyDrawer::computeRCMag and
   *  adapted to a fixed-tone canvas. `mlim` is the DRAWN depth — what the live
   *  catalogue actually delivered, not the wanted limit — so a deep request
   *  served by the shallow bundled catalogue does not render its faintest
   *  stars as if they were mid-range.
   *  - Exposure shift (Stellarium's FOV factor): deep fields render like a
   *    longer exposure — at an m17 limit an m17 star draws as m11 did at m11;
   *    limits <= 11 keep the round-9 look unchanged above the faint floor.
   *  - Flux-law radius (round 9): rr = 5.2 * 10^(-0.085 m), ~18%/mag.
   *  - Faint end (the round-15 fix): below 1 px the dot STOPS SHRINKING and
   *    fades instead — lum *= rr^3, Stellarium's cubic sub-floor falloff —
   *    and vanishes below lum 0.02 (its 0.3-radius cutoff). The old hard
   *    floors (0.7 px, alpha 0.42) turned the whole faint tail into identical
   *    pepper; a limit is a fade, not a cliff.
   *  - Bright end: radius past 6.5 px is sqrt-compressed (MAX_LINEAR_RADIUS
   *    device), so Alcyone over a deep Pleiades field is prominent, not a blob. */
  function starDot(mag, mlim) {
    var m = mag - Math.max(0, (mlim == null ? 11 : mlim) - 11);
    var rr = 5.2 * Math.pow(10, -0.085 * m);
    var lum = Math.max(0, Math.min(1, 1.04 - 0.058 * m));
    if (rr < 1) {
      lum *= rr * rr * rr;
      if (lum < 0.02) return null;
      rr = 1;
    } else if (rr > 6.5) {
      rr = 6.5 + Math.sqrt(1 + rr - 6.5) - 1;
    }
    return { rad: rr, lum: lum };
  }

  /** Fetch-completion callback for the deep field: the cached cone is stale the
   *  moment better stars exist (or the footer needs to say the load failed). */
  function onDeepField() { invalidateStars(); requestRender(); }

  /** Cone query with caching. Queries 1.2x wider than needed so the 10%-of-field
   *  reuse window below is always fully covered by the cached disc. */
  function ensureStars(ra0, dec0, radiusDeg, magLimit) {
    var c = starCache;
    if (!SAT.stars || typeof SAT.stars.cone !== 'function') {
      // stars.js absent or not loaded yet: an empty field, never a thrown render
      c.ok = false; c.stars = []; c.named = []; c.lines = []; c.cons = [];
      c.effMag = magLimit; c.drawnMag = magLimit;
      c.deepState = null; c.deepTrunc = false;
      return c;
    }
    var slack = 0.10 * radiusDeg;
    if (c.ok && c.magLimit === magLimit
        && Math.abs(radiusDeg - c.radiusDeg) <= slack
        && SAT.frames.sep(c.ra0, c.dec0, ra0, dec0) <= slack) {
      return c;
    }
    var q = radiusDeg * 1.2;
    var stars = [], named = [], lines = [], cons = [];
    var deepState = null, deepTrunc = false;
    var localLim = (typeof SAT.stars.localLimit === 'function')
      ? SAT.stars.localLimit() : Infinity;
    var df = null;
    if (magLimit > localLim + 0.01 && typeof SAT.stars.deepField === 'function') {
      if (2 * radiusDeg >= DEEP_MAX_VIEW_DEG) {
        // Deep tiles serve views narrower than DEEP_MAX_VIEW_DEG only (round
        // 17's gate, moved from 3 to 26 deg in round 24). A pinned deep limit
        // on a wider view draws the bundled catalogue: the cone would otherwise
        // pull hundreds of tiles through the LRU on every pan.
        deepState = 'wide';
      } else {
        // Wanted depth is beyond the bundled catalogue: ask the deep tile set.
        // While tiles load (or when the set is not built) the local cone below
        // still draws, so the chart never blanks — it deepens when tiles land.
        df = SAT.stars.deepField(ra0, dec0, q, magLimit, onDeepField);
        deepState = df.state;
        if (df.state === 'ready') {
          stars = df.stars || [];
          deepTrunc = !!df.truncated;
        }
      }
    }
    if (deepState !== 'ready') {
      try { stars = SAT.stars.cone(ra0, dec0, q, magLimit) || []; } catch (e) { stars = []; }
    }
    // What depth is actually on screen: the star-dot law keys its exposure
    // shift on this, so a deep request served shallow renders honestly —
    // including a tile set built to a lighter cut than the wanted limit.
    var drawnMag = (deepState === 'ready')
      ? Math.min(magLimit, (df && df.magLimit) || magLimit)
      : Math.min(magLimit, isFinite(localLim) ? localLim : magLimit);
    // the budget: a crowded field is cut to its brightest stars, and says so
    var cutMag = applyStarBudget(stars, STAR_BUDGET);
    if (cutMag != null) drawnMag = Math.min(drawnMag, cutMag);
    try {
      if (typeof SAT.stars.named === 'function') named = SAT.stars.named(ra0, dec0, q) || [];
    } catch (e) { named = []; }
    try {
      if (typeof SAT.stars.constellationLines === 'function') {
        lines = SAT.stars.constellationLines(ra0, dec0, q) || [];
      }
    } catch (e) { lines = []; }
    // constellation names straight from the bright catalogue (CN toggle, round 11)
    var sep = SAT.frames.sep;
    var cn = ((typeof SAT !== 'undefined' && SAT.stardata) || {}).cons || [];
    for (var i = 0; i < cn.length; i++) {
      var ra = ((cn[i][0] % 360) + 360) % 360;
      if (sep(ra0, dec0, ra, cn[i][1]) <= q) {
        cons.push({ raDeg: ra, decDeg: cn[i][1], name: cn[i][2] });
      }
    }
    c.ok = true; c.ra0 = ra0; c.dec0 = dec0;
    c.radiusDeg = radiusDeg; c.queryDeg = q; c.magLimit = magLimit;
    c.effMag = magLimit; c.drawnMag = drawnMag;
    c.deepState = deepState; c.deepTrunc = deepTrunc;
    c.stars = stars; c.named = named; c.lines = lines; c.cons = cons;
    return c;
  }

  function invalidateStars() { starCache.ok = false; }

  // ---- small drawing helpers ----------------------------------------------

  function haloText(text, x, y, fill, align, baseline) {
    ctx.textAlign = align || 'left';
    ctx.textBaseline = baseline || 'middle';
    ctx.strokeStyle = 'rgba(5,8,12,0.85)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  function onScreen(p, pad) {
    var m = pad == null ? 0 : pad;
    return p && p.x >= -m && p.x <= cssW + m && p.y >= -m && p.y <= cssH + m;
  }

  /** Project a sky position straight to pixels. Null when the point is over the
   *  tangent-plane horizon (>= 90° away), which tanProject reports as null. */
  function proj(raDeg, decDeg, ra0, dec0, t) {
    var s = SAT.frames.tanProject(raDeg, decDeg, ra0, dec0);
    if (!s) return null;
    return skyToScreen(s.xi, s.eta, t);
  }

  function fmtDecShort(d, stepDeg) {
    var sign = d < 0 ? '−' : '+', a = Math.abs(d);
    var dd = Math.floor(a + 1e-9);
    var mFull = (a - dd) * 60, mm = Math.floor(mFull + 1e-7);
    var ss = Math.round((mFull - mm) * 60);
    if (ss >= 60) { ss = 0; mm += 1; }
    if (stepDeg >= 1 - 1e-9) return sign + dd + '°';
    if (stepDeg >= 1 / 60 - 1e-12) return sign + dd + '°' + SAT.util.pad2(mm) + '′';
    return sign + dd + '°' + SAT.util.pad2(mm) + '′' + SAT.util.pad2(ss) + '″';
  }

  function fmtRaShort(raDeg, stepDeg) {
    var h = (((raDeg % 360) + 360) % 360) / 15;
    var hh = Math.floor(h + 1e-9);
    var mFull = (h - hh) * 60, mm = Math.floor(mFull + 1e-7);
    var ss = Math.round((mFull - mm) * 60);
    if (ss >= 60) { ss = 0; mm += 1; }
    if (mm >= 60) { mm = 0; hh = (hh + 1) % 24; }
    if (stepDeg >= 15) return hh + 'h';
    if (stepDeg >= 15 / 60) return hh + 'h' + SAT.util.pad2(mm) + 'm';
    return hh + 'h' + SAT.util.pad2(mm) + 'm' + SAT.util.pad2(ss) + 's';
  }

  // ---- text that must not collide -------------------------------------------

  /** Reserve a rectangle for a piece of text. Returns false (and reserves nothing)
   *  when it would overlap one already taken or leave the canvas. Everything
   *  written on the chart goes through this, in priority order, so a label is
   *  either readable or absent — never printed across another. */
  function claim(x0, y0, x1, y1, pad) {
    var p = pad == null ? 2 : pad;
    if (x0 < 1 || y0 < 1 || x1 > cssW - 1 || y1 > cssH - 1) return false;
    for (var i = 0; i < labelBoxes.length; i++) {
      var b = labelBoxes[i];
      if (x0 - p < b[2] && x1 + p > b[0] && y0 - p < b[3] && y1 + p > b[1]) return false;
    }
    labelBoxes.push([x0, y0, x1, y1]);
    return true;
  }

  /** Text set beside an anchor, on the side a direction points to: one of eight
   *  positions (E, NE, N, ...), the box's near edge — or near CORNER, on a
   *  diagonal — `gap` px from (ax, ay), so the text always touches what it names.
   *  Returns true when drawn. `force` draws regardless of collisions, on a dark
   *  plate, nudged back inside the canvas. */
  function textBeside(text, ax, ay, dx, dy, gap, fill, force) {
    var w = ctx.measureText(text).width, h = 12;
    var hx = Math.abs(dx) > 0.38 ? (dx > 0 ? 1 : -1) : 0;
    var hy = Math.abs(dy) > 0.38 ? (dy > 0 ? 1 : -1) : 0;
    if (!hx && !hy) hx = 1;
    // (the full gap on a diagonal too: any closer and the text would touch the
    // end of the very trail it names)
    var cx = ax + hx * (gap + w / 2), cy = ay + hy * (gap + h / 2);
    var ok = claim(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
    if (!ok && !force) return false;
    if (!ok) {
      cx = SAT.util.clamp(cx, w / 2 + 4, cssW - w / 2 - 4);
      cy = SAT.util.clamp(cy, h / 2 + 3, cssH - h / 2 - 3);
      labelBoxes.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]);
      ctx.fillStyle = 'rgba(8,11,15,0.82)';
      ctx.fillRect(cx - w / 2 - 3, cy - h / 2 - 1, w + 6, h + 2);
    }
    haloText(text, cx, cy, fill, 'center', 'middle');
    return true;
  }

  // ---- layers --------------------------------------------------------------

  /** The outline the grid labels hang on: the field frame when all of it is on
   *  screen with room outside for text, otherwise the viewport itself. */
  function labelBoundary(t) {
    var o = SAT.state.obs;
    var circ = o.fovShape === 'circ';
    var hw = (circ ? circTanDeg(o.fovRDeg) : o.fovWDeg / 2) * t.scale;
    var hh = (circ ? circTanDeg(o.fovRDeg) : o.fovHDeg / 2) * t.scale;
    var room = 34;
    var onFrame = t.cx - hw > room && t.cx + hw < cssW - room &&
      t.cy - hh > 18 && t.cy + hh < cssH - 18;
    if (onFrame && circ) {
      return {
        frame: true,
        inside: function (p) { return Math.hypot(p.x - t.cx, p.y - t.cy) <= hw; },
        normal: function (p) {
          var d = Math.hypot(p.x - t.cx, p.y - t.cy) || 1;
          return { x: (p.x - t.cx) / d, y: (p.y - t.cy) / d };
        },
      };
    }
    var x0 = onFrame ? t.cx - hw : 0, x1 = onFrame ? t.cx + hw : cssW;
    var y0 = onFrame ? t.cy - hh : 0, y1 = onFrame ? t.cy + hh : cssH;
    return {
      frame: onFrame,
      inside: function (p) { return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1; },
      normal: function (p) {
        var dl = Math.abs(p.x - x0), dr = Math.abs(p.x - x1);
        var dt = Math.abs(p.y - y0), db = Math.abs(p.y - y1);
        var m = Math.min(dl, dr, dt, db);
        if (m === dl) return { x: -1, y: 0 };
        if (m === dr) return { x: 1, y: 0 };
        if (m === dt) return { x: 0, y: -1 };
        return { x: 0, y: 1 };
      },
    };
  }

  /** Where a drawn grid line crosses the label boundary: every in/out transition,
   *  refined by bisection along the segment. */
  function boundaryCrossings(pts, B) {
    var out = [];
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      if (!a || !b) continue;
      var ia = B.inside(a), ib = B.inside(b);
      if (ia === ib) continue;
      var lo = ia ? a : b, hi = ia ? b : a;           // lo inside, hi outside
      for (var k = 0; k < 12; k++) {
        var m = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 };
        if (B.inside(m)) lo = m; else hi = m;
      }
      out.push(lo);
    }
    return out;
  }

  function drawGrid(ra0, dec0, t) {
    var fr = viewRadiusDeg(t);
    var stepDec = gridStepDeg(2 * fr, 4);
    // RA lines are spaced so their on-sky separation matches the dec spacing; near
    // the pole that means far fewer meridians, which is what keeps a polar field
    // from turning into a solid fan of lines.
    var cosd = Math.max(0.02, Math.cos(dec0 * D2R));
    var stepRa = gridStepDeg(2 * fr / cosd, 4);
    var decMin = Math.max(-90, dec0 - fr), decMax = Math.min(90, dec0 + fr);
    var raHalf = Math.min(180, fr / cosd + stepRa);
    var i, j, pts;
    var lines = [];                               // [{pts, text, dec:bool}]

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(232,234,237,0.10)';

    function stroke(points) {
      var prev = null;
      ctx.beginPath();
      for (var q = 0; q < points.length; q++) {
        var s = points[q];
        if (!s) { prev = null; continue; }
        if (prev) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y);
        prev = s;
      }
      ctx.stroke();
    }
    function sane(s) {
      return (s && isFinite(s.x) && Math.abs(s.x) < 1e5 && Math.abs(s.y) < 1e5) ? s : null;
    }

    // parallels of declination
    var d0 = Math.ceil(decMin / stepDec - 1e-9) * stepDec;
    for (var d = d0; d <= decMax + 1e-9; d += stepDec) {
      pts = [];
      for (i = 0; i <= 96; i++) {
        pts.push(sane(proj(ra0 - raHalf + (2 * raHalf) * i / 96, d, ra0, dec0, t)));
      }
      stroke(pts);
      lines.push({ pts: pts, text: fmtDecShort(Math.abs(d) < 1e-9 ? 0 : d, stepDec), dec: true });
    }

    // meridians of right ascension
    var r0 = Math.ceil((ra0 - raHalf) / stepRa - 1e-9) * stepRa;
    for (var r = r0; r <= ra0 + raHalf + 1e-9; r += stepRa) {
      pts = [];
      for (j = 0; j <= 64; j++) {
        pts.push(sane(proj(r, decMin + (decMax - decMin) * j / 64, ra0, dec0, t)));
      }
      stroke(pts);
      lines.push({ pts: pts, text: fmtRaShort(r, stepRa), dec: false });
    }

    return lines;
  }

  /** Grid labels: where each line leaves the frame, just outside it (inside, when
   *  the boundary is the viewport). Placed LAST, after the satellites have had
   *  their pick of the space; one per line, and a collision is simply skipped. */
  function drawGridLabels(lines, t) {
    var B = labelBoundary(t);
    ctx.font = '10px ' + MONO;
    var col = 'rgba(154,170,186,0.9)';
    for (var i = 0; i < lines.length; i++) {
      var xs = boundaryCrossings(lines[i].pts, B);
      for (var j = 0; j < xs.length; j++) {
        var p = xs[j], nrm = B.normal(p), sgn = B.frame ? 1 : -1;
        if (textBeside(lines[i].text, p.x, p.y, nrm.x * sgn, nrm.y * sgn, 5, col, false)) break;
      }
    }
  }

  var STAR_TRAIL_MAX = 1500;

  /** The interval over which stars trail on a parked mount: the current scan's
   *  window, or — with no current scan — from the clock for obs.spanMin. */
  function trailWindow() {
    var sc = SAT.state.scan, pr = sc && !sc.stale && sc.params;
    if (pr && pr.t0Ms != null && pr.spanMin > 0) {
      return { t0: pr.t0Ms, t1: pr.t0Ms + pr.spanMin * 60000 };
    }
    var now = (SAT.clock ? SAT.clock.getDate() : new Date()).getTime();
    var span = (SAT.state.obs.spanMin || 0) * 60000;
    return span > 0 ? { t0: now, t1: now + span } : null;
  }

  /** The drawn star nearest (x, y), within `maxPx`, or null. For the hover
   *  readout: a star's magnitude is how one judges a frame's depth. */
  function starAt(x, y, maxPx) {
    var best = null, bd = maxPx;
    for (var i = 0; i < starPts.length; i++) {
      var d = Math.hypot(starPts[i].x - x, starPts[i].y - y);
      if (d <= bd) { bd = d; best = starPts[i]; }
    }
    if (!best) return null;
    // a proper name, when the bright catalogue has one at this position
    var nm = starCache.named || [], name = null;
    for (var k = 0; k < nm.length && best.mag <= 3.5; k++) {
      if (SAT.frames.sep(best.raDeg, best.decDeg, nm[k].raDeg, nm[k].decDeg) < 0.03) { name = nm[k].name; break; }
    }
    return { mag: best.mag, raDeg: best.raDeg, decDeg: best.decDeg, name: name };
  }

  function drawStars(ra0, dec0, t) {
    var c = cfg();
    if (!c.stars && !c.constLines && !c.starNames && !c.constNames) return;
    var fr = viewRadiusDeg(t);
    var eff = c.magAuto ? autoMagLimit(2 * fr) : c.magLimit;
    var cache = ensureStars(ra0, dec0, fr, eff);
    var spanDeg = cssW / Math.max(1e-9, t.scale);
    var i, j, p, prev, st;

    // Constellation lines and names only make sense once the field is wide enough to
    // contain a recognisable figure; below ~5° they are a couple of stray strokes.
    if (c.constLines && spanDeg > 5 && cache.lines.length) {
      ctx.strokeStyle = 'rgba(110,150,215,0.28)';
      ctx.lineWidth = 1;
      for (i = 0; i < cache.lines.length; i++) {
        var seg = cache.lines[i];
        prev = null;
        ctx.beginPath();
        for (j = 0; j < seg.length; j++) {
          p = proj(seg[j].raDeg, seg[j].decDeg, ra0, dec0, t);
          if (!p) { prev = null; continue; }
          if (prev) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
          prev = p;
        }
        ctx.stroke();
      }
    }

    starPts = [];
    if (c.stars && cache.stars.length) {
      // Round 15: dot size/brightness through starDot() — the Stellarium-derived
      // law (see its comment). Keyed on the DRAWN depth, not the wanted one.
      var mlim = cache.drawnMag != null ? cache.drawnMag : 11;
      var dots = [];
      for (i = 0; i < cache.stars.length; i++) {
        st = cache.stars[i];
        var dot = starDot(st.mag, mlim);
        if (!dot) continue;                  // faded out below the cutoff
        p = proj(st.raDeg, st.decDeg, ra0, dec0, t);
        if (!p) continue;
        dots.push({ x: p.x, y: p.y, rad: dot.rad, lum: dot.lum, st: st });
      }

      // STAR TRAILS (round 23). On a parked mount the sky turns under the
      // detector, so over the exposure every star draws a streak — and that
      // streak pattern, not a field of dots, is what the frame shows. Each star
      // is carried through the detector frames of the window (the current scan's,
      // else clock .. clock + span); the dot stays at the clock time.
      var tw = (c.starTrails && mountFrameOf) ? trailWindow() : null;
      if (tw) {
        var nS = SAT.util.clamp(Math.ceil((tw.t1 - tw.t0) / 120000) + 1, 2, 13);
        var frs = [];
        try {
          for (j = 0; j < nS; j++) frs.push(mountFrameOf(new Date(tw.t0 + (tw.t1 - tw.t0) * j / (nS - 1))));
        } catch (e) { frs = []; }
        // the brightest STAR_TRAIL_MAX only: a streak per 13th-magnitude star is fog
        var order = dots;
        if (dots.length > STAR_TRAIL_MAX) {
          order = dots.slice().sort(function (u, v) { return u.st.mag - v.st.mag; }).slice(0, STAR_TRAIL_MAX);
        }
        ctx.lineCap = 'round';
        for (i = 0; frs.length === nS && i < order.length; i++) {
          var d = order[i], pts = [], len = 0, vis = false;
          for (j = 0; j < nS; j++) {
            var q = proj(d.st.raDeg, d.st.decDeg, frs[j].raDeg, frs[j].decDeg, xf(frs[j]));
            if (!q || !isFinite(q.x) || Math.abs(q.x) > 1e5 || Math.abs(q.y) > 1e5) { pts = null; break; }
            if (j) len += Math.hypot(q.x - pts[j - 1].x, q.y - pts[j - 1].y);
            if (onScreen(q, 0)) vis = true;
            pts.push(q);
          }
          if (!pts || len < 2 || (!vis && !onScreen(d, 0))) continue;
          // a long window gives faint context streaks, a short exposure crisp ones
          var fade = SAT.util.clamp(90 / len, 0.3, 1);
          ctx.strokeStyle = 'rgba(225,235,255,' + (d.lum * 0.5 * fade).toFixed(3) + ')';
          ctx.lineWidth = SAT.util.clamp(d.rad * 1.1, 1, 3.5);
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (j = 1; j < nS; j++) ctx.lineTo(pts[j].x, pts[j].y);
          ctx.stroke();
        }
      }

      for (i = 0; i < dots.length; i++) {
        var o2 = dots[i];
        if (!onScreen(o2, 4)) continue;
        // a soft halo under the bright ones: a disc with a hard edge reads as a
        // marker, a star in an image has a skirt
        if (o2.rad >= 2.6 && ctx.createRadialGradient) {
          var g = ctx.createRadialGradient(o2.x, o2.y, o2.rad * 0.7, o2.x, o2.y, o2.rad * 2.7);
          g.addColorStop(0, 'rgba(200,220,255,' + (0.30 * o2.lum).toFixed(3) + ')');
          g.addColorStop(1, 'rgba(200,220,255,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(o2.x, o2.y, o2.rad * 2.7, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(o2.x, o2.y, o2.rad, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(225,235,255,' + o2.lum.toFixed(3) + ')';
        ctx.fill();
        starPts.push({ x: o2.x, y: o2.y, mag: o2.st.mag, raDeg: o2.st.raDeg, decDeg: o2.st.decDeg });
      }
    }

    if (c.starNames && spanDeg > 5 && cache.named.length) {
      ctx.font = '9px ' + MONO;
      for (i = 0; i < cache.named.length; i++) {
        var nm = cache.named[i];
        p = proj(nm.raDeg, nm.decDeg, ra0, dec0, t);
        if (!onScreen(p, 0)) continue;
        haloText(nm.name, p.x + 5, p.y - 4, 'rgba(185,205,240,0.9)');
      }
    }

    if (c.constNames && spanDeg > 5 && cache.cons.length) {
      ctx.font = 'italic 10px ' + MONO;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (i = 0; i < cache.cons.length; i++) {
        var cn = cache.cons[i];
        p = proj(cn.raDeg, cn.decDeg, ra0, dec0, t);
        if (!onScreen(p, 0)) continue;
        ctx.fillStyle = 'rgba(140,165,205,0.55)';
        ctx.fillText(cn.name, p.x, p.y);
      }
      ctx.textAlign = 'left';
    }
  }


  function drawFov(t) {
    var o = SAT.state.obs;
    var cx = t.cx, cy = t.cy;
    var circ = o.fovShape === 'circ';
    var hw = (circ ? circTanDeg(o.fovRDeg) : o.fovWDeg / 2) * t.scale;
    var hh = (circ ? circTanDeg(o.fovRDeg) : o.fovHDeg / 2) * t.scale;

    // Everything outside the field is context, and is dimmed so the frame reads as
    // the image. even-odd fill so the hole matches the outline exactly; drawn
    // before the satellites so those stay at full brightness.
    ctx.beginPath();
    ctx.rect(0, 0, cssW, cssH);
    if (circ) { ctx.moveTo(cx + hw, cy); ctx.arc(cx, cy, hw, 0, Math.PI * 2); }
    else { ctx.rect(cx - hw, cy - hh, 2 * hw, 2 * hh); }
    ctx.fillStyle = 'rgba(4,7,10,0.46)';
    ctx.fill('evenodd');

    ctx.strokeStyle = hexA(ACCENT, 0.85);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (circ) ctx.arc(cx, cy, hw, 0, Math.PI * 2);
    else ctx.rect(cx - hw, cy - hh, 2 * hw, 2 * hh);
    ctx.stroke();

    if (!circ) {
      // corner brackets: the frame's corners stay findable under a dense field
      var L = Math.max(6, Math.min(14, hw * 0.12, hh * 0.12));
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = ACCENT;
      ctx.beginPath();
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (s) {
        var x = cx + s[0] * hw, y = cy + s[1] * hh;
        ctx.moveTo(x - s[0] * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y - s[1] * L);
      });
      ctx.stroke();
    }

    // centre cross — the pointing itself
    ctx.strokeStyle = hexA(ACCENT, 0.55);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 7, cy); ctx.lineTo(cx - 2, cy); ctx.moveTo(cx + 2, cy); ctx.lineTo(cx + 7, cy);
    ctx.moveTo(cx, cy - 7); ctx.lineTo(cx, cy - 2); ctx.moveTo(cx, cy + 2); ctx.lineTo(cx, cy + 7);
    ctx.stroke();

    // the field's angular size — the number people actually check — claimed
    // FIRST, so grid labels and satellite names give way to it
    ctx.font = '10px ' + MONO;
    var txt = circ ? 'r ' + SAT.util.fmtAngle(o.fovRDeg, 2)
      : SAT.util.fmtAngle(o.fovWDeg, 2) + ' × ' + SAT.util.fmtAngle(o.fovHDeg, 2);
    var w = ctx.measureText(txt).width;
    var lx = circ ? cx : cx + hw - w / 2, ly = cy + hh + 11;
    if (claim(lx - w / 2, ly - 6, lx + w / 2, ly + 6)) haloText(txt, lx, ly, ACCENT, 'center', 'middle');
  }

  function drawCompass(t) {
    // Always visible, and always derived from the live transform: this rosette is how
    // the user confirms the chart matches the frame on their screen. Getting the
    // orientation wrong and not noticing is the classic way to misidentify a trail.
    var ox = cssW - 40, oy = cssH - 40, L = 20;
    var dirs = axisDirs(t);
    ctx.font = '10px ' + MONO;

    ctx.beginPath();
    ctx.arc(ox, oy, L + 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,14,18,0.62)';
    ctx.fill();

    function arrow(dx, dy, label, col) {
      var tx = ox + dx * L, ty = oy + dy * L;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(tx, ty);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      // arrowhead
      var a = Math.atan2(dy, dx);
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - 5 * Math.cos(a - 0.4), ty - 5 * Math.sin(a - 0.4));
      ctx.lineTo(tx - 5 * Math.cos(a + 0.4), ty - 5 * Math.sin(a + 0.4));
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      haloText(label, ox + dx * (L + 7), oy + dy * (L + 7), col, 'center');
    }
    arrow(dirs.n.x, dirs.n.y, 'N', '#e8eaed');
    arrow(dirs.e.x, dirs.e.y, 'E', ACCENT);
  }

  function drawScaleBar(t) {
    var targetPx = Math.max(40, cssW * 0.18);
    var deg = niceAtMost(targetPx / Math.max(1e-9, t.scale));
    var px = deg * t.scale;
    var x0 = 12, y0 = cssH - 22;
    ctx.strokeStyle = 'rgba(232,234,237,0.75)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x0 + px, y0);
    ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0 + 4);
    ctx.moveTo(x0 + px, y0 - 4); ctx.lineTo(x0 + px, y0 + 4);
    ctx.stroke();
    ctx.font = '10px ' + MONO;
    haloText(SAT.util.fmtAngle(deg, deg >= 1 ? 0 : 1), x0 + px / 2, y0 - 10,
      'rgba(232,234,237,0.9)', 'center');
  }

  // ---- crossings -----------------------------------------------------------

  /** Interpolate a path sample at tMs, or null when tMs is outside the crossing. */
  function pathPosAt(path, tMs) {
    if (!path || path.length < 2) return null;
    if (tMs < path[0].t || tMs > path[path.length - 1].t) return null;
    for (var i = 1; i < path.length; i++) {
      if (tMs <= path[i].t) {
        var a = path[i - 1], b = path[i];
        var span = b.t - a.t;
        var f = span > 0 ? (tMs - a.t) / span : 0;
        // RA must be interpolated the short way round, or a path crossing 0h sweeps
        // backwards across the whole sky for exactly one segment
        var dra = ((b.raDeg - a.raDeg + 540) % 360) - 180;
        return {
          t: tMs,
          raDeg: a.raDeg + dra * f,
          decDeg: a.decDeg + (b.decDeg - a.decDeg) * f,
        };
      }
    }
    return null;
  }

  /* ---- extended pass track (round-3 review) --------------------------------
   * The scan's `path` covers only tEnter..tExit — for a telescope-sized field a
   * few seconds of arc. The extended track samples the SAME object over the WHOLE
   * scan timespan (while above the horizon), so the user sees where the trail
   * came from and where it went, and the label stays on screen after a crossing
   * that lasted two seconds. Positions are sky RA/Dec, pure functions of time, so
   * each track is computed once per scan and cached on the crossing object; the
   * per-frame cost is only the projection.
   */
  var EXT_BUILD_PER_FRAME = 30;   // spread the one-time build over frames: 81
                                  // tracks x <=400 SGP4+frame solutions is ~0.5 s,
                                  // which as a single hiccup would read as a hang

  function extTrackOf(cr, loc) {
    var sc = SAT.state.scan;
    var key = sc.ranAt ? sc.ranAt.getTime() : 0;
    if (cr._extK === key) return cr._ext;         // may be null (build failed)
    var params = sc.params || {};
    var t0 = params.t0Ms, spanMs = (params.spanMin || 0) * 60000;
    var obj = SAT.state.getObj ? SAT.state.getObj(cr.satId) : null;
    cr._extK = key;
    cr._ext = null;
    if (t0 == null || !(spanMs > 0) || !obj || !loc || !SAT.prop) return null;
    // Step: ~0.4 deg per segment at the CA rate, floored so a whole track never
    // exceeds ~400 points, clamped to [2 s, 60 s]. The bright in-FOV segment still
    // comes from the scan's fine samples, so coarseness here only touches the dim
    // context trail.
    var rate = Math.max(1, cr.rateAsPerS || 1);
    var stepMs = 1440e3 / rate;                   // 0.4 deg = 1440 arcsec
    stepMs = Math.max(stepMs, spanMs / 400);
    stepMs = Math.min(60000, Math.max(2000, stepMs));
    var pts = [];
    for (var t = t0; t <= t0 + spanMs; t += stepMs) {
      var lk = null;
      try { lk = SAT.prop.look(loc, obj, new Date(t), { dut1S: SAT.state.obs.dut1S }); }
      catch (e) { lk = null; }
      // null marks a below-horizon (or failed) gap; consumers break the line there
      pts.push((lk && lk.elDeg > 0) ? { t: t, raDeg: lk.raDeg, decDeg: lk.decDeg } : null);
    }
    cr._ext = pts.some(function (q) { return q; }) ? pts : null;
    return cr._ext;
  }

  /** pathPosAt over an extended track: interpolate only inside a contiguous
   *  above-horizon run, never across a gap. */
  function extPosAt(pts, tMs) {
    if (!pts) return null;
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      if (!a || !b) continue;
      if (tMs >= a.t && tMs <= b.t) return pathPosAt([a, b], tMs);
    }
    return null;
  }

  /** Arrowhead with its tip at b, pointing a->b — the pass motion direction
   *  (round-5 review). Nothing else on the trail says which way the object moved,
   *  and a streak on a real frame has no arrow either: this is the disambiguator. */
  function drawMotionArrow(a, b, col) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var L = Math.hypot(dx, dy);
    if (L < 1e-6) return;
    dx /= L; dy /= L;
    var s = 7;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(b.x - s * (dx * 0.866 - dy * 0.5), b.y - s * (dy * 0.866 + dx * 0.5));
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(b.x - s * (dx * 0.866 + dy * 0.5), b.y - s * (dy * 0.866 - dx * 0.5));
    ctx.stroke();
  }

  /** The marker label: `NAME [NORAD]`. The catalogue number is always the full
   *  decimal integer — Alpha-5 fields are decoded at parse time on the server
   *  ('A0000' arrives as 100000), so the bracket never shows the letter form. */
  function satLabel(cr) {
    var lbl = cr.name || '';
    if (cr.norad != null) lbl += (lbl ? ' ' : '') + '[' + cr.norad + ']';
    return lbl;
  }

  // ---- trails as clocks ------------------------------------------------------

  // Tick intervals, seconds. A trail gets the finest one that keeps its ticks at
  // least TICK_MIN_PX apart, so a 2-second LEO streak is ticked in tenths and a
  // GEO drift in minutes.
  var TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  var TICK_MIN_PX = 26;
  var DENSE_TRAILS = 150, CROWD_TRAILS = 400, CROWD_LABELS = 30;

  /** Tick interval (s) for a trail `lenPx` long on screen lasting `durS`, or 0
   *  when not even two ticks fit. Pure; unit-tested. */
  function tickStepS(lenPx, durS) {
    if (!(lenPx > 0) || !(durS > 0)) return 0;
    var need = TICK_MIN_PX * durS / lenPx;
    for (var i = 0; i < TICK_STEPS.length; i++) {
      if (TICK_STEPS[i] >= need) return durS / TICK_STEPS[i] >= 1 ? TICK_STEPS[i] : 0;
    }
    return 0;
  }

  /** Label for a tick at tMs given the tick interval: only the part of the time
   *  that changes between neighbouring ticks. Pure; unit-tested. */
  function tickLabel(tMs, stepS) {
    var d = new Date(tMs);
    var p2 = SAT.util.pad2;
    if (stepS >= 60) return p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
    var s = d.getUTCSeconds() + d.getUTCMilliseconds() / 1000;
    if (stepS >= 1) return ':' + p2(Math.round(s) % 60);
    var txt = s.toFixed(1);
    return ':' + (s < 9.95 ? '0' : '') + txt;
  }

  /** HH:MM:SS.s UTC — entry/exit instants. */
  function fmtClock(tMs, dec) {
    var d = new Date(tMs), p2 = SAT.util.pad2;
    var s = d.getUTCSeconds() + d.getUTCMilliseconds() / 1000;
    var n = dec == null ? 1 : dec;
    var st = s.toFixed(n);
    if (parseFloat(st) >= 60) { d = new Date(tMs + 1000); st = (0).toFixed(n); }
    return p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' +
      (parseFloat(st) < 10 ? '0' : '') + st;
  }

  /** Screen polyline of a crossing's in-field path, each point carrying its time.
   *  Unprojectable samples are dropped; the polyline never bridges the far side
   *  of the tangent plane because a path lies inside the field by construction. */
  function trailOf(cr) {
    var path = cr.path, pts = [];
    if (path) {
      for (var j = 0; j < path.length; j++) {
        var s = projAt(path[j].raDeg, path[j].decDeg, path[j].t);
        if (s && isFinite(s.x) && isFinite(s.y)) pts.push({ x: s.x, y: s.y, t: path[j].t });
      }
    }
    var len = 0;
    for (var k = 1; k < pts.length; k++) len += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);
    return { cr: cr, pts: pts, len: len, col: typeColorOf(cr) };
  }

  /** Point on a trail at time tMs (linear between samples), with the local
   *  direction of motion. Null outside the trail's time span. */
  function trailAt(tr, tMs) {
    var p = tr.pts;
    if (p.length < 2 || tMs < p[0].t || tMs > p[p.length - 1].t) return null;
    for (var i = 1; i < p.length; i++) {
      if (tMs <= p[i].t) {
        var a = p[i - 1], b = p[i], sp = b.t - a.t;
        var f = sp > 0 ? (tMs - a.t) / sp : 0;
        var dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
        return { x: a.x + dx * f, y: a.y + dy * f, dx: dx / L, dy: dy / L };
      }
    }
    return null;
  }

  /** Nearest point of a trail to (x, y): {d, t}. Pure geometry on screen px. */
  function nearestOnTrail(tr, x, y) {
    var p = tr.pts, best = { d: Infinity, t: null };
    for (var i = 1; i < p.length; i++) {
      var a = p[i - 1], b = p[i];
      var vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy;
      var f = L2 > 0 ? ((x - a.x) * vx + (y - a.y) * vy) / L2 : 0;
      f = f < 0 ? 0 : (f > 1 ? 1 : f);
      var d = Math.hypot(x - (a.x + vx * f), y - (a.y + vy * f));
      if (d < best.d) { best.d = d; best.t = a.t + (b.t - a.t) * f; best.i = i; }
    }
    if (p.length === 1) { best.d = Math.hypot(x - p[0].x, y - p[0].y); best.t = p[0].t; best.i = 0; }
    return best;
  }

  function strokeTrail(tr, nowMs, width, alpha, sweptAlpha) {
    var p = tr.pts;
    if (p.length < 2) return;
    ctx.lineWidth = width;
    // In the Earth's shadow at closest approach: drawn DASHED. It crosses the
    // field, but it reflects no sunlight — an optical streak is not this object.
    var dark = tr.cr.shadow === 'umbra' && ctx.setLineDash;
    if (dark) ctx.setLineDash([5, 4]);
    // Two strokes per trail, not one per segment: the already-swept part dimmed,
    // so what remains bright is what is still to come at the current clock time.
    // `k` is the first sample at or after the clock.
    var k = 0;
    while (k < p.length && p[k].t < nowMs) k++;
    var cut = null;
    if (k > 0 && k < p.length) {
      var a = p[k - 1], b = p[k], f = (nowMs - a.t) / Math.max(1, b.t - a.t);
      cut = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    var j;
    if (k > 0) {
      ctx.strokeStyle = hexA(tr.col, sweptAlpha);
      ctx.beginPath();
      ctx.moveTo(p[0].x, p[0].y);
      for (j = 1; j < k; j++) ctx.lineTo(p[j].x, p[j].y);
      if (cut) ctx.lineTo(cut.x, cut.y);
      ctx.stroke();
    }
    if (k < p.length) {
      ctx.strokeStyle = hexA(tr.col, alpha);
      ctx.beginPath();
      if (cut) ctx.moveTo(cut.x, cut.y); else ctx.moveTo(p[k].x, p[k].y);
      for (j = cut ? k : k + 1; j < p.length; j++) ctx.lineTo(p[j].x, p[j].y);
      ctx.stroke();
    }
    if (dark) ctx.setLineDash([]);
  }

  /** Ticks at round UTC instants along a trail. `labels` prints the time beside
   *  each (the selected and hovered trails); otherwise the ticks alone. */
  function drawTicks(tr, labels) {
    var p = tr.pts;
    if (p.length < 2) return;
    var durS = (p[p.length - 1].t - p[0].t) / 1000;
    var step = tickStepS(tr.len, durS);
    if (!step) return;
    var stepMs = step * 1000;
    var half = labels ? 5 : 3.2;
    ctx.strokeStyle = hexA(labels ? '#ffffff' : tr.col, labels ? 0.95 : 0.8);
    ctx.lineWidth = labels ? 1.4 : 1.1;
    ctx.font = '10px ' + MONO;
    // Labelled ticks are spaced evenly — every 1st, 2nd, 5th or 10th, at round
    // multiples — rather than "whichever happened to fit".
    var stride = 1;
    if (labels) {
      var perTick = tr.len / (durS / step);
      var ex = Math.abs(p[p.length - 1].x - p[0].x), ey = Math.abs(p[p.length - 1].y - p[0].y);
      var eL = Math.hypot(ex, ey) || 1;
      var extent = (ex / eL) * (ctx.measureText(tickLabel(p[0].t, step)).width + 10) + (ey / eL) * 16;
      var want = extent / Math.max(1, perTick);
      stride = want <= 1 ? 1 : (want <= 2 ? 2 : (want <= 5 ? 5 : 10));
    }
    var first = Math.ceil(p[0].t / stepMs - 1e-6) * stepMs;
    var count = 0;
    for (var tk = first; tk <= p[p.length - 1].t + 1e-6 && count < 400; tk += stepMs, count++) {
      var q = trailAt(tr, Math.min(tk, p[p.length - 1].t));
      if (!q || !onScreen(q, 8)) continue;
      var major = labels && Math.round(tk / stepMs) % stride === 0;
      var hl = major ? half + 1.5 : half;
      ctx.beginPath();
      ctx.moveTo(q.x - q.dy * hl, q.y + q.dx * hl);
      ctx.lineTo(q.x + q.dy * hl, q.y - q.dx * hl);
      ctx.stroke();
      if (major) {
        // beside the tick, on whichever side is free — and if neither is, on a
        // dark plate anyway: reading the times is why the trail was picked
        var txt = tickLabel(tk, step);
        if (!textBeside(txt, q.x, q.y, -q.dy, q.dx, 7, 'rgba(255,255,255,0.92)', false) &&
            !textBeside(txt, q.x, q.y, q.dy, -q.dx, 7, 'rgba(255,255,255,0.92)', false)) {
          textBeside(txt, q.x, q.y, -q.dy, q.dx, 7, 'rgba(255,255,255,0.92)', true);
        }
      }
    }
  }

  /** One arrowhead a little past half way: which way it moved. A streak on a real
   *  frame has no arrow — this is the disambiguator. */
  function drawChevron(tr, col) {
    var p = tr.pts;
    var start = Math.max(1, Math.floor(p.length * 0.55));
    for (var j = start; j < p.length; j++) {
      var a = p[j - 1], b = p[j];
      if (!onScreen(b, 20) || Math.hypot(b.x - a.x, b.y - a.y) < 4) continue;
      drawMotionArrow(a, b, col);
      return;
    }
  }

  /** Name label for a trail: tried at the exit end (pushed onward along the
   *  motion, so it lands OUTSIDE the frame for a trail that leaves it), then the
   *  entry end, then beside either end and the middle. `force` guarantees it. */
  function labelTrail(tr, text, fill, force) {
    var p = tr.pts;
    if (!p.length) return false;
    var vis = [];
    for (var i = 0; i < p.length; i++) if (onScreen(p[i], 0)) vis.push(p[i]);
    if (!vis.length) return false;
    var first = vis[0], last = vis[vis.length - 1];
    var dx = last.x - first.x, dy = last.y - first.y, L = Math.hypot(dx, dy);
    var tries;
    if (L < 6) {
      // a dot (a geostationary object against a parked mount): any side will do
      tries = [[last, 1, 0], [last, -1, 0], [last, 0, -1], [last, 0, 1],
        [last, 1, -1], [last, 1, 1], [last, -1, -1], [last, -1, 1]];
    } else {
      // local directions at the two ends
      var a = vis[Math.max(0, vis.length - 3)], b = vis[Math.min(vis.length - 1, 2)];
      var ex = last.x - a.x, ey = last.y - a.y, eL = Math.hypot(ex, ey) || 1;
      var sx = first.x - b.x, sy = first.y - b.y, sL = Math.hypot(sx, sy) || 1;
      ex /= eL; ey /= eL; sx /= sL; sy /= sL;
      var mid = vis[vis.length >> 1];
      tries = [
        [last, ex, ey], [first, sx, sy],
        [last, -ey, ex], [last, ey, -ex], [first, -sy, sx], [first, sy, -sx],
        [mid, -ey, ex], [mid, ey, -ex],
      ];
    }
    for (var k = 0; k < tries.length; k++) {
      if (textBeside(text, tries[k][0].x, tries[k][0].y, tries[k][1], tries[k][2], 7, fill, false)) return true;
    }
    if (force) return textBeside(text, tries[0][0].x, tries[0][0].y, tries[0][1], tries[0][2], 7, fill, true);
    return false;
  }

  function drawCrossings(list, nowMs) {
    var c = cfg();
    var selId = SAT.state.selection ? SAT.state.selection.satId : null;
    var hovId = hover.id;
    var loc = SAT.state.activeLocation();
    var i, j, tr;
    // Density tiers. Past DENSE trails the ticks stop helping; past CROWD the
    // chart thins everything — a wide field over an hour is a thousand trails,
    // and drawn at full weight that is a solid block of colour.
    var dense = list.length > DENSE_TRAILS, crowd = list.length > CROWD_TRAILS;
    var extBudget = EXT_BUILD_PER_FRAME;
    var extPending = false;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Layer 1: the dim whole-timespan tracks, under everything else. Drawn first
    // so the bright in-FOV segments and the FOV outline always win visually.
    // With tracks off the build still runs — the off-field marker position
    // follows the extended track — only the strokes are skipped.
    ctx.lineWidth = 1;
    var key = (SAT.state.scan && SAT.state.scan.ranAt) ? SAT.state.scan.ranAt.getTime() : 0;
    for (i = 0; i < list.length; i++) {
      var crx = list[i];
      if (crx._extK !== key) {
        if (extBudget <= 0) { extPending = true; continue; }
        extBudget--;
      }
      var ext = extTrackOf(crx, loc);
      if (!ext || !c.tracks) continue;
      var hot = crx.satId === selId || crx.satId === hovId;
      // a crowded chart keeps only the picked object's context track: hundreds
      // of them are a fog, and projecting them is most of the frame time
      if (crowd && !hot) continue;
      ctx.strokeStyle = hexA(typeColorOf(crx), hot ? 0.42 : 0.16);
      var prev = null;
      ctx.beginPath();
      for (j = 0; j < ext.length; j++) {
        var q = ext[j];
        var sp = q ? projAt(q.raDeg, q.decDeg, q.t) : null;
        if (!sp || !onScreen(sp, 400)) { prev = null; continue; }
        if (prev) ctx.lineTo(sp.x, sp.y); else ctx.moveTo(sp.x, sp.y);
        prev = sp;
      }
      ctx.stroke();
    }
    // finish building the remaining tracks on subsequent frames
    if (extPending) requestRender();

    // Layer 2: the crossing paths. THIS is the identification tool: the trail the
    // object cuts across the field between tEnter and tExit, drawn from the scan's
    // own samples so curvature is preserved.
    trails = [];
    for (i = 0; i < list.length; i++) trails.push(trailOf(list[i]));
    var anyHot = selId != null || hovId != null;
    if (c.tracks) {
      var wLine = crowd ? 1 : 1.5;
      var aLine = (crowd ? 0.42 : 0.9) * (anyHot ? 0.6 : 1);
      for (i = 0; i < trails.length; i++) {
        tr = trails[i];
        if (tr.pts.length < 2 || tr.cr.satId === selId || tr.cr.satId === hovId) continue;
        // with one trail picked out, the rest step back
        strokeTrail(tr, nowMs, wLine, aLine, aLine * 0.36);
        if (c.ticks && !dense) drawTicks(tr, false);
        if (!crowd) drawChevron(tr, hexA(tr.col, anyHot ? 0.6 : 0.95));
      }
      // the hovered and the selected trail, on top: a white under-stroke lifts them
      // off whatever they cross
      for (i = 0; i < trails.length; i++) {
        tr = trails[i];
        if (tr.pts.length < 2) continue;
        var isSel = tr.cr.satId === selId, isHov = tr.cr.satId === hovId;
        if (!isSel && !isHov) continue;
        ctx.strokeStyle = 'rgba(255,255,255,' + (isSel ? 0.30 : 0.20) + ')';
        ctx.lineWidth = isSel ? 6 : 5;
        ctx.beginPath();
        for (j = 0; j < tr.pts.length; j++) {
          if (j) ctx.lineTo(tr.pts[j].x, tr.pts[j].y); else ctx.moveTo(tr.pts[j].x, tr.pts[j].y);
        }
        ctx.stroke();
        strokeTrail(tr, nowMs, 2.2, 1, 0.5);
        drawChevron(tr, tr.col);
      }
    }

    // Layer 3: current positions. Inside the crossing window the scan's fine path
    // is the authority; outside it (the object has left the field, or not yet
    // arrived) fall back to the extended track, drawn dimmer — a two-second
    // crossing must not mean a two-second marker (round-3 review).
    var loose = [];                              // markers whose trail is not on screen
    for (i = 0; i < list.length; i++) {
      var cr = list[i];
      var pos = pathPosAt(cr.path, nowMs);
      var inField = !!pos;
      if (!pos) pos = extPosAt(cr._ext, nowMs);
      if (!pos) continue;
      var p = projAt(pos.raDeg, pos.decDeg, nowMs);
      if (!onScreen(p, 30)) continue;
      var col = typeColorOf(cr);
      if (!inField) ctx.globalAlpha = 0.55;
      ctx.fillStyle = col;
      ctx.strokeStyle = 'rgba(8,10,14,0.9)';
      ctx.lineWidth = 1;
      ctx.fillRect(p.x - 3.5, p.y - 3.5, 7, 7);
      ctx.strokeRect(p.x - 3.5, p.y - 3.5, 7, 7);
      if (cr.satId === selId || cr.satId === hovId) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
      if (!inField) ctx.globalAlpha = 1;
      markerHits.push({ id: cr.satId, x: p.x, y: p.y });
      labelBoxes.push([p.x - 5, p.y - 5, p.x + 5, p.y + 5]);   // text keeps off markers
      loose.push({ cr: cr, x: p.x, y: p.y, inField: inField });
    }

    // Text keeps off the trails as well as off other text: a name printed along
    // somebody else's trail reads as struck through. Each trail lays a string of
    // small boxes; skipped on a crowded chart, where it would cost more than the
    // few placements it could still improve.
    if (c.tracks && trails.length <= 80) {
      for (i = 0; i < trails.length; i++) {
        var tp = trails[i].pts, acc = 12;
        for (j = 1; j < tp.length; j++) {
          var ax = tp[j - 1].x, ay = tp[j - 1].y;
          var seg = Math.hypot(tp[j].x - ax, tp[j].y - ay);
          if (!(seg > 0)) continue;
          for (var u = 12 - acc; u <= seg; u += 12) {
            var bx = ax + (tp[j].x - ax) * u / seg, by = ay + (tp[j].y - ay) * u / seg;
            if (bx > 0 && bx < cssW && by > 0 && by < cssH) labelBoxes.push([bx - 3, by - 3, bx + 3, by + 3]);
          }
          acc = (acc + seg) % 12;
        }
      }
    }

    // Layer 4: text, in priority order — selected, hovered, then the rest by how
    // long they are in the field — every piece through claim(), so a name is
    // either readable or left to the hover card.
    // (An object that sits still on the detector — a dot, not a streak — ranks
    // above every streak: on a parked mount those are the geostationary objects
    // one is usually there to identify.)
    var rank = function (u) {
      return (u.cr.satId === selId ? 4 : 0) + (u.cr.satId === hovId ? 2 : 0) +
        (u.pts.length >= 2 && u.len < 6 ? 1 : 0);
    };
    var order = trails.slice().sort(function (u, v) {
      var pu = rank(u), pv = rank(v);
      if (pu !== pv) return pv - pu;
      return v.len - u.len;
    });
    ctx.font = '11px ' + MONO;
    var named = {}, nNamed = 0;
    for (i = 0; i < order.length; i++) {
      tr = order[i];
      var s2 = tr.cr.satId === selId, h2 = tr.cr.satId === hovId;
      if (c.tracks && tr.pts.length >= 2 && (s2 || h2)) {
        // the picked trail is annotated as a clock: tick times, entry and exit
        if (c.ticks) drawTicks(tr, true);
        ctx.font = '10px ' + MONO;
        var pp = tr.pts, e0 = pp[0], e1 = pp[pp.length - 1];
        var d0 = trailAt(tr, e0.t) || { dx: 1, dy: 0 }, d1 = trailAt(tr, e1.t) || { dx: 1, dy: 0 };
        if (onScreen(e0, 0)) textBeside(fmtClock(tr.cr.tEnterMs), e0.x, e0.y, -d0.dx, -d0.dy, 8, hexA(tr.col, 1), false);
        if (onScreen(e1, 0)) {
          if (!textBeside(fmtClock(tr.cr.tExitMs), e1.x, e1.y, -d1.dy, d1.dx, 9, hexA(tr.col, 1), false)) {
            textBeside(fmtClock(tr.cr.tExitMs), e1.x, e1.y, d1.dy, -d1.dx, 9, hexA(tr.col, 1), false);
          }
        }
        ctx.font = '11px ' + MONO;
      }
      if (!c.labels && !s2 && !h2) continue;
      if (!c.tracks || tr.pts.length < 2) continue;
      if (crowd && !s2 && !h2 && nNamed >= CROWD_LABELS) continue;
      nNamed++;
      if (labelTrail(tr, satLabel(tr.cr), (s2 || h2) ? '#ffffff' : 'rgba(226,232,240,0.92)', s2 || h2)) {
        named[tr.cr.satId] = true;
      }
    }
    // an object whose trail is off screen (or tracks are off) is named at its marker
    for (i = 0; i < loose.length; i++) {
      var m = loose[i];
      if (named[m.cr.satId]) continue;
      var pick = m.cr.satId === selId || m.cr.satId === hovId;
      if (!c.labels && !pick) continue;
      if (crowd && !pick) continue;
      if (!m.inField) ctx.globalAlpha = 0.7;
      var done = textBeside(satLabel(m.cr), m.x, m.y, 1, 0, 7, '#ffffff', false) ||
        textBeside(satLabel(m.cr), m.x, m.y, -1, 0, 7, '#ffffff', false) ||
        textBeside(satLabel(m.cr), m.x, m.y, 0, -1, 7, '#ffffff', false) ||
        textBeside(satLabel(m.cr), m.x, m.y, 0, 1, 7, '#ffffff', pick);
      if (done) named[m.cr.satId] = true;
      ctx.globalAlpha = 1;
    }
    return list.length;
  }

  var TYPE_NAME = { 'PAY': 'payload', 'R/B': 'rocket body', 'DEB': 'debris', 'UNK': 'unknown' };

  /** Colour key, top-left: only the types actually on the chart, with counts. */
  function drawLegend(list) {
    if (!cfg().legend || !list.length) return;
    var n = { 'PAY': 0, 'R/B': 0, 'DEB': 0, 'UNK': 0 };
    for (var i = 0; i < list.length; i++) {
      var k = list[i].type;
      n[(k === 'PAY' || k === 'R/B' || k === 'DEB') ? k : 'UNK']++;
    }
    ctx.font = '10px ' + MONO;
    var x = 10, y = 12;
    ['PAY', 'R/B', 'DEB', 'UNK'].forEach(function (k) {
      if (!n[k]) return;
      var txt = TYPE_NAME[k] + ' ' + n[k];
      var w = ctx.measureText(txt).width;
      if (!claim(x - 2, y - 7, x + 14 + w, y + 7, 0)) return;
      ctx.fillStyle = SAT.state.typeColorOf ? SAT.state.typeColorOf(k) : '#90a4ae';
      ctx.fillRect(x, y - 3.5, 7, 7);
      haloText(txt, x + 12, y, 'rgba(200,210,222,0.92)', 'left', 'middle');
      x += w + 26;
    });
    // the one line style that carries meaning
    for (var q = 0; q < list.length; q++) {
      if (list[q].shadow !== 'umbra') continue;
      var note = 'in Earth shadow';
      var nw = ctx.measureText(note).width;
      if (cfg().tracks && ctx.setLineDash && claim(x - 2, y - 7, x + 26 + nw, y + 7, 0)) {
        ctx.strokeStyle = 'rgba(200,210,222,0.9)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(x + 19, y);
        ctx.stroke();
        ctx.setLineDash([]);
        haloText(note, x + 24, y, 'rgba(200,210,222,0.92)', 'left', 'middle');
      }
      break;
    }
  }

  function drawSunMoon(ra0, dec0, t, date) {
    if (!cfg().sunMoon) return null;
    var sun = null, moon = null, p;
    try { sun = SAT.frames.sunJ2000(date); } catch (e) { sun = null; }
    try { moon = SAT.frames.moonJ2000(date); } catch (e) { moon = null; }

    if (sun) {
      p = proj(sun.raDeg, sun.decDeg, ra0, dec0, t);
      if (onScreen(p, 20)) {
        // rayed disc, straight from the SatObserver chart
        ctx.strokeStyle = '#ffd54f';
        ctx.lineWidth = 1.5;
        for (var k = 0; k < 8; k++) {
          var a = k * Math.PI / 4;
          ctx.beginPath();
          ctx.moveTo(p.x + Math.cos(a) * 7, p.y + Math.sin(a) * 7);
          ctx.lineTo(p.x + Math.cos(a) * 11, p.y + Math.sin(a) * 11);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffd54f';
        ctx.fill();
        ctx.strokeStyle = 'rgba(60,40,0,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    if (moon) {
      var q = proj(moon.raDeg, moon.decDeg, ra0, dec0, t);
      if (onScreen(q, 20)) {
        // geocentric sun–moon elongation -> phase; bright limb faces the sun.
        // The sun can be over the tangent-plane horizon (unprojectable), so the
        // limb direction comes from a waypoint 1° along the moon->sun great
        // circle, which is always projectable next to an on-screen moon.
        var R = 5.5, phi = 0, cosPsi = 0;
        var mv = sun ? SAT.frames.raDecToVec(moon.raDeg, moon.decDeg) : null;
        if (mv) {
          var sv = SAT.frames.raDecToVec(sun.raDeg, sun.decDeg);
          cosPsi = mv.x * sv.x + mv.y * sv.y + mv.z * sv.z;
          var tx = sv.x - cosPsi * mv.x, ty = sv.y - cosPsi * mv.y, tz = sv.z - cosPsi * mv.z;
          var tn = Math.hypot(tx, ty, tz);
          if (tn > 1e-9) {
            var wc = Math.cos(D2R), ws = Math.sin(D2R);
            var wrd = SAT.frames.vecToRaDec({
              x: mv.x * wc + tx / tn * ws,
              y: mv.y * wc + ty / tn * ws,
              z: mv.z * wc + tz / tn * ws,
            });
            var wp = proj(wrd.raDeg, wrd.decDeg, ra0, dec0, t);
            if (wp) phi = Math.atan2(wp.y - q.y, wp.x - q.x);
          }
        }
        ctx.save();
        ctx.translate(q.x, q.y);
        ctx.rotate(phi);                    // +x now points toward the sun
        ctx.beginPath();                    // dark side
        ctx.arc(0, 0, R, 0, Math.PI * 2);
        ctx.fillStyle = '#3c4148';
        ctx.fill();
        ctx.beginPath();                    // lit side: sun-side semicircle …
        ctx.arc(0, 0, R, -Math.PI / 2, Math.PI / 2, false);
        // … closed by the terminator ellipse (toward the sun when crescent)
        ctx.ellipse(0, 0, R * Math.abs(cosPsi), R, 0, Math.PI / 2, -Math.PI / 2, cosPsi > 0);
        ctx.fillStyle = '#e6e2d6';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0, R, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(8,10,14,0.7)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
    }
    return moon;
  }

  // ---- ruler -----------------------------------------------------------------

  /** Smallest angle between two undirected lines, degrees (0..90). A streak has no
   *  direction, so position angles are compared modulo 180. Pure; unit-tested. */
  function lineAngleDiff(aDeg, bDeg) {
    var d = Math.abs(aDeg - bDeg) % 180;
    return d > 90 ? 180 - d : d;
  }

  /** Rank trails against a measured streak. `seg` is the ruler in screen px
   *  ({ax, ay, bx, by}); each trail is scored by how far its line passes from the
   *  streak's midpoint and how far its direction is from the streak's. Returns
   *  [{id, offPx, dAng}] best first. Pure; unit-tested. */
  function rankTrails(list, seg) {
    var mx = (seg.ax + seg.bx) / 2, my = (seg.ay + seg.by) / 2;
    var len = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay) || 1;
    var ang = Math.atan2(seg.by - seg.ay, seg.bx - seg.ax) * R2D;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var tr = list[i], p = tr.pts;
      if (p.length < 2) continue;
      var nr = nearestOnTrail(tr, mx, my);
      var a = p[Math.max(0, nr.i - 1)], b = p[nr.i];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) { a = p[0]; b = p[p.length - 1]; }
      var dAng = lineAngleDiff(ang, Math.atan2(b.y - a.y, b.x - a.x) * R2D);
      // one streak-length of offset counts like 10 degrees of angle
      out.push({ id: tr.cr.satId, cr: tr.cr, offPx: nr.d, dAng: dAng, score: nr.d / len + dAng / 10 });
    }
    out.sort(function (u, v) { return u.score - v.score; });
    return out;
  }

  var rulerSig = '';

  function drawRuler(nowMs) {
    if (!elRuler) return;
    if (!ruler.a || !ruler.b) {
      if (rulerSig !== '') { rulerSig = ''; elRuler.style.display = 'none'; }
      return;
    }
    var a = projAt(ruler.a.raDeg, ruler.a.decDeg, nowMs);
    var b = projAt(ruler.b.raDeg, ruler.b.decDeg, nowMs);
    if (!a || !b) return;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.stroke();
    var L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    var nx = -(b.y - a.y) / L * 5, ny = (b.x - a.x) / L * 5;
    ctx.beginPath();
    ctx.moveTo(a.x - nx, a.y - ny); ctx.lineTo(a.x + nx, a.y + ny);
    ctx.moveTo(b.x - nx, b.y - ny); ctx.lineTo(b.x + nx, b.y + ny);
    ctx.stroke();

    var F = SAT.frames;
    var lenDeg = F.sep(ruler.a.raDeg, ruler.a.decDeg, ruler.b.raDeg, ruler.b.decDeg);
    var pa = F.posAngle(ruler.a.raDeg, ruler.a.decDeg, ruler.b.raDeg, ruler.b.decDeg);
    var ranked = L > 3 ? rankTrails(trails, { ax: a.x, ay: a.y, bx: b.x, by: b.y }).slice(0, 4) : [];
    var sig = lenDeg.toFixed(5) + '|' + pa.toFixed(2) + '|' + ranked.map(function (r) {
      return r.id + ':' + r.offPx.toFixed(0) + ':' + r.dAng.toFixed(1);
    }).join(',') + '|' + curScale.toFixed(3);
    if (sig === rulerSig) return;
    rulerSig = sig;
    var U = SAT.util;
    while (elRuler.firstChild) elRuler.removeChild(elRuler.firstChild);
    elRuler.appendChild(U.el('div', { class: 'chart-ruler-head' },
      'streak  ' + U.fmtAngle(lenDeg, 2) + '   PA ' + pa.toFixed(1) + '° / ' +
      ((pa + 180) % 360).toFixed(1) + '°'));
    if (!ranked.length) {
      elRuler.appendChild(U.el('div', { class: 'dim' },
        trails.length ? 'drag along the streak' : 'no predicted trails to compare — run a scan'));
    } else {
      elRuler.appendChild(U.el('div', { class: 'dim' }, 'closest predicted trails'));
      ranked.forEach(function (r) {
        var row = U.el('div', {
          class: 'chart-ruler-row',
          title: 'select this object',
          onclick: function () { try { SAT.state.setSelection(r.id); } catch (e) { /* ignore */ } },
        }, [
          U.el('span', { class: 'sw', style: 'background:' + typeColorOf(r.cr) }),
          U.el('span', { class: 'nm' }, satLabel(r.cr)),
          U.el('span', { class: 'dim' }, 'off ' + U.fmtAngle(r.offPx / Math.max(1e-9, curScale), 1) +
            '  Δ' + r.dAng.toFixed(1) + '°'),
        ]);
        elRuler.appendChild(row);
      });
    }
    elRuler.style.display = 'block';
  }

  // ---- timeline --------------------------------------------------------------

  var TL_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200];

  /** Tick spacing (s) for a timeline `spanS` long drawn `widthPx` wide: labels at
   *  least ~90 px apart. Pure; unit-tested. */
  function timelineStepS(spanS, widthPx) {
    var need = 90 * spanS / Math.max(1, widthPx);
    for (var i = 0; i < TL_STEPS.length; i++) if (TL_STEPS[i] >= need) return TL_STEPS[i];
    return TL_STEPS[TL_STEPS.length - 1];
  }

  /** Layout of the strip, CSS px from its top: tick labels, tick marks, then the
   *  slider's track with its thumb. */
  var TL_LABEL_Y = 7, TL_TICK_Y0 = 14, TL_TRACK_Y = 25, TL_TRACK_H = 4, TL_THUMB_R = 6;

  function roundBar(c, x, y, w, h) {
    var r = h / 2;
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    c.lineTo(x + r, y + h);
    c.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
    c.closePath();
  }

  /** The scan window as a time slider: a UTC axis over a track, the clock as the
   *  thumb. Press or drag anywhere on the strip to move the clock. (Round 25: the
   *  per-crossing colour bars are gone — the strip is the time control and
   *  nothing else; the crossings are on the chart and in the Crossings table.) */
  function drawTimeline(nowMs) {
    if (!tctx || tlW < 2 || tlH < 2) return;
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tctx.fillStyle = '#0c1116';
    tctx.fillRect(0, 0, tlW, tlH);
    tlRange = null;
    var sc = SAT.state.scan, pr = sc && sc.params;
    tctx.font = '10px ' + MONO;
    tctx.textBaseline = 'middle';
    if (!pr || pr.t0Ms == null || !(pr.spanMin > 0)) {
      tctx.fillStyle = '#6b7783';
      tctx.textAlign = 'center';
      tctx.fillText('time slider — run a scan to step through its window', tlW / 2, tlH / 2);
      tctx.textAlign = 'left';
      return;
    }
    var t0 = pr.t0Ms, t1 = t0 + pr.spanMin * 60000;
    var x0 = 12, x1 = Math.max(x0 + 10, tlW - 12);
    var X = function (tm) { return x0 + (tm - t0) / (t1 - t0) * (x1 - x0); };
    tlRange = { t0: t0, t1: t1, x0: x0, x1: x1 };
    var p2 = SAT.util.pad2;
    var stale = !!sc.stale;
    var yT = TL_TRACK_Y, yTop = yT - TL_TRACK_H / 2;

    // the clock: outside the window the thumb parks at that end, hollow
    var xp = X(nowMs), out = xp < x0 ? -1 : (xp > x1 ? 1 : 0);
    xp = SAT.util.clamp(xp, x0, x1);

    // track, with the elapsed part filled
    tctx.fillStyle = 'rgba(154,164,174,0.22)';
    roundBar(tctx, x0, yTop, x1 - x0, TL_TRACK_H);
    tctx.fill();
    if (xp - x0 > TL_TRACK_H) {
      tctx.fillStyle = stale ? 'rgba(255,184,79,0.45)' : 'rgba(79,195,247,0.55)';
      roundBar(tctx, x0, yTop, xp - x0, TL_TRACK_H);
      tctx.fill();
    }

    // axis: round UTC instants, ticks standing on the track
    var spanS = (t1 - t0) / 1000;
    var step = timelineStepS(spanS, x1 - x0) * 1000;
    tctx.strokeStyle = 'rgba(154,164,174,0.45)';
    tctx.fillStyle = '#8b97a3';
    tctx.lineWidth = 1;
    tctx.textAlign = 'center';
    tctx.beginPath();
    for (var tk = Math.ceil(t0 / step) * step; tk <= t1; tk += step) {
      var xt = Math.round(X(tk)) + 0.5;
      tctx.moveTo(xt, TL_TICK_Y0); tctx.lineTo(xt, yTop - 1);
      var d = new Date(tk);
      var lab = p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) +
        (step < 60000 ? ':' + p2(d.getUTCSeconds()) : '');
      // a label at either end of the window is nudged inward rather than dropped
      var lw = tctx.measureText(lab).width;
      tctx.fillText(lab, SAT.util.clamp(xt, lw / 2 + 3, tlW - lw / 2 - 3), TL_LABEL_Y);
    }
    tctx.stroke();

    // thumb
    var col = stale ? '#ffb84f' : ACCENT;
    var hot = !!tlDrag || tlHover;
    tctx.beginPath();
    tctx.arc(xp, yT, TL_THUMB_R + (hot ? 1 : 0), 0, Math.PI * 2);
    tctx.fillStyle = out ? '#0c1116' : col;
    tctx.fill();
    tctx.lineWidth = out ? 1.5 : 2;
    tctx.strokeStyle = out ? col : (hot ? '#ffffff' : '#0c1116');
    tctx.stroke();
    if (out) {                                   // the clock is off this end
      tctx.beginPath();
      tctx.moveTo(xp - out * 2, yT - 3); tctx.lineTo(xp + out * 2, yT); tctx.lineTo(xp - out * 2, yT + 3);
      tctx.stroke();
    }

    // while the thumb is held, its instant on a plate over the axis labels
    if (tlDrag && !out) {
      var txt = fmtClock(nowMs, spanS <= 600 ? 1 : 0);
      var tw = tctx.measureText(txt).width + 10;
      var bx = SAT.util.clamp(xp - tw / 2, 2, tlW - tw - 2);
      tctx.fillStyle = '#0c1116';
      tctx.fillRect(bx - 3, 0, tw + 6, TL_TICK_Y0 + 1);
      tctx.fillStyle = 'rgba(79,195,247,0.16)';
      tctx.strokeStyle = col;
      tctx.lineWidth = 1;
      tctx.fillRect(bx, 1, tw, 12);
      tctx.strokeRect(bx + 0.5, 1.5, tw - 1, 11);
      tctx.fillStyle = '#e8eef4';
      tctx.fillText(txt, bx + tw / 2, TL_LABEL_Y);
    }
    tctx.textAlign = 'left';
  }

  // ---- render --------------------------------------------------------------

  function centreMessage(text) {
    ctx.fillStyle = '#9aa4ae';
    ctx.font = '12px ' + MONO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cssW / 2, cssH / 2);
    ctx.textAlign = 'left';
  }

  function scaleBarPx(t) {
    var targetPx = Math.max(40, cssW * 0.18);
    return niceAtMost(targetPx / Math.max(1e-9, t.scale)) * t.scale;
  }

  function render() {
    if (!ctx || cssW < 2 || cssH < 2) return;
    var date = SAT.clock ? SAT.clock.getDate() : new Date();
    var nowMs = date.getTime();
    markerHits = [];
    labelBoxes = [];
    trails = [];

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#0a0e13';
    ctx.fillRect(0, 0, cssW, cssH);

    var o = SAT.state.obs;
    var list = [];
    // chartCrossings, not visibleCrossings: ticked rows narrow the drawn set
    try { list = SAT.state.chartCrossings() || []; } catch (e) { list = []; }

    // The frame table has to cover everything that will be drawn across time: every
    // crossing path, plus the clock time itself.
    var t0 = nowMs, t1 = nowMs;
    for (var i = 0; i < list.length; i++) {
      var pth = list[i].path;
      if (!pth || !pth.length) continue;
      if (pth[0].t < t0) t0 = pth[0].t;
      if (pth[pth.length - 1].t > t1) t1 = pth[pth.length - 1].t;
    }
    var tp = buildFrames(nowMs, t0, t1);
    if (!tp) {
      centreMessage('Alt/Az pointing needs a site — set an active ground station in Locations');
      if (elHud) elHud.textContent = '—';
      if (elCursor) elCursor.textContent = '';
      drawTimeline(nowMs);
      return;
    }
    var ra0 = tp.raDeg, dec0 = tp.decDeg;
    var t = transform();
    curScale = t.scale; curCx = t.cx; curCy = t.cy;

    // the scale bar and the compass own their corners: no text may land there
    labelBoxes.push([6, cssH - 42, 22 + scaleBarPx(t), cssH - 8]);
    labelBoxes.push([cssW - 74, cssH - 74, cssW - 6, cssH - 6]);

    var gridLines = cfg().grid ? drawGrid(ra0, dec0, t) : null;
    drawStars(ra0, dec0, t);
    drawSunMoon(ra0, dec0, t, date);
    drawFov(t);
    drawLegend(list);
    drawCrossings(list, nowMs);
    drawRuler(nowMs);
    if (gridLines) drawGridLabels(gridLines, t);
    drawScaleBar(t);
    drawCompass(t);

    // Status line (round 19 wording, kept): the pointing, the field, the
    // orientation and the tracking mode, and (round 25) the stale-scan note.
    var fovTxt = o.fovShape === 'circ'
      ? 'r ' + SAT.util.fmtAngle(o.fovRDeg, 1)
      : SAT.util.fmtAngle(o.fovWDeg, 1) + ' × ' + SAT.util.fmtAngle(o.fovHDeg, 1);
    var mount = o.track === 'mount';
    var hud = 'RA ' + SAT.util.fmtRA(ra0) + '  Dec ' + SAT.util.fmtDec(dec0) +
      ' · ' + fovTxt + ' · rot ' + o.rotDeg.toFixed(0) + '°' +
      (o.flipEW ? ' · mirrored' : '');
    if (o.mode === 'altaz') {
      hud += '  [Az ' + o.azDeg.toFixed(2) + '° El ' + o.elDeg.toFixed(2) + '°]';
    }
    hud += mount ? ' · sidereal off' : ' · sidereal on';
    if (elHud) elHud.textContent = hud;
    if (elStale) {
      var sc2 = SAT.state.scan;
      var note = (sc2 && sc2.stale && sc2.params) ? 'pointing changed since this scan — re-run' : '';
      if (elStale.textContent !== note) elStale.textContent = note;
    }
    if (elZoom) elZoom.textContent = Math.round(view.zoom * 100) + '%';
    if (elMagAuto) {
      // "auto" says what it resolved to: the depth actually on screen
      var c2 = cfg();
      var lbl = (c2.magAuto && c2.stars && starCache.ok && starCache.drawnMag != null)
        ? 'auto · V ' + (+starCache.drawnMag).toFixed(1) : 'auto';
      if (elMagAuto.textContent !== lbl) elMagAuto.textContent = lbl;
    }

    drawTimeline(nowMs);
    if (mouse.inside && hover.id) showTip();
  }

  function requestRender() {
    dirty = true;
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(function () {
      rafQueued = false;
      if (!dirty) return;
      if (winRef && !winRef.isOpen()) return;
      dirty = false;
      try {
        render();
      } catch (e) {
        // one warning, then stay quiet: a broken layer must not kill the rAF loop
        if (!warned) { warned = true; console.warn('chart render failed', e); }
      }
    });
  }

  // ---- interaction ---------------------------------------------------------

  function evtPos(e, elm) {
    var r = (elm || canvas).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Sky position under a canvas pixel, in the frame the chart was last drawn in
   *  (the parked mount's drifted frame included). */
  function cursorSky(x, y) {
    var fr = frameRef;
    if (!fr) {
      var tp = tangentPoint(SAT.clock ? SAT.clock.getDate() : new Date());
      if (!tp) return null;
      fr = { raDeg: tp.raDeg, decDeg: tp.decDeg, rotDeg: SAT.state.obs.rotDeg };
    }
    var s = screenToSky(x, y, transform());
    return SAT.frames.tanDeproject(s.xi, s.eta, fr.raDeg, fr.decDeg);
  }

  /** What is under (x, y): a marker within 8 px (the contract), else the nearest
   *  trail within 7 px — anywhere along its length. Returns {id, t} or null. */
  function hitTest(x, y) {
    var best = null, bestD = 8, i;
    for (i = 0; i < markerHits.length; i++) {
      var d = Math.hypot(markerHits[i].x - x, markerHits[i].y - y);
      if (d <= bestD) { bestD = d; best = { id: markerHits[i].id, t: null }; }
    }
    if (best) return best;
    if (!cfg().tracks) return null;
    bestD = 7;
    for (i = 0; i < trails.length; i++) {
      if (!trails[i].pts.length) continue;
      var nr = nearestOnTrail(trails[i], x, y);
      if (nr.d <= bestD) { bestD = nr.d; best = { id: trails[i].cr.satId, t: nr.t }; }
    }
    return best;
  }

  function crossingById(id) {
    for (var i = 0; i < trails.length; i++) if (trails[i].cr.satId === id) return trails[i];
    return null;
  }

  /** The hover card: everything about the trail under the cursor that one would
   *  compare with a streak — when, how fast, at what angle, how long, how bright. */
  function showTip() {
    if (!elTip) return;
    var tr = hover.id ? crossingById(hover.id) : null;
    if (!tr) { elTip.style.display = 'none'; return; }
    var cr = tr.cr, U = SAT.util, o = SAT.state.obs;
    var mount = o.track === 'mount';
    var rate = mount ? cr.rateMountAsPerS : cr.rateAsPerS;
    var pa = mount ? cr.paMountDeg : cr.paDeg;
    var lines = [];
    lines.push(U.el('div', null, [
      U.el('span', { class: 'sw', style: 'background:' + tr.col }),
      U.el('b', null, satLabel(cr)),
      U.el('span', { class: 'dim' }, '  ' + (TYPE_NAME[cr.type] || 'unknown') +
        (cr.cls ? ' · ' + String(cr.cls).toUpperCase() : '')),
    ]));
    if (cr.tEnterMs != null && cr.tExitMs != null) {
      lines.push(U.el('div', null, 'in field ' + fmtClock(cr.tEnterMs) + ' → ' + fmtClock(cr.tExitMs) +
        '  (' + ((cr.tExitMs - cr.tEnterMs) / 1000).toFixed(cr.tExitMs - cr.tEnterMs < 10000 ? 2 : 1) + ' s)'));
    }
    if (hover.t != null) lines.push(U.el('div', { class: 'acc' }, 'here at ' + fmtClock(hover.t, 2) + ' UTC'));
    var motion = [];
    if (isFinite(rate)) motion.push(rate.toFixed(rate < 100 ? 1 : 0) + '″/s');
    if (isFinite(pa)) motion.push('PA ' + pa.toFixed(1) + '°');
    if (tr.len > 0 && curScale > 0) motion.push('trail ' + U.fmtAngle(tr.len / curScale, 2));
    if (motion.length) lines.push(U.el('div', null, motion.join('  ·  ') + (mount ? '  (on the detector)' : '')));
    var phys = [];
    if (cr.magEst != null && isFinite(cr.magEst)) phys.push('mag ' + cr.magEst.toFixed(1) + (cr.magMethod ? ' (' + cr.magMethod + ')' : ''));
    if (isFinite(cr.rangeKm)) phys.push(Math.round(cr.rangeKm) + ' km');
    if (cr.shadow) phys.push(cr.shadow === 'none' ? 'sunlit' : cr.shadow);
    if (phys.length) lines.push(U.el('div', { class: 'dim' }, phys.join('  ·  ')));
    if (isFinite(cr.tleAgeDays)) {
      lines.push(U.el('div', { class: cr.tleAgeDays > 3 ? 'warn' : 'dim' },
        'elements ' + (cr.tleAgeDays < 1 ? (cr.tleAgeDays * 24).toFixed(1) + ' h' : cr.tleAgeDays.toFixed(1) + ' d') +
        ' old' + (isFinite(cr.tleSlopDeg) ? '  ·  ±' + U.fmtAngle(cr.tleSlopDeg, 1) + ' expected' : '')));
    }
    while (elTip.firstChild) elTip.removeChild(elTip.firstChild);
    lines.forEach(function (n) { elTip.appendChild(n); });
    elTip.style.display = 'block';
    // beside the cursor, flipped to stay inside the view
    var w = elTip.offsetWidth || 260, h = elTip.offsetHeight || 110;
    var x = mouse.x + 16, y = mouse.y + 16;
    if (x + w > cssW - 4) x = mouse.x - w - 12;
    if (y + h > cssH - 4) y = mouse.y - h - 12;
    elTip.style.left = Math.max(4, x) + 'px';
    elTip.style.top = Math.max(4, y) + 'px';
  }

  function setHover(id, tMs) {
    var changed = hover.id !== id;
    hover.id = id; hover.t = tMs;
    if (!id && elTip) elTip.style.display = 'none';
    if (changed) requestRender();
    else if (id) showTip();
  }

  /** Re-aim the pointing at the sky position under (x, y). Returns true when a
   *  pointing was written. centre:true also zeroes the pan, so the new pointing
   *  lands in the middle of the window — the double-click flow is "drag somewhere
   *  interesting, double-click it", and leaving the old pan offset in place would
   *  put the freshly aimed field back off in a corner. */
  function reAimAt(x, y, centre) {
    var rd = cursorSky(x, y);
    if (!rd) return false;
    var patch = { raDeg: rd.raDeg, decDeg: rd.decDeg };
    // In alt/az mode the RA/Dec fields alone would be ignored by everything that
    // reads the pointing, so carry the re-aim across to az/el as well — otherwise
    // the re-aim would silently do nothing on a parked mount.
    if (SAT.state.obs.mode === 'altaz') {
      var loc = SAT.state.activeLocation();
      if (loc) {
        try {
          var aa = SAT.prop.siteRaDecToAltAz(loc, rd.raDeg, rd.decDeg,
            SAT.clock ? SAT.clock.getDate() : new Date(),
            { refract: true, dut1S: SAT.state.obs.dut1S });
          if (aa) { patch.azDeg = aa.azDeg; patch.elDeg = aa.elDeg; }
        } catch (e) { /* leave az/el alone rather than write nonsense */ }
      }
    }
    SAT.state.setObs(patch);         // marks the scan stale, which a re-aim must
    if (centre) { view.panX = 0; view.panY = 0; }
    invalidateStars();
    requestRender();
    return true;
  }

  function handleClick(x, y, shift) {
    if (shift) {
      reAimAt(x, y, false);          // shift-click re-aims but keeps the view still
      return;
    }
    var hit = hitTest(x, y);
    try { SAT.state.clickSelect(hit ? hit.id : null); } catch (e) { /* ignore */ }
  }

  function setRuler(on) {
    ruler.on = !!on;
    if (!ruler.on) { ruler.a = null; ruler.b = null; ruler.dragging = false; }
    if (canvas) canvas.style.cursor = 'crosshair';
    updateToolbar();
    requestRender();
  }

  function onDragMove(e) {
    if (!drag) return;
    var pt = evtPos(e);
    if (Math.abs(pt.x - drag.sx) + Math.abs(pt.y - drag.sy) > 3) drag.moved = true;
    if (drag.ruler) {
      var rd = cursorSky(pt.x, pt.y);
      if (rd) ruler.b = rd;
    } else {
      view.panX += pt.x - drag.lx;
      view.panY += pt.y - drag.ly;
    }
    drag.lx = pt.x; drag.ly = pt.y;
    requestRender();
    e.preventDefault();
  }

  function onDragUp() {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragUp);
    var d = drag;
    drag = null;
    if (canvas) canvas.style.cursor = 'crosshair';
    if (!d) return;
    if (d.ruler) {
      ruler.dragging = false;
      if (!d.moved) { ruler.a = null; ruler.b = null; }   // a bare click clears the line
      requestRender();
      return;
    }
    if (!d.moved) handleClick(d.lx, d.ly, d.shift);
  }

  function wireInput() {
    canvas.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      var pt = evtPos(e);
      if (canvas.focus) { try { canvas.focus(); } catch (err) { /* not focusable */ } }
      drag = { sx: pt.x, sy: pt.y, lx: pt.x, ly: pt.y, moved: false, shift: e.shiftKey,
        ruler: ruler.on && !e.shiftKey };
      if (drag.ruler) {
        var rd = cursorSky(pt.x, pt.y);
        ruler.a = rd; ruler.b = rd; ruler.dragging = true;
        setHover(null, null);
      } else canvas.style.cursor = 'grabbing';
      window.addEventListener('mousemove', onDragMove);
      window.addEventListener('mouseup', onDragUp);
      e.preventDefault();
    });

    // Double-click = re-aim (round-3 review): drag somewhere, double-click a spot,
    // and that spot becomes the new pointing, centred. Fit-to-window is the Fit
    // button (or F).
    canvas.addEventListener('dblclick', function (e) {
      if (ruler.on) return;
      var pt = evtPos(e);
      reAimAt(pt.x, pt.y, true);
      e.preventDefault();
    });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 33;
      else if (e.deltaMode === 2) dy *= cssH;
      var pt = evtPos(e);
      zoomAt(pt.x, pt.y, Math.exp(-dy * 0.0015));
    }, { passive: false });

    canvas.addEventListener('mousemove', function (e) {
      var pt = evtPos(e);
      mouse.x = pt.x; mouse.y = pt.y; mouse.inside = true;
      if (drag) return;
      var rd = cursorSky(pt.x, pt.y);
      if (!rd) { elCursor.textContent = '—'; return; }
      var txt = 'RA ' + SAT.util.fmtRA(rd.raDeg) + '  Dec ' + SAT.util.fmtDec(rd.decDeg);
      var loc = SAT.state.activeLocation();
      if (loc) {
        try {
          var aa = SAT.prop.siteRaDecToAltAz(loc, rd.raDeg, rd.decDeg,
            SAT.clock ? SAT.clock.getDate() : new Date(),
            { refract: true, dut1S: SAT.state.obs.dut1S });
          var orb = SAT.prop.isOrbitSite(loc);
          if (aa) {
            txt += '  ·  ' + (orb ? 'AzL ' : 'Az ') + aa.azDeg.toFixed(2) +
              '°  ' + (orb ? 'ElL ' : 'El ') + aa.elDeg.toFixed(2) + '°';
          }
        } catch (err) { /* readout degrades to RA/Dec only */ }
      }
      var hit = ruler.on ? null : hitTest(pt.x, pt.y);
      if (!hit) {
        var sa = starAt(pt.x, pt.y, 7);
        if (sa) txt += '  ·  ★ ' + (sa.name ? sa.name + '  ' : '') + 'V ' + sa.mag.toFixed(2);
      }
      elCursor.textContent = txt;
      if (ruler.on) { setHover(null, null); return; }
      canvas.style.cursor = hit ? 'pointer' : 'crosshair';
      setHover(hit ? hit.id : null, hit ? hit.t : null);
    });

    canvas.addEventListener('mouseleave', function () {
      mouse.inside = false;
      elCursor.textContent = '—';
      setHover(null, null);
    });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // Keys, while the chart has focus (it takes focus on click).
    canvas.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var k = e.key;
      if (k === 'f' || k === 'F') fitView();
      else if (k === 'r' || k === 'R') setRuler(!ruler.on);
      else if (k === 'l' || k === 'L') toggleLayer('labels');
      else if (k === 't' || k === 'T') toggleLayer('tracks');
      else if (k === '+' || k === '=') zoomAt(cssW / 2, cssH / 2, 1.25);
      else if (k === '-' || k === '_') zoomAt(cssW / 2, cssH / 2, 0.8);
      else if (k === 'Escape') {
        if (ruler.on) setRuler(false);
        else { try { SAT.state.setSelection(null); } catch (err) { /* ignore */ } }
      } else return;
      e.preventDefault();
    });
  }

  // ---- timeline input --------------------------------------------------------

  function tlScrub(x) {
    if (!tlRange || !SAT.clock || !SAT.clock.setDate) return;
    var f = SAT.util.clamp((x - tlRange.x0) / (tlRange.x1 - tlRange.x0), 0, 1);
    SAT.clock.setDate(new Date(Math.round(tlRange.t0 + f * (tlRange.t1 - tlRange.t0))));
    requestRender();
  }

  function onTlMove(e) {
    if (!tlDrag) return;
    tlScrub(evtPos(e, tcanvas).x);
    e.preventDefault();
  }

  function onTlUp() {
    window.removeEventListener('mousemove', onTlMove);
    window.removeEventListener('mouseup', onTlUp);
    tlDrag = null;
    requestRender();
  }

  /** The strip is one slider: a press anywhere takes the thumb there and a drag
   *  carries it, on or off the strip, until release. */
  function wireTimeline() {
    tcanvas.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      tlDrag = { sx: evtPos(e, tcanvas).x };
      tlScrub(tlDrag.sx);
      window.addEventListener('mousemove', onTlMove);
      window.addEventListener('mouseup', onTlUp);
      e.preventDefault();
    });
    tcanvas.addEventListener('mousemove', function () {
      mouse.inside = false;
      if (hover.id) { hover.id = null; hover.t = null; }
      if (!tlHover) { tlHover = true; requestRender(); }
    });
    tcanvas.addEventListener('mouseleave', function () {
      if (tlHover) { tlHover = false; requestRender(); }
    });
  }

  // ---- plumbing ------------------------------------------------------------

  function sizeCanvas(cv, host) {
    var r = host.getBoundingClientRect();
    var w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    var d = window.devicePixelRatio || 1;
    if (cv._w === w && cv._h === h && cv._d === d) return null;
    cv._w = w; cv._h = h; cv._d = d;
    cv.width = Math.round(w * d);
    cv.height = Math.round(h * d);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    return { w: w, h: h, d: d };
  }

  function resize() {
    if (!viewEl || !canvas) return;
    var a = sizeCanvas(canvas, viewEl);
    if (a) { cssW = a.w; cssH = a.h; dpr = a.d; invalidateStars(); }
    var b = (tcanvas && timeEl && cfg().timeline) ? sizeCanvas(tcanvas, timeEl) : null;
    if (b) { tlW = b.w; tlH = b.h; }
    if (a || b) requestRender();
  }

  function injectStyle() {
    if (document.getElementById('chart-style')) return;
    var s = document.createElement('style');
    s.id = 'chart-style';
    s.textContent =
      '.chart-root{position:absolute;left:0;top:0;right:0;bottom:0;display:flex;' +
        'flex-direction:column;background:#0a0e13;}' +
      '.chart-bar{flex:0 0 auto;display:flex;align-items:center;gap:4px;padding:4px 6px;' +
        'border-bottom:1px solid var(--border);background:var(--bg2);white-space:nowrap;' +
        'overflow:hidden;user-select:none;}' +
      '.chart-bar .sep{flex:0 0 1px;height:16px;background:var(--border);margin:0 4px;}' +
      '.chart-bar .lbl{font-size:11px;color:var(--fg-dim);margin-right:2px;}' +
      '.chart-bar select{background:var(--bg3);color:var(--fg);border:1px solid var(--border);' +
        'border-radius:4px;font:11px ' + MONO + ';padding:2px 4px;}' +
      '.chart-tbtn{min-width:26px;padding:2px 8px;}' +
      '.chart-tbtn.chart-on{border-color:var(--accent-dim);color:var(--accent);' +
        'background:rgba(79,195,247,.10);}' +
      '.chart-zoom{min-width:46px;font-family:' + MONO + ';}' +
      '.chart-view{flex:1 1 auto;position:relative;min-height:0;overflow:hidden;}' +
      '.chart-canvas{position:absolute;left:0;top:0;display:block;cursor:crosshair;outline:none;}' +
      '.chart-time{flex:0 0 36px;position:relative;border-top:1px solid var(--border);' +
        'background:#0c1116;overflow:hidden;}' +
      '.chart-time canvas{position:absolute;left:0;top:0;display:block;cursor:ew-resize;}' +
      '.chart-status{flex:0 0 auto;display:flex;justify-content:space-between;gap:14px;' +
        'padding:3px 8px;font:11px ' + MONO + ';font-variant-numeric:tabular-nums;' +
        'color:var(--fg-dim);border-top:1px solid var(--border);background:var(--bg2);' +
        'white-space:nowrap;overflow:hidden;}' +
      '.chart-status .chart-hud{color:var(--fg);overflow:hidden;text-overflow:ellipsis;}' +
      '.chart-status .chart-cur{flex:0 0 auto;}' +
      '.chart-status .chart-stale{flex:0 1 auto;color:#ffb84f;overflow:hidden;text-overflow:ellipsis;}' +
      '.chart-status .chart-stale:empty{display:none;}' +
      '.chart-pop{position:absolute;z-index:20;top:31px;left:6px;display:none;' +
        'background:var(--bg2);border:1px solid var(--border);border-radius:6px;' +
        'padding:7px 12px 7px 9px;box-shadow:0 10px 28px rgba(0,0,0,.55);font-size:12px;}' +
      '.chart-pop label{display:flex;align-items:center;gap:7px;padding:2px 0;cursor:pointer;' +
        'color:var(--fg);white-space:nowrap;}' +
      '.chart-pop .grp{margin-top:5px;padding-top:5px;border-top:1px solid var(--border);}' +
      '.chart-pop .keys{margin-top:6px;padding-top:6px;border-top:1px solid var(--border);' +
        'color:var(--fg-dim);font:10px ' + MONO + ';line-height:1.6;}' +
      '.chart-tip{position:absolute;z-index:15;display:none;pointer-events:none;' +
        'background:rgba(14,19,25,.95);border:1px solid var(--border);border-radius:6px;' +
        'padding:6px 10px;font:11px/1.55 ' + MONO + ';color:var(--fg);white-space:nowrap;' +
        'box-shadow:0 8px 22px rgba(0,0,0,.5);font-variant-numeric:tabular-nums;}' +
      '.chart-tip b{font:600 12px -apple-system,"Helvetica Neue",Arial,sans-serif;}' +
      '.chart-tip .dim,.chart-ruler .dim{color:var(--fg-dim);}' +
      '.chart-tip .acc{color:var(--accent);}' +
      '.chart-tip .warn{color:var(--warn);}' +
      '.chart-tip .sw,.chart-ruler .sw{display:inline-block;width:8px;height:8px;' +
        'margin-right:6px;border-radius:1px;vertical-align:baseline;}' +
      '.chart-ruler{position:absolute;z-index:14;top:8px;right:8px;display:none;' +
        'background:rgba(14,19,25,.93);border:1px solid var(--border);border-radius:6px;' +
        'padding:6px 10px;font:11px/1.6 ' + MONO + ';color:var(--fg);white-space:nowrap;' +
        'font-variant-numeric:tabular-nums;}' +
      '.chart-ruler-head{color:#fff;margin-bottom:2px;}' +
      '.chart-ruler-row{cursor:pointer;display:flex;align-items:center;gap:8px;' +
        'justify-content:space-between;}' +
      '.chart-ruler-row:hover .nm{color:var(--accent);}' +
      '.chart-ruler-row .nm{flex:1 1 auto;}';
    document.head.appendChild(s);
  }

  // The layer list, in the order the menu shows it. `null` starts a new group.
  var LAYERS = [
    ['labels', 'Satellite names', 'L'],
    ['tracks', 'Satellite tracks', 'T'],
    ['ticks', 'Time ticks on tracks'],
    ['legend', 'Colour key'],
    null,
    ['stars', 'Stars'],
    ['starTrails', 'Star trails (parked mount)'],
    ['starNames', 'Star names (fields over 5°)'],
    ['constLines', 'Constellation lines (fields over 5°)'],
    ['constNames', 'Constellation names (fields over 5°)'],
    ['sunMoon', 'Sun and Moon'],
    ['grid', 'RA/Dec grid'],
    null,
    ['timeline', 'Timeline'],
  ];
  // Every manual star limit is exactly deliverable (round 17): 10.5 is the bundled
  // catalogue's full depth, 13 the deep tiles'.
  var MAG_STEPS = [4.5, 6, 7.5, 9, 10.5, 13];

  function toggleLayer(key) {
    var c = cfg();
    c[key] = !c[key];
    try { SAT.state.save(); } catch (e) { /* ignore */ }
    if (key === 'timeline') applyTimelineVisibility();
    updateToolbar();
    requestRender();
  }

  function applyTimelineVisibility() {
    if (!timeEl) return;
    timeEl.style.display = cfg().timeline ? '' : 'none';
    if (tcanvas) tcanvas._w = -1;        // force a re-measure when it comes back
    resize();
  }

  function showPop(on) {
    if (!elPop) return;
    elPop.style.display = on ? 'block' : 'none';
    if (toolBtns.layers) toolBtns.layers.classList.toggle('chart-on', !!on);
  }

  function buildToolbar() {
    var U = SAT.util;
    function tbtn(key, label, title, onclick, cls) {
      var b = U.el('button', {
        class: 'btn small chart-tbtn' + (cls ? ' ' + cls : ''), title: title, onclick: onclick,
      }, label);
      if (key) toolBtns[key] = b;
      return b;
    }
    function sep() { return U.el('span', { class: 'sep' }); }

    // ---- Layers menu: every drawable layer by its full name ----
    var rows = [], grp = true;
    LAYERS.forEach(function (L) {
      if (!L) { grp = true; return; }
      var box = U.el('input', { type: 'checkbox' });
      box.addEventListener('change', function () { toggleLayer(L[0]); });
      layerChecks[L[0]] = box;
      rows.push(U.el('label', { class: grp && rows.length ? 'grp' : null },
        [box, L[1] + (L[2] ? '   (' + L[2] + ')' : '')]));
      grp = false;
    });
    rows.push(U.el('div', { class: 'keys' },
      'F fit · +/− zoom · R ruler · Esc clear'));
    elPop = U.el('div', { class: 'chart-pop' }, rows);

    // ---- star depth ----
    elMag = U.el('select', {
      title: 'faintest star drawn — Auto keeps about the same number of stars on screen ' +
        'at any field: V 13 up to 8°, shallower beyond',
    }, [(elMagAuto = U.el('option', { value: 'auto' }, 'auto'))].concat(MAG_STEPS.map(function (m) {
      return U.el('option', { value: String(m) }, 'V ' + m);
    })));
    elMag.addEventListener('change', function () {
      var c = cfg(), v = elMag.value;
      if (v === 'auto') c.magAuto = true;
      else { c.magAuto = false; c.magLimit = parseFloat(v); }
      invalidateStars();
      try { SAT.state.save(); } catch (e) { /* ignore */ }
      requestRender();
    });

    elZoom = tbtn('zoom', '100%', 'zoom relative to the fitted field — click to fit (F)', fitView,
      'chart-zoom');
    elMirror = tbtn('mirror', 'Mirror E/W',
      'mirror the chart east/west — an optical train with an odd number of reflections',
      function () {
        // flipEW lives in obs, so this routes through setObs and marks the scan
        // stale. Conservative — a mirror changes no sky geometry — but setObs is the
        // single mutator and splitting display flags out of obs is not this file's
        // decision to make.
        SAT.state.setObs({ flipEW: !SAT.state.obs.flipEW });
      });

    var bar = U.el('div', { class: 'chart-bar' }, [
      tbtn('layers', 'Layers ▾', 'choose what is drawn',
        function () { showPop(elPop.style.display !== 'block'); }),
      sep(),
      U.el('span', { class: 'lbl' }, 'Stars'), elMag,
      sep(),
      tbtn('ruler', 'Ruler',
        'measure a streak: drag along it to get its length and position angle, ' +
        'and the predicted trails that match it best (R)',
        function () { setRuler(!ruler.on); }),
      sep(),
      tbtn(null, '−', 'zoom out (−)', function () { zoomAt(cssW / 2, cssH / 2, 0.8); }),
      elZoom,
      tbtn(null, '+', 'zoom in (+)', function () { zoomAt(cssW / 2, cssH / 2, 1.25); }),
      tbtn(null, 'Fit', 'fit the field to the window (F)', fitView),
      sep(),
      elMirror,
    ]);
    return bar;
  }

  function updateToolbar() {
    var c = cfg();
    // a pinned limit that is not one of the deliverable steps (a saved m11 from
    // before round 17) is read as auto
    if (!c.magAuto && MAG_STEPS.indexOf(c.magLimit) < 0) c.magAuto = true;
    Object.keys(layerChecks).forEach(function (k) { layerChecks[k].checked = !!c[k]; });
    if (elMag) elMag.value = c.magAuto ? 'auto' : String(c.magLimit);
    if (toolBtns.ruler) toolBtns.ruler.classList.toggle('chart-on', !!ruler.on);
    if (elMirror) elMirror.classList.toggle('chart-on', !!SAT.state.obs.flipEW);
  }

  function init(bodyEl, win) {
    body = bodyEl;
    winRef = win;
    if (win) win.noScroll = true;
    injectStyle();
    var U = SAT.util;

    canvas = document.createElement('canvas');
    canvas.className = 'chart-canvas';
    canvas.setAttribute('tabindex', '0');
    ctx = canvas.getContext('2d');
    tcanvas = document.createElement('canvas');
    tctx = tcanvas.getContext('2d');

    elTip = U.el('div', { class: 'chart-tip' });
    elRuler = U.el('div', { class: 'chart-ruler' });
    elHud = U.el('div', { class: 'chart-hud' }, '');
    elCursor = U.el('div', { class: 'chart-cur' }, '—');
    elStale = U.el('div', { class: 'chart-stale' }, '');

    var bar = buildToolbar();
    viewEl = U.el('div', { class: 'chart-view' }, [canvas, elTip, elRuler]);
    timeEl = U.el('div', { class: 'chart-time' }, [tcanvas]);
    var root = U.el('div', { class: 'chart-root' }, [
      bar, viewEl, timeEl,
      U.el('div', { class: 'chart-status' }, [elCursor, elStale, elHud]),
      elPop,
    ]);
    body.appendChild(root);

    updateToolbar();
    wireInput();
    wireTimeline();
    // the Layers menu closes on any press outside it
    if (document.addEventListener) {
      document.addEventListener('mousedown', function (e) {
        if (!elPop || elPop.style.display !== 'block') return;
        var tgt = e.target;
        if ((elPop.contains && elPop.contains(tgt)) ||
            (toolBtns.layers && toolBtns.layers.contains && toolBtns.layers.contains(tgt))) return;
        showPop(false);
      });
    }

    body.addEventListener('win-resize', resize);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(body);
    applyTimelineVisibility();
    resize();

    // In alt/az mode the tangent point is a function of time, so every tick moves the
    // star field even when nothing else changed — the cache check below absorbs the
    // small steps and re-queries only when the field has really moved.
    SAT.bus.on('time', requestRender);
    SAT.bus.on('obs-changed', function () { invalidateStars(); updateToolbar(); requestRender(); });
    SAT.bus.on('scan-done', requestRender);
    SAT.bus.on('filters-changed', requestRender);
    SAT.bus.on('selection-changed', requestRender);
    SAT.bus.on('settings-changed', function () {
      invalidateStars(); updateToolbar(); requestRender();
    });
    SAT.bus.on('catalog-changed', requestRender);
    SAT.bus.on('locations-changed', function () { invalidateStars(); requestRender(); });
    SAT.bus.on('state-loaded', function () {
      invalidateStars(); applyTimelineVisibility(); updateToolbar(); fitView();
    });
    requestRender();
  }

  SAT.chart = {
    init: init, requestRender: requestRender, fitView: fitView,
    // Rounds 14/15: the adaptive star-depth law and the Stellarium-derived
    // dot law, pure and public — the CONTRACT documents both and
    // tools/test_chart.js pins their anchor points.
    autoMagLimit: autoMagLimit,
    starDot: starDot,
    // Round 20: the marker-label format ('NAME [NORAD]', always decimal digits
    // — Alpha-5 is decoded server-side), pure and pinned by tools/test_chart.js.
    satLabel: satLabel,
    // Round 22, pure and unit-tested: trail time ticks, the timeline's axis, and
    // the ruler's streak matching.
    tickStepS: tickStepS,
    tickLabel: tickLabel,
    timelineStepS: timelineStepS,
    lineAngleDiff: lineAngleDiff,
    rankTrails: rankTrails,
    circTanDeg: circTanDeg,
    applyStarBudget: applyStarBudget,
    _starAt: starAt,
    // Pure geometry, exported for tools/test_chart.js. The orientation transform is
    // the one piece of this file that can be — and must be — verified without a
    // browser; everything else is paint.
    _makeTransform: makeTransform,
    _skyToScreen: skyToScreen,
    _screenToSky: screenToSky,
    _axisDirs: axisDirs,
    _gridStepDeg: gridStepDeg,
    _pathPosAt: pathPosAt,
    _extTrackOf: extTrackOf,
    _extPosAt: extPosAt,
    _lerpAngle: lerpAngle,
    _lerpFrame: lerpFrame,
    _nearestOnTrail: nearestOnTrail,
    _fmtClock: fmtClock,
  };
})();
