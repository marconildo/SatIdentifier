#!/usr/bin/env python3
"""Verification for tools/make_starcat.py's bright-star astrometry (round 23).

No network: Hipparcos rows are fixtures. Covers the parser, the proper-motion
propagation, the 0.01-deg lattice test that recognises a star taken whole from
starcat.js, refine_bright() itself (moves those, leaves Gaia's stars alone, is
idempotent), and the in-place file repair — including that it re-sorts by
declination, which the frontend's cone query binary-searches.

Run: python3 tools/test_starcat.py
"""

import importlib.util
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("make_starcat", ROOT / "tools" / "make_starcat.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

failures = 0


def ok(name, cond, detail=""):
    global failures
    if not cond:
        failures += 1
    print(("ok - " if cond else "FAIL - ") + name + (f"  [{detail}]" if detail else ""))


# Real Hipparcos (new reduction) rows, as VizieR's asu-tsv prints them.
HIP_TSV = (
    "#Column\tHIP\n"
    "HIP\tRArad\tDErad\tpmRA\tpmDE\tHpmag\n"
    " \tdeg\tdeg\tmas/yr\tmas/yr\tmag\n"
    "------\t------------\t------------\t--------\t--------\t-------\n"
    " 69673\t213.91811403\t+19.18726997\t-1093.39\t-2000.06\t 0.1114\n"   # Arcturus
    " 91262\t279.23410832\t+38.78299311\t  200.94\t  286.23\t 0.0868\n"   # Vega
    " 24436\t 78.63446353\t -8.20163919\t    1.31\t    0.50\t 0.1930\n"   # Rigel
    " 99999\t 10.00000000\t+10.00000000\t        \t        \t 4.0000\n"   # blank PM
    "\n"
)

print("[1] parse_hipparcos")
hip = m.parse_hipparcos(HIP_TSV)
ok("four data rows, header/units/rule skipped", len(hip) == 4, str(len(hip)))
ok("values parsed", abs(hip[0][0] - 213.91811403) < 1e-9 and hip[0][3] == -2000.06 and
   abs(hip[0][4] - 0.1114) < 1e-9)
ok("blank proper motion reads as zero", hip[3][2] == 0.0 and hip[3][3] == 0.0)
ok("an HTML error page yields nothing", m.parse_hipparcos("<html>Page unavailable</html>") == [])

print("\n[2] hip_place — proper motion carried from 1991.25")
# Arcturus, SIMBAD J2000: 213.91530029 +19.18240916
ra, de = m.hip_place(hip[0], 2000.0)
off = m.sep_arcsec(ra, de, 213.91530029, 19.18240916)
ok("Arcturus carried to J2000 lands on its J2000 place", off < 0.05, f'{off:.3f}"')
ra26, de26 = m.hip_place(hip[0], 2026.5)
moved = m.sep_arcsec(ra, de, ra26, de26)
ok("and moves 60.4 arcsec in the 26.5 years after", abs(moved - 60.4) < 0.3, f'{moved:.2f}"')
ok("a star without proper motion stays put", m.hip_place(hip[3], 2026.5) == (10.0, 10.0))

print("\n[3] on_lattice — the starcat.js signature")
import struct
f32 = lambda v: struct.unpack("<f", struct.pack("<f", v))[0]
ok("0.01-deg multiples are recognised after a float32 round trip",
   all(m.on_lattice(f32(v)) for v in (213.92, 19.18, 359.99, -16.72, 0.0, 78.63)))
ok("ordinary coordinates are not", not any(m.on_lattice(v) for v in (213.91811, 19.18727, 78.6345)))

print("\n[4] refine_bright")
stars = [
    (213.92, 19.18, -0.1),                # Arcturus as starcat.js has it: on the lattice
    (279.23, 38.78, 0.0),                 # Vega, likewise
    (78.63446, -8.20164, 0.2),            # Rigel with real astrometry: must not move
    (213.92, 19.18, 9.3),                 # a faint star that happens to sit on the lattice
    (150.00, -30.00, 4.2),                # a lattice bright star Hipparcos does not have here
]
out, fixed, missed = m.refine_bright(stars, hip, 2026.5)
ok("the two lattice bright stars with a Hipparcos match are moved", fixed == 2, str(fixed))
a = m.sep_arcsec(out[0][0], out[0][1], ra26, de26)
ok("Arcturus is at its 2026.5 place", a < 0.01, f'{a:.4f}"')
was = m.sep_arcsec(stars[0][0], stars[0][1], ra26, de26)
ok("which is where the rounded J2000 place was NOT", was > 50, f'{was:.1f}" before')
ok("magnitudes are untouched", [s[2] for s in out] == [s[2] for s in stars])
ok("a star with real astrometry is left exactly alone", out[2] == stars[2])
ok("a faint star on the lattice is left alone (not a starcat.js star)", out[3] == stars[3])
ok("an unmatched lattice bright star is reported and left alone",
   missed == [stars[4]] and out[4] == stars[4])
again, fixed2, _ = m.refine_bright(out, hip, 2026.5)
ok("idempotent: a second pass moves nothing", fixed2 == 0 and again == out)
ok("the magnitude guard refuses an implausible match",
   m.refine_bright([(213.92, 19.18, 4.5)], hip, 2026.5)[1] == 0)

print("\n[5] refine_file — in place, declination re-sorted")
with tempfile.TemporaryDirectory() as tmp:
    path = pathlib.Path(tmp) / "t.bin"
    # Vega's rounded declination (38.78) sorts BEFORE a neighbour at 38.781; its
    # true 2026.5 declination (38.7851) sorts AFTER it.
    rows = sorted([(279.23, 38.78, 0.0), (279.5, 38.781, 8.0), (10.0, -5.0, 7.0)], key=lambda s: s[1])
    m.write_tile(rows, path, 10.5)
    fixed, missed = m.refine_file(path, hip, 2026.5)
    got, lim = m.read_str1(path)
    ok("one star moved, none missed", fixed == 1 and not missed)
    ok("header limit preserved", abs(lim - 10.5) < 1e-6)
    ok("still sorted by declination", all(got[i][1] <= got[i + 1][1] for i in range(len(got) - 1)),
       str([round(s[1], 4) for s in got]))
    ok("Vega now sorts after its neighbour", [round(s[2], 1) for s in got] == [7.0, 8.0, 0.0],
       str([s[2] for s in got]))
    before = path.read_bytes()
    fixed, _ = m.refine_file(path, hip, 2026.5)
    ok("a second run leaves the file byte-identical", fixed == 0 and path.read_bytes() == before)
    ok("no temporary file left behind", not list(pathlib.Path(tmp).glob("*.tmp")))

print()
if failures:
    print(f"{failures} CHECK(S) FAILED")
    sys.exit(1)
print("all checks passed")
