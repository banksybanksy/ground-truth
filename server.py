#!/usr/bin/env python3
"""
Ground Truth: data fetching, aggregation, and a local server.

Python stdlib only (http.server, sqlite3, urllib). export_static.py imports
the fetch and aggregation functions here to write static/data/. Run directly,
this serves static/ plus a JSON API backed by a local SQLite cache of two
DataSF datasets and a market-rent benchmark:

  - Assessor Historical Secured Property Tax Rolls (wv5m-vpq2), roll years 2007-2025
  - Eviction Notices (5cei-gny5), 1997-present
  - Rent benchmark: Zillow ZORI (asking-rent index, by ZIP) + Apartment List
    (SF-metro bedroom mix); optional Census ACS citywide medians if a free
    CENSUS_API_KEY is set. This is EXTERNAL to DataSF, which has no rent data.

Data is fetched on demand (SODA $where filters, paged; rent CSVs downloaded
once), cached in ./data/cache.db, and re-fetched only on explicit refresh.
"""

import csv
import io
import json
import os
import re
import sqlite3
import statistics
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "cache.db")

ASSESSOR_URL = "https://data.sfgov.org/resource/wv5m-vpq2.json"
EVICTIONS_URL = "https://data.sfgov.org/resource/5cei-gny5.json"
SODA_PAGE_SIZE = 50000
SODA_TIMEOUT = 180  # seconds per page request
APP_TOKEN = os.environ.get("SODA_APP_TOKEN", "")  # optional, raises rate limits

PORT = int(os.environ.get("PORT", "8000"))

# Eviction reason flags (boolean columns) -> human labels.
EVICTION_REASONS = {
    "non_payment": "Non-payment of rent",
    "late_payments": "Habitual late payments",
    "breach": "Breach of lease",
    "nuisance": "Nuisance",
    "illegal_use": "Illegal use of unit",
    "failure_to_sign_renewal": "Failure to sign lease renewal",
    "access_denial": "Denial of access to unit",
    "unapproved_subtenant": "Unapproved subtenant",
    "owner_move_in": "Owner / relative move-in",
    "demolition": "Demolition",
    "capital_improvement": "Capital improvement",
    "substantial_rehab": "Substantial rehabilitation",
    "ellis_act_withdrawal": "Ellis Act withdrawal",
    "condo_conversion": "Condo conversion",
    "roommate_same_unit": "Roommate in same unit",
    "lead_remediation": "Lead remediation",
    "development": "Development agreement",
    "good_samaritan_ends": "Good Samaritan tenancy ends",
    "other_cause": "Other cause",
}

USE_FILTERS = {
    "res": ("SRES", "MRES"),
    "sfr": ("SRES",),
    "mfr": ("MRES",),
    "all": None,
}

# ---------------------------------------------------------------------------
# Rent benchmark sources (market ASKING rent — a separate thing from the
# assessor data, which is Prop-13 assessed value). All free, no key:
#   - Zillow ZORI (Observed Rent Index), ZIP level: current, all unit sizes.
#     No public per-bedroom or SF-neighborhood cut exists, so we map ZIPs ->
#     Analysis Neighborhoods ourselves and blend the bedroom mix from below.
#   - Apartment List: SF *metro* overall / 1BR / 2BR — supplies the bedroom
#     ratio we apply to each neighborhood's ZORI level.
# The optional per-bedroom-per-neighborhood MEASURED path (Census ACS) needs a
# free key; see census_rent() and the CENSUS_API_KEY env var.
ZORI_ZIP_URL = ("https://files.zillowstatic.com/research/public_csvs/zori/"
                "Zip_zori_uc_sfrcondomfr_sm_month.csv")
APARTMENT_LIST_PAGE = "https://www.apartmentlist.com/research/category/data-rent-estimates"
CENSUS_API_KEY = os.environ.get("CENSUS_API_KEY", "")
CENSUS_YEAR = 2023  # ACS 5-year vintage for the optional measured path

# SF ZIP -> Analysis Neighborhood(s). ZIPs and neighborhoods don't nest, so
# this is a deliberate approximation: a neighborhood averages the ZORI of the
# ZIPs it mostly sits in, and neighborhoods sharing a ZIP (e.g. Mission &
# Bernal Heights both in 94110) will read similarly. The UI says as much.
HOOD_ZIPS = {
    "Marina": ["94123"],
    "Pacific Heights": ["94115", "94123"],
    "Presidio Heights": ["94118"],
    "Russian Hill": ["94109", "94133"],
    "Nob Hill": ["94108", "94109"],
    "North Beach": ["94133"],
    "Chinatown": ["94108"],
    "Financial District/South Beach": ["94105", "94111"],
    "Tenderloin": ["94102"],
    "Hayes Valley": ["94102"],
    "South of Market": ["94103"],
    "Mission Bay": ["94158"],
    "Potrero Hill": ["94107"],
    "Mission": ["94110", "94103"],
    "Bernal Heights": ["94110"],
    "Castro/Upper Market": ["94114"],
    "Noe Valley": ["94114", "94131"],
    "Glen Park": ["94131"],
    "Twin Peaks": ["94131"],
    "Diamond Heights": ["94131"],
    "West of Twin Peaks": ["94127"],
    "Excelsior": ["94112"],
    "Outer Mission": ["94112"],
    "Oceanview/Merced/Ingleside": ["94112", "94132"],
    "Lakeshore": ["94132"],
    "Portola": ["94134"],
    "Visitacion Valley": ["94134"],
    "Bayview Hunters Point": ["94124"],
    "Haight Ashbury": ["94117"],
    "Western Addition": ["94115", "94117"],
    "Japantown": ["94115"],
    "Lone Mountain/USF": ["94118"],
    "Inner Richmond": ["94118"],
    "Outer Richmond": ["94121"],
    "Inner Sunset": ["94122"],
    "Sunset/Parkside": ["94116"],
    "Presidio": ["94129"],
}

# Every SF ZIP we track (union of the crosswalk), used for the rent heat map,
# ZIP validation, and boundary fetch. 94111 rides with FiDi in the crosswalk.
SF_ZIPS = sorted({z for zips in HOOD_ZIPS.values() for z in zips})
ZIP_RE = re.compile(r"^94\d{3}$")

# ZIP polygon source: Census TIGERweb ZCTA layer (public, no key, GeoJSON out).
TIGER_ZCTA_URL = ("https://tigerweb.geo.census.gov/arcgis/rest/services/"
                  "TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/4/query")


def is_zip(name):
    return bool(ZIP_RE.match(name or ""))

# ---------------------------------------------------------------------------
# Database

_db_init_lock = threading.Lock()
_db_initialized = False


def db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    global _db_initialized
    with _db_init_lock:
        if _db_initialized:
            return
        os.makedirs(DATA_DIR, exist_ok=True)
        conn = db()
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS parcel_values (
                hood TEXT NOT NULL,
                year INTEGER NOT NULL,
                use_code TEXT,
                value REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_pv_hood ON parcel_values(hood);
            CREATE TABLE IF NOT EXISTS evictions (
                hood TEXT NOT NULL,
                year INTEGER NOT NULL,
                reasons TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_ev_hood ON evictions(hood);
            CREATE TABLE IF NOT EXISTS hood_meta (
                hood TEXT PRIMARY KEY,
                assessor_rows INTEGER,
                eviction_rows INTEGER,
                fetched_at TEXT
            );
            CREATE TABLE IF NOT EXISTS hood_list (
                hood TEXT PRIMARY KEY,
                assessor_rows INTEGER,
                eviction_rows INTEGER,
                listed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS rent_zip (
                zip TEXT PRIMARY KEY,
                latest REAL,
                yoy REAL,
                series TEXT,          -- JSON [[month, value], ...] trimmed
                asof TEXT
            );
            CREATE TABLE IF NOT EXISTS rent_metro (
                bed TEXT PRIMARY KEY,  -- overall | br1 | br2
                value REAL,
                asof TEXT
            );
            CREATE TABLE IF NOT EXISTS rent_meta (
                k TEXT PRIMARY KEY,
                v TEXT
            );
            CREATE TABLE IF NOT EXISTS zip_geo (
                zip TEXT PRIMARY KEY,
                geometry TEXT NOT NULL   -- GeoJSON geometry, 4-decimal precision
            );
            """
        )
        conn.commit()
        conn.close()
        _db_initialized = True


# ---------------------------------------------------------------------------
# SODA client

def soda_get(url, params):
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(url + "?" + qs)
    req.add_header("Accept", "application/json")
    if APP_TOKEN:
        req.add_header("X-App-Token", APP_TOKEN)
    last_err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=SODA_TIMEOUT) as resp:
                return json.load(resp)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"DataSF request failed after retries: {last_err} ({url})")


# ---------------------------------------------------------------------------
# Neighborhood list (both datasets use SF "Analysis Neighborhoods" names)

def get_hood_list(force=False):
    conn = db()
    try:
        rows = conn.execute(
            "SELECT hood, assessor_rows, eviction_rows FROM hood_list ORDER BY hood"
        ).fetchall()
        if rows and not force:
            cached = {h: [a or 0, e or 0] for h, a, e in rows}
        else:
            assessor = soda_get(ASSESSOR_URL, {
                "$select": "analysis_neighborhood as hood, count(1) as n",
                "$group": "analysis_neighborhood",
                "$limit": 100,
            })
            evict = soda_get(EVICTIONS_URL, {
                "$select": "neighborhood as hood, count(1) as n",
                "$group": "neighborhood",
                "$limit": 100,
            })
            cached = {}
            for r in assessor:
                h = r.get("hood")
                if h:
                    cached[h] = [int(r["n"]), 0]
            for r in evict:
                h = r.get("hood")
                if h:
                    cached.setdefault(h, [0, 0])[1] = int(r["n"])
            now = datetime.now(timezone.utc).isoformat()
            conn.execute("DELETE FROM hood_list")
            conn.executemany(
                "INSERT INTO hood_list VALUES (?,?,?,?)",
                [(h, a, e, now) for h, (a, e) in cached.items()],
            )
            conn.commit()
        fetched = {
            h: t for h, t in conn.execute("SELECT hood, fetched_at FROM hood_meta")
        }
        return [
            {
                "name": h,
                "assessor_rows": a,
                "eviction_rows": e,
                "cached": h in fetched,
                "fetched_at": fetched.get(h),
            }
            for h, (a, e) in sorted(cached.items())
        ]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Per-neighborhood fetch + cache

_progress = {}          # hood -> {"phase": str, "fetched": int, "total": int}
_progress_lock = threading.Lock()
_hood_locks = {}
_hood_locks_lock = threading.Lock()


def _set_progress(hood, phase, fetched=0, total=0):
    with _progress_lock:
        _progress[hood] = {"phase": phase, "fetched": fetched, "total": total}


def get_progress(hood):
    with _progress_lock:
        return dict(_progress.get(hood, {"phase": "idle", "fetched": 0, "total": 0}))


def _hood_lock(hood):
    with _hood_locks_lock:
        return _hood_locks.setdefault(hood, threading.Lock())


def is_cached(hood):
    conn = db()
    try:
        row = conn.execute(
            "SELECT fetched_at FROM hood_meta WHERE hood=?", (hood,)
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def _expected_rows(hood):
    conn = db()
    try:
        row = conn.execute(
            "SELECT assessor_rows FROM hood_list WHERE hood=?", (hood,)
        ).fetchone()
        return row[0] if row else 0
    finally:
        conn.close()


def fetch_hood(hood):
    """Download and cache one neighborhood (assessor value rows + eviction notices)."""
    with _hood_lock(hood):
        if is_cached(hood):
            _set_progress(hood, "done")
            return

        expected = _expected_rows(hood)
        _set_progress(hood, "assessor", 0, expected)

        # --- Assessor: slim per-parcel rows; total value computed server-side.
        # (ZIP selections skip this — the assessor roll has no ZIP column, so
        # ZIPs get evictions + exact rent, and the UI says values are n/a.)
        value_rows = []
        offset = 0
        while not is_zip(hood):
            page = soda_get(ASSESSOR_URL, {
                "$select": ("closed_roll_year as y, use_code as u, "
                            "(assessed_land_value + assessed_improvement_value + "
                            "assessed_fixtures_value) as v"),
                "$where": f"analysis_neighborhood = '{hood.replace(chr(39), chr(39)*2)}'",
                "$order": "row_id",
                "$limit": SODA_PAGE_SIZE,
                "$offset": offset,
            })
            for r in page:
                try:
                    year = int(r["y"])
                    val = float(r.get("v") or 0)
                except (KeyError, ValueError, TypeError):
                    continue
                if val > 0:
                    value_rows.append((hood, year, r.get("u") or "", val))
            offset += len(page)
            _set_progress(hood, "assessor", offset, max(expected, offset))
            if len(page) < SODA_PAGE_SIZE:
                break

        # --- Evictions: one page is plenty (largest neighborhood ~5.5k notices).
        _set_progress(hood, "evictions", 0, 0)
        evict_rows = []
        offset = 0
        reason_keys = list(EVICTION_REASONS.keys())
        ev_where = (f"zip = '{hood}'" if is_zip(hood)
                    else f"neighborhood = '{hood.replace(chr(39), chr(39)*2)}'")
        while True:
            page = soda_get(EVICTIONS_URL, {
                "$select": "file_date, " + ", ".join(reason_keys),
                "$where": ev_where,
                "$order": ":id",
                "$limit": SODA_PAGE_SIZE,
                "$offset": offset,
            })
            for r in page:
                fd = r.get("file_date") or ""
                if len(fd) < 4:
                    continue
                try:
                    year = int(fd[:4])
                except ValueError:
                    continue
                reasons = ",".join(k for k in reason_keys if r.get(k) is True)
                evict_rows.append((hood, year, reasons))
            offset += len(page)
            if len(page) < SODA_PAGE_SIZE:
                break

        # --- Store atomically.
        conn = db()
        try:
            with conn:
                conn.execute("DELETE FROM parcel_values WHERE hood=?", (hood,))
                conn.execute("DELETE FROM evictions WHERE hood=?", (hood,))
                conn.executemany(
                    "INSERT INTO parcel_values VALUES (?,?,?,?)", value_rows)
                conn.executemany("INSERT INTO evictions VALUES (?,?,?)", evict_rows)
                conn.execute(
                    "INSERT OR REPLACE INTO hood_meta VALUES (?,?,?,?)",
                    (hood, len(value_rows), len(evict_rows),
                     datetime.now(timezone.utc).isoformat()),
                )
        finally:
            conn.close()
        _set_progress(hood, "done")


def refresh_hood(hood):
    conn = db()
    try:
        with conn:
            conn.execute("DELETE FROM hood_meta WHERE hood=?", (hood,))
    finally:
        conn.close()
    _set_progress(hood, "idle")
    fetch_hood(hood)


# ---------------------------------------------------------------------------
# Aggregation

MIN_PARCELS_FOR_STATS = 5  # suppress median/mean for tiny samples
CURRENT_YEAR = date.today().year


def hood_trends(hood, use_filter):
    conn = db()
    try:
        codes = USE_FILTERS.get(use_filter)
        if codes:
            ph = ",".join("?" * len(codes))
            rows = conn.execute(
                f"SELECT year, value FROM parcel_values WHERE hood=? AND use_code IN ({ph})",
                (hood, *codes),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT year, value FROM parcel_values WHERE hood=?", (hood,)
            ).fetchall()

        by_year = {}
        for year, val in rows:
            by_year.setdefault(year, []).append(val)
        values = []
        for year in sorted(by_year):
            vals = by_year[year]
            entry = {"year": year, "count": len(vals), "median": None, "mean": None}
            if len(vals) >= MIN_PARCELS_FOR_STATS:
                entry["median"] = round(statistics.median(vals))
                entry["mean"] = round(statistics.fmean(vals))
            values.append(entry)

        ev_rows = conn.execute(
            "SELECT year, reasons FROM evictions WHERE hood=?", (hood,)
        ).fetchall()
        ev_by_year = {}
        reason_counts = {}
        for year, reasons in ev_rows:
            ev_by_year[year] = ev_by_year.get(year, 0) + 1
            for k in reasons.split(","):
                if k:
                    reason_counts[k] = reason_counts.get(k, 0) + 1
        evictions = [
            {"year": y, "count": n, "partial": y == CURRENT_YEAR}
            for y, n in sorted(ev_by_year.items())
        ]
        reasons_out = sorted(
            ({"key": k, "label": EVICTION_REASONS.get(k, k), "count": n}
             for k, n in reason_counts.items()),
            key=lambda r: -r["count"],
        )

        meta = conn.execute(
            "SELECT assessor_rows, eviction_rows, fetched_at FROM hood_meta WHERE hood=?",
            (hood,),
        ).fetchone()
        return {
            "values": values,
            "evictions": evictions,
            "reasons": reasons_out,
            "eviction_total": len(ev_rows),
            "assessor_rows": meta[0] if meta else 0,
            "fetched_at": meta[2] if meta else None,
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Rent benchmark (market asking rent — external to the DataSF datasets)

_rent_lock = threading.Lock()


def _http_text(url, timeout=120):
    req = urllib.request.Request(url, headers={
        "User-Agent": "GroundTruth/1.0 (personal apartment-hunting tool)",
        "Accept": "text/csv,text/html,*/*",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def _fetch_zori():
    """Zillow ZORI ZIP-level -> per-SF-ZIP latest, YoY, and a trimmed monthly
    series (last 36 months) for a sparkline."""
    text = _http_text(ZORI_ZIP_URL, timeout=180)
    reader = csv.reader(io.StringIO(text))
    header = next(reader)
    month_idx = [i for i, c in enumerate(header) if len(c) >= 7 and c[:4].isdigit()]
    zi, ci = header.index("RegionName"), header.index("City")
    wanted = {z for zips in HOOD_ZIPS.values() for z in zips}
    out = {}
    for row in reader:
        z = row[zi]
        if z not in wanted or row[ci] != "San Francisco":
            continue
        series = [(header[i], float(row[i])) for i in month_idx if row[i]]
        if not series:
            continue
        latest = series[-1][1]
        # YoY: compare to ~12 months back if available
        yoy = None
        if len(series) >= 13:
            prev = series[-13][1]
            if prev:
                yoy = (latest - prev) / prev * 100
        out[z] = {"latest": latest, "yoy": yoy, "series": series[-36:]}
    return out


def _fetch_apartment_list_metro():
    """Apartment List SF-metro overall/1BR/2BR (supplies the bedroom ratio).
    The CSV URL rotates monthly, so scrape the current link off the data page."""
    page = _http_text(APARTMENT_LIST_PAGE, timeout=60)
    m = re.search(r'(//[^"\']*Rent_Estimates_\d{4}_\d{2}\.csv)', page)
    if not m:
        raise RuntimeError("couldn't locate Apartment List rent-estimates CSV link")
    url = "https:" + m.group(1) if m.group(1).startswith("//") else m.group(1)
    reader = csv.reader(io.StringIO(_http_text(url, timeout=60)))
    header = next(reader)
    months = [i for i, c in enumerate(header) if len(c) == 7 and c[:4].isdigit()]
    name_i, type_i, bed_i = (header.index("location_name"),
                             header.index("location_type"), header.index("bed_size"))
    key = {"overall": "overall", "1br": "br1", "2br": "br2"}
    out = {}
    for row in reader:
        if row[type_i] == "Metro" and row[name_i].startswith("San Francisco") \
                and row[bed_i] in key:
            val = next((float(row[i]) for i in reversed(months) if row[i]), None)
            if val:
                out[key[row[bed_i]]] = val
    return out


def _store_rent(zori, metro):
    now = datetime.now(timezone.utc).isoformat()
    conn = db()
    try:
        with conn:
            conn.execute("DELETE FROM rent_zip")
            conn.executemany(
                "INSERT INTO rent_zip VALUES (?,?,?,?,?)",
                [(z, d["latest"], d["yoy"], json.dumps(d["series"]), now)
                 for z, d in zori.items()])
            conn.execute("DELETE FROM rent_metro")
            conn.executemany(
                "INSERT INTO rent_metro VALUES (?,?,?)",
                [(b, v, now) for b, v in metro.items()])
            conn.execute("INSERT OR REPLACE INTO rent_meta VALUES ('rent_asof', ?)", (now,))
    finally:
        conn.close()


def ensure_rent(force=False):
    """Populate the rent cache if empty (or forced). Cheap no-op afterward."""
    with _rent_lock:
        conn = db()
        try:
            have = conn.execute("SELECT count(*) FROM rent_zip").fetchone()[0]
        finally:
            conn.close()
        if have and not force:
            return
        zori = _fetch_zori()
        try:
            metro = _fetch_apartment_list_metro()
        except Exception:  # noqa: BLE001 — bedroom ratio is optional garnish
            metro = {}
        _store_rent(zori, metro)


def census_citywide():
    """Optional MEASURED by-bedroom median gross rent for San Francisco *city*
    from Census ACS B25031 (needs a free CENSUS_API_KEY). This is genuinely
    citywide — ACS doesn't give a clean per-neighborhood-by-bedroom cut without
    tract aggregation — so it's shown as a measured reference, not a per-hood
    override. Returns (values_dict, note): values are {bed: rounded} or {},
    note is None | 'invalid_key' | 'unreachable' for the UI to explain."""
    if not CENSUS_API_KEY:
        return {}, None
    conn = db()
    try:
        cached = conn.execute("SELECT v FROM rent_meta WHERE k='city_acs'").fetchone()
    finally:
        conn.close()
    if cached:
        return json.loads(cached[0]), None
    # B25031: 002=studio 003=1BR 004=2BR 005=3BR. place:67000 = San Francisco.
    var = {"studio": "B25031_002E", "br1": "B25031_003E",
           "br2": "B25031_004E", "br3": "B25031_005E"}
    url = (f"https://api.census.gov/data/{CENSUS_YEAR}/acs/acs5?get="
           + ",".join(var.values())
           + f"&for=place:67000&in=state:06&key={CENSUS_API_KEY}")
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 — optional; never breaks the benchmark
        return {}, "unreachable"
    if "Invalid Key" in body or "Missing Key" in body:
        return {}, "invalid_key"        # key present but not activated/valid
    try:
        data = json.loads(body)
        head, vals = data[0], data[1]
        got = {b: round(float(vals[head.index(v)])) for b, v in var.items()
               if vals[head.index(v)] not in (None, "", "-666666666")}
    except Exception:  # noqa: BLE001
        return {}, "unreachable"
    if got:
        conn = db()
        try:
            with conn:
                conn.execute("INSERT OR REPLACE INTO rent_meta VALUES ('city_acs', ?)",
                             (json.dumps(got),))
        finally:
            conn.close()
    return got, None


def rent_benchmark(hoods):
    ensure_rent()
    conn = db()
    try:
        zrows = {z: {"latest": lt, "yoy": yy, "series": json.loads(s)}
                 for z, lt, yy, s in
                 conn.execute("SELECT zip, latest, yoy, series FROM rent_zip")}
        metro = {b: v for b, v in conn.execute("SELECT bed, value FROM rent_metro")}
        asof = conn.execute("SELECT v FROM rent_meta WHERE k='rent_asof'").fetchone()
    finally:
        conn.close()
    asof = asof[0] if asof else None

    # bedroom ratios from the metro figures (fallbacks are typical SF splits)
    mo = metro.get("overall")
    ratios = {
        "studio": 0.78,
        "br1": (metro.get("br1") / mo) if mo and metro.get("br1") else 0.90,
        "br2": (metro.get("br2") / mo) if mo and metro.get("br2") else 1.18,
        "br3": 1.55,
    }

    result = {}
    for hood in hoods:
        wanted = [hood] if is_zip(hood) else HOOD_ZIPS.get(hood, [])
        zips = [z for z in wanted if z in zrows]
        entry = {"available": bool(zips), "zips": zips, "asof": asof,
                 "exact": is_zip(hood), "measured": False}
        if not zips:
            result[hood] = entry
            continue
        latest = statistics.fmean(zrows[z]["latest"] for z in zips)
        yoys = [zrows[z]["yoy"] for z in zips if zrows[z]["yoy"] is not None]
        entry["overall"] = round(latest)
        entry["yoy"] = round(statistics.fmean(yoys), 1) if yoys else None
        # blended monthly series across the hood's ZIPs (align by month label)
        month_map = {}
        for z in zips:
            for mth, val in zrows[z]["series"]:
                month_map.setdefault(mth, []).append(val)
        entry["series"] = [{"month": m, "value": round(statistics.fmean(v))}
                           for m, v in sorted(month_map.items())]
        # per-bedroom estimates (blend neighborhood level with metro bedroom mix)
        entry["bedrooms"] = {b: round(latest * ratios[b])
                             for b in ("studio", "br1", "br2", "br3")}
        result[hood] = entry
    city_acs, census_note = census_citywide()       # {} unless a valid key is set
    return {"hoods": result,
            "metro": metro,
            "ratios": {k: round(v, 3) for k, v in ratios.items()},
            "asof": asof,
            "city_acs": city_acs,
            "census_note": census_note,
            "census_year": CENSUS_YEAR,
            "measured_available": bool(CENSUS_API_KEY)}


def ensure_zip_geo():
    """Cache SF ZIP (ZCTA) boundary polygons from Census TIGERweb, once."""
    conn = db()
    try:
        have = conn.execute("SELECT count(*) FROM zip_geo").fetchone()[0]
    finally:
        conn.close()
    if have:
        return
    where = "ZCTA5 IN ({})".format(",".join(f"'{z}'" for z in SF_ZIPS))
    qs = urllib.parse.urlencode({"where": where, "outFields": "ZCTA5",
                                 "f": "geojson", "geometryPrecision": 4,
                                 "outSR": 4326})
    data = json.loads(_http_text(TIGER_ZCTA_URL + "?" + qs, timeout=90))
    rows = [(f["properties"]["ZCTA5"], json.dumps(f["geometry"]))
            for f in data.get("features", []) if f.get("geometry")]
    if not rows:
        raise RuntimeError("TIGERweb returned no ZIP boundaries")
    conn = db()
    try:
        with conn:
            conn.executemany("INSERT OR REPLACE INTO zip_geo VALUES (?,?)", rows)
    finally:
        conn.close()


def rent_map():
    """Heat-map payload: every SF ZIP with its boundary, latest asking rent,
    YoY, and the Analysis Neighborhoods it maps to."""
    ensure_rent()
    ensure_zip_geo()
    zip_hoods = {}
    for hood, zips in HOOD_ZIPS.items():
        for z in zips:
            zip_hoods.setdefault(z, []).append(hood)
    conn = db()
    try:
        vals = {z: (lt, yy) for z, lt, yy in
                conn.execute("SELECT zip, latest, yoy FROM rent_zip")}
        geo = {z: g for z, g in conn.execute("SELECT zip, geometry FROM zip_geo")}
        asof = conn.execute("SELECT v FROM rent_meta WHERE k='rent_asof'").fetchone()
    finally:
        conn.close()
    feats = []
    for z in SF_ZIPS:
        if z not in geo:
            continue
        lt, yy = vals.get(z, (None, None))
        feats.append({"zip": z,
                      "value": round(lt) if lt else None,
                      "yoy": round(yy, 1) if yy is not None else None,
                      "hoods": sorted(zip_hoods.get(z, [])),
                      "geometry": json.loads(geo[z])})
    return {"features": feats, "asof": asof[0] if asof else None}


def refresh_rent():
    ensure_rent(force=True)
    conn = db()
    try:
        with conn:
            conn.execute("DELETE FROM rent_meta WHERE k='city_acs'")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Address / parcel lookup (live SODA query, no caching — results are small)

def clean_location(loc):
    """Tidy raw roll locations like '0000 1380 GREENWICH           ST2650'
    into '1380 GREENWICH ST #2650'. Format is: from-number, to-number,
    street name, then suffix with a 4-digit unit glued on."""
    s = re.sub(r"\s+", " ", (loc or "")).strip()
    m = re.match(r"^(\d{1,5}) (\d{1,5}) (.+?)([A-Z]{2})?(\d{4})?$", s)
    if not m:
        return s
    hi, lo, name, suffix, unit = m.groups()
    hi, lo = int(hi), int(lo)
    if hi and lo and hi != lo:
        nums = f"{min(hi, lo)}–{max(hi, lo)}"
    else:
        nums = str(hi or lo or "").strip()
    out = f"{nums} {name.strip()}".strip()
    if suffix:
        out += f" {suffix}"
    if unit and int(unit) > 0:
        out += f" #{int(unit)}"
    return out


def lookup(query):
    q = query.strip().upper()
    if not q:
        return {"parcels": []}
    compact = re.sub(r"[\s/-]", "", q)
    if re.fullmatch(r"[0-9]{4,5}[0-9A-Z]{0,4}", compact):
        where = f"starts_with(parcel_number, '{compact}')"
    else:
        safe = q.replace("'", "''")
        where = f"upper(property_location) like '%{safe}%'"
    rows = soda_get(ASSESSOR_URL, {
        "$select": ("parcel_number, closed_roll_year as y, property_location, "
                    "use_definition, number_of_units, year_property_built, "
                    "(assessed_land_value + assessed_improvement_value + "
                    "assessed_fixtures_value) as v, analysis_neighborhood"),
        "$where": where,
        "$order": "parcel_number, closed_roll_year",
        "$limit": 1500,
    })
    parcels = {}
    for r in rows:
        pn = r.get("parcel_number")
        if not pn:
            continue
        p = parcels.setdefault(pn, {
            "parcel_number": pn, "location": "", "use": "", "units": None,
            "built": None, "neighborhood": "", "history": [],
        })
        try:
            year = int(r["y"])
            val = float(r.get("v") or 0)
        except (KeyError, ValueError, TypeError):
            continue
        p["history"].append({"year": year, "value": round(val)})
        # keep metadata from the latest roll year
        p["location"] = clean_location(r.get("property_location")) or p["location"]
        p["use"] = r.get("use_definition") or p["use"]
        p["neighborhood"] = r.get("analysis_neighborhood") or p["neighborhood"]
        u = r.get("number_of_units")
        b = r.get("year_property_built")
        p["units"] = int(float(u)) if u not in (None, "") else p["units"]
        yb = int(float(b)) if b not in (None, "") else 0
        p["built"] = yb if yb > 1000 else p["built"]
    out = list(parcels.values())[:20]
    for p in out:
        p["history"].sort(key=lambda h: h["year"])
    truncated = len(parcels) > 20 or len(rows) >= 1500
    return {"parcels": out, "truncated": truncated}


# ---------------------------------------------------------------------------
# HTTP handler

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # quiet by default; enable with VERBOSE=1
        if os.environ.get("VERBOSE"):
            super().log_message(fmt, *args)

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, msg, status=500):
        self._json({"error": msg}, status)

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        fs_path = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not fs_path.startswith(STATIC_DIR) or not os.path.isfile(fs_path):
            self._error("not found", 404)
            return
        ext = os.path.splitext(fs_path)[1]
        with open(fs_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        route = parsed.path
        try:
            if route == "/api/neighborhoods":
                self._json({"neighborhoods": get_hood_list()})
            elif route == "/api/progress":
                hood = (qs.get("hood") or [""])[0]
                self._json(get_progress(hood))
            elif route == "/api/trends":
                hoods = [h for h in (qs.get("hoods") or [""])[0].split("|") if h][:3]
                use = (qs.get("use") or ["res"])[0]
                if use not in USE_FILTERS:
                    return self._error("bad use filter", 400)
                result = {}
                for hood in hoods:
                    if not is_cached(hood):
                        fetch_hood(hood)
                    result[hood] = hood_trends(hood, use)
                self._json({"use": use, "hoods": result,
                            "current_year": CURRENT_YEAR})
            elif route == "/api/rent":
                hoods = [h for h in (qs.get("hoods") or [""])[0].split("|") if h][:3]
                self._json(rent_benchmark(hoods))
            elif route == "/api/rentmap":
                self._json(rent_map())
            elif route == "/api/lookup":
                q = (qs.get("q") or [""])[0]
                self._json(lookup(q))
            elif route.startswith("/api/"):
                self._error("not found", 404)
            else:
                self._static(route)
        except RuntimeError as e:
            self._error(str(e), 502)
        except Exception as e:  # noqa: BLE001 — surface anything to the UI
            self._error(f"{type(e).__name__}: {e}", 500)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if parsed.path == "/api/refresh":
                hood = (qs.get("hood") or [""])[0]
                if not hood:
                    return self._error("hood required", 400)
                refresh_hood(hood)
                self._json({"ok": True})
            elif parsed.path == "/api/refresh_list":
                get_hood_list(force=True)
                self._json({"ok": True})
            elif parsed.path == "/api/refresh_rent":
                refresh_rent()
                self._json({"ok": True})
            else:
                self._error("not found", 404)
        except RuntimeError as e:
            self._error(str(e), 502)
        except Exception as e:  # noqa: BLE001
            self._error(f"{type(e).__name__}: {e}", 500)


def main():
    init_db()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}"
    print(f"Ground Truth → {url}")
    print("The page reads static/data/; run export_static.py to refresh it. Ctrl-C to stop.")
    if not os.environ.get("NO_BROWSER"):
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
