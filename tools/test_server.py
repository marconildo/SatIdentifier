#!/usr/bin/env python3
"""Verification for server.py's catalogue fetching (round 21).

Runs with NO network: http_get is stubbed with fixtures, and the disk cache is
pointed at a temp directory. Covers /api/celestrak/full — the catalogue
assembled from launch-decade gp.php queries (round 22), CelesTrak's
one-download-per-update rule, stop-on-first-error with resume, stale-cache
serving —
plus the Alpha-5 round trip that keeps 6-digit NORAD ids honest.

Run: python3 tools/test_server.py
"""

import importlib.util
import pathlib
import sys
import tempfile
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("server", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

failures = 0


def ok(name, cond, detail=""):
    global failures
    if cond:
        print(f"ok - {name}")
    else:
        failures += 1
        print(f"FAIL - {name}" + (f"  [{detail}]" if detail else ""))


# ---------------------------------------------------------------- network stub
# URL -> bytes, or an Exception instance to raise. Anything not listed raises
# HTTP 403 (CelesTrak's block behaviour, the case that prompted this harness).
FIXTURES = {}


def fake_http_get(url, opener=None):
    v = FIXTURES.get(url)
    if v is None:
        raise urllib.error.HTTPError(url, 403, "Forbidden", None, None)
    if isinstance(v, Exception):
        raise v
    return v


server.http_get = fake_http_get
TMP = tempfile.TemporaryDirectory()
server.CACHE_DIR = pathlib.Path(TMP.name)

server.CELESTRAK_PAUSE_S = 0
CALLS = []                      # every URL the code under test requested
_real_fake = fake_http_get


def counting_http_get(url, opener=None):
    CALLS.append(url)
    return _real_fake(url, opener)


server.http_get = counting_http_get


def gp(query):
    return server.CELESTRAK_GP_CSV_URL.format(query=query)


def http_403(url, body):
    import io
    return urllib.error.HTTPError(url, 403, "Forbidden", None,
                                  io.BytesIO(body.encode()))


CSV_HEAD = (
    "OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,"
    "RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,"
    "CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,"
    "MEAN_MOTION_DOT,MEAN_MOTION_DDOT\n")


def row(name, intl, norad):
    return (f"{name},{intl},2026-08-07T12:00:00.000000,14.2,0.001,97.5,10.0,"
            f"20.0,30.0,0,U,{norad},999,100,0.0001,0.00001,0\n")

OMM_CSV = (
    "OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,"
    "RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,"
    "CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,"
    "MEAN_MOTION_DOT,MEAN_MOTION_DDOT\n"
    "ISS (ZARYA),1998-067A,2026-08-07T12:00:00.000000,15.50103472,0.0003456,"
    "51.6416,247.4627,130.5360,325.0288,0,U,25544,999,50000,0.000034,"
    "0.0000123,0\n"
    "OBJECT AA,2026-190A,2026-08-07T06:30:00.500000,14.2,0.001,97.5,10.0,"
    "20.0,30.0,0,U,100057,999,100,0.0001,0.00001,0\n"
)

TLE_TXT = (
    "ISS (ZARYA)\n"
    "1 25544U 98067A   26219.51782528  .00016717  00000+0  10270-3 0  9992\n"
    "2 25544  51.6392 339.0967 0004272  82.5714 277.5709 15.50136786 12345\n"
)

SATCAT_CSV = (
    "OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,"
    "LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,"
    "RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE\n"
    "ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TYMSC,,92.9,51.6,"
    "420,410,399.1,,EA,ORB\n"
)

print("[1] parse_omm_csv — the modern-format full catalogue")
tles = server.parse_omm_csv(OMM_CSV)
ok("two rows parsed", len(tles) == 2, repr(tles)[:120])
ok("integer NORAD ids, 6-digit intact",
   [t["norad"] for t in tles] == [25544, 100057])
l1 = tles[1]["l1"]
ok("6-digit object synthesizes an Alpha-5 line 1", l1.startswith("1 A0057U"), l1)
ok("Alpha-5 field decodes back to the true id",
   server.catnum(l1[2:7]) == 100057)
ok("checksums are recomputed",
   all(t[k][-1] == server._tle_checksum(t[k][:-1]) for t in tles
       for k in ("l1", "l2")))
ok("HTML error page yields [], not junk objects",
   server.parse_omm_csv("<!DOCTYPE html><html>403</html>") == [])
ok("a TLE file yields [] (falls through to parse_tles)",
   server.parse_omm_csv(TLE_TXT) == [])

print("\n[2] /api/celestrak/full — assembled from launch-decade queries")
PARTS = server.celestrak_full_parts(now=1794700000)        # 2026-11
ok("one INTDES prefix per decade since the 1950s, then the analyst group",
   [q for _, q in PARTS] == ["INTDES=195", "INTDES=196", "INTDES=197",
                             "INTDES=198", "INTDES=199", "INTDES=200",
                             "INTDES=201", "INTDES=202", "GROUP=analyst"],
   repr(PARTS))
ok("the decade list grows by itself in 2030",
   ("2030s", "INTDES=203") in server.celestrak_full_parts(now=1900000000))
ok("the blocked bulk files are gone from the code path",
   not hasattr(server, "CELESTRAK_FULL_URLS")
   and "/pub/TLE/" not in server.CELESTRAK_GP_CSV_URL)


def fill_all():
    FIXTURES.clear()
    FIXTURES[server.SATCAT_BULK_URL] = SATCAT_CSV.encode()
    for name, q in server.celestrak_full_parts():
        FIXTURES[gp(q)] = b"No GP data found"
    FIXTURES[gp("INTDES=199")] = (CSV_HEAD + row("ISS (ZARYA)", "1998-067A", 25544)).encode()
    FIXTURES[gp("INTDES=202")] = (CSV_HEAD + row("OBJECT AA", "2026-190A", 100057)).encode()
    FIXTURES[gp("GROUP=analyst")] = (CSV_HEAD + row("UNKNOWN", "", 270448)).encode()


fill_all()
CALLS.clear()
p = server.celestrak_full_payload()
NPARTS = len(server.celestrak_full_parts())
gp_calls = [u for u in CALLS if "gp.php" in u]
ok("every part requested exactly once, in order",
   gp_calls == [gp(q) for _, q in server.celestrak_full_parts()], repr(gp_calls))
ok("payload names its source", p["source"] == "celestrak:gp by launch decade",
   p["source"])
ok("objects from every part, cacheKey set",
   sorted(t["norad"] for t in p["tles"]) == [25544, 100057, 270448]
   and p["count"] == 3 and p["cacheKey"] == "celestrak_full")
ok("an analyst object with no designator survives the TLE synthesis",
   any(t["norad"] == 270448 and t["l1"].startswith("1 T0448U") for t in p["tles"]))
ok("enriched: ISS gets its SATCAT rcs/type",
   p["tles"][0]["rcs"] == 399.1 and p["tles"][0]["type"] == "PAY",
   repr({k: p["tles"][0][k] for k in ("rcs", "type")}))
ok("enrichment misses still set the keys",
   all(k in p["tles"][1] for k in ("intl", "rcs", "type", "stdMag")))
ok("qsmag failure is a note, not an error",
   any("qsmag unavailable" in n for n in p.get("notes", [])),
   repr(p.get("notes")))
ok("payload cached on disk", server.cache_read("celestrak_full") is not None)

print("\n[3] one download per update — CelesTrak's 2 h rule")
CALLS.clear()
p2 = server.celestrak_full_payload()
ok("a second load inside the cache window makes no request",
   not [u for u in CALLS if "gp.php" in u] and p2["count"] == 3)
p3 = server.celestrak_full_payload(refresh=True)
ok("Force refresh inside 2 h makes no request either, and says why",
   not [u for u in CALLS if "gp.php" in u]
   and any("updates every 2 h" in n for n in p3.get("notes", [])),
   repr(p3.get("notes")))
ok("the too-soon note is not written back into the cache",
   not any("updates every 2 h" in n
           for n in (server.cache_read("celestrak_full").get("notes") or [])))


def age_cache(seconds):
    """Make the assembled payload AND its parts look `seconds` old."""
    c = server.cache_read("celestrak_full")
    c["fetchedUnix"] -= seconds
    server.cache_write("celestrak_full", c)
    st = server.cache_read("celestrak_full_parts")
    for part in st["parts"].values():
        part["fetchedUnix"] -= seconds
    server.cache_write("celestrak_full_parts", st)


age_cache(3 * 3600)
CALLS.clear()
server.celestrak_full_payload()
ok("3 h old, no refresh: still inside the 6 h window, no request",
   not [u for u in CALLS if "gp.php" in u])
p4 = server.celestrak_full_payload(refresh=True)
ok("3 h old + Force refresh: every part re-requested",
   len([u for u in CALLS if "gp.php" in u]) == NPARTS and not p4.get("stale"))

print("\n[4] failure paths — stop on the first non-200, resume without repeats")
age_cache(7 * 3600)
fill_all()
BLOCK = ("<html><body><h2>403 - Forbidden: Access is denied</h2>"
         "<p>GP data has not updated since your last successful download of "
         "INTDES=200.</p></body></html>")
FIXTURES[gp("INTDES=200")] = http_403(gp("INTDES=200"), BLOCK)
CALLS.clear()
p5 = server.celestrak_full_payload()
gp_calls = [u for u in CALLS if "gp.php" in u]
ok("stops at the failing part — nothing after it is requested",
   gp_calls == [gp("INTDES=195"), gp("INTDES=196"), gp("INTDES=197"),
                gp("INTDES=198"), gp("INTDES=199"), gp("INTDES=200")],
   repr(gp_calls))
ok("failure with an older copy serves it flagged stale",
   p5.get("stale") is True and p5["count"] == 3)
ok("the note carries CelesTrak's own reason, tags stripped",
   any("INTDES=200: HTTP 403" in n and "has not updated since" in n
       and "<" not in n for n in p5.get("notes", [])), repr(p5.get("notes")))
fill_all()
CALLS.clear()
p6 = server.celestrak_full_payload()
gp_calls = [u for u in CALLS if "gp.php" in u]
ok("the retry resumes at the failed part — saved parts are not re-requested",
   gp_calls == [gp("INTDES=200"), gp("INTDES=201"), gp("INTDES=202"),
                gp("GROUP=analyst")], repr(gp_calls))
ok("and completes", p6["count"] == 3 and not p6.get("stale"))

server.cache_path("celestrak_full").unlink()
server.cache_path("celestrak_full_parts").unlink()
FIXTURES.clear()                       # everything 403s, nothing cached
CALLS.clear()
try:
    server.celestrak_full_payload()
    ok("no cache + failure raises ApiError", False)
except server.ApiError as e:
    ok("no cache + failure raises ApiError", e.code == 502, str(e))
    ok("exactly one request was made before giving up",
       len([u for u in CALLS if "gp.php" in u]) == 1, repr(CALLS))
    ok("the message tells the user not to hammer",
       "try again later" in e.msg and "INTDES=195" in e.msg, e.msg)
fill_all()
FIXTURES[gp("INTDES=198")] = b"<!DOCTYPE html><html>maintenance</html>"
try:
    server.celestrak_full_payload()
    ok("a non-CSV 200 reply is an error, not an empty decade", False)
except server.ApiError as e:
    ok("a non-CSV 200 reply is an error, not an empty decade",
       "INTDES=198" in e.msg and "unexpected reply" in e.msg, e.msg)

print("\n[5] parse_tles — Alpha-5 and malformed input (server side)")
t5 = server.parse_tles("OBJECT AA\n"
                       "1 A0057U 26190A   26219.50000000  .00001000  00000+0"
                       "  10000-3 0  9995\n"
                       "2 A0057  97.5000  10.0000 0010000  20.0000  30.0000"
                       " 14.20000000  1005\n")
ok("Alpha-5 TLE decodes to the integer id",
   len(t5) == 1 and t5[0]["norad"] == 100057, repr(t5)[:100])
ok("catnum5 round trip at both edges",
   server.catnum5(100000) == "A0000" and server.catnum("A0000") == 100000 and
   server.catnum5(339999) == "Z9999" and server.catnum("Z9999") == 339999)

TMP.cleanup()
print()
if failures:
    print(f"{failures} CHECK(S) FAILED")
    sys.exit(1)
print("all checks passed")
