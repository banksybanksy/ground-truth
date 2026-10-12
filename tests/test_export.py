"""Aggregation and export tests. Each test builds a small SQLite cache in a
temp directory, so nothing touches the network or the real data/cache.db."""

import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import export_static  # noqa: E402
import server  # noqa: E402

SQUARE = {"type": "Polygon", "coordinates": [[[-122.4, 37.7], [-122.3, 37.7],
                                              [-122.3, 37.8], [-122.4, 37.7]]]}


class CacheTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        patches = [
            mock.patch.object(server, "DATA_DIR", self.tmp.name),
            mock.patch.object(server, "DB_PATH", os.path.join(self.tmp.name, "cache.db")),
            mock.patch.object(server, "STATIC_DIR", os.path.join(self.tmp.name, "static")),
            mock.patch.object(server, "CENSUS_API_KEY", ""),
            mock.patch.object(server, "_db_initialized", False),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)
        server.init_db()

    def insert(self, sql, rows):
        conn = server.db()
        with conn:
            conn.executemany(sql, rows)
        conn.close()

    def cache_hood(self, hood, values=(), evictions=()):
        self.insert("INSERT INTO parcel_values VALUES (?,?,?,?)",
                    [(hood, y, use, v) for y, use, v in values])
        self.insert("INSERT INTO evictions VALUES (?,?,?)",
                    [(hood, y, reasons) for y, reasons in evictions])
        self.insert("INSERT INTO hood_meta VALUES (?,?,?,?)",
                    [(hood, len(values), len(evictions), "2026-01-01T00:00:00+00:00")])
        self.insert("INSERT INTO hood_list VALUES (?,?,?,?)",
                    [(hood, len(values), len(evictions), "2026-01-01T00:00:00+00:00")])

    def cache_rent(self, zips, metro=None):
        """zips: {zip: (latest, yoy, [(month, value), ...])}"""
        self.insert("INSERT INTO rent_zip VALUES (?,?,?,?,?)",
                    [(z, lt, yy, json.dumps(series), "asof")
                     for z, (lt, yy, series) in zips.items()])
        self.insert("INSERT INTO rent_metro VALUES (?,?,?)",
                    [(b, v, "asof") for b, v in (metro or {}).items()])
        self.insert("INSERT INTO rent_meta VALUES (?,?)", [("rent_asof", "2026-05-01")])


class HoodTrendsTest(CacheTestCase):
    def test_median_needs_five_parcels(self):
        values = [(2024, "SRES", v) for v in (100, 200, 300, 400, 500)]
        values += [(2025, "SRES", v) for v in (100, 200, 300, 400)]
        self.cache_hood("Portola", values)
        out = server.hood_trends("Portola", "all")["values"]
        self.assertEqual(out[0], {"year": 2024, "count": 5, "median": 300, "mean": 300})
        self.assertEqual(out[1], {"year": 2025, "count": 4, "median": None, "mean": None})

    def test_use_filter_keeps_only_matching_codes(self):
        values = [(2025, "SRES", 100)] * 5 + [(2025, "MRES", 900)] * 5
        values += [(2025, "COMM", 5000)] * 5
        self.cache_hood("Marina", values)
        median = {use: server.hood_trends("Marina", use)["values"][0]["median"]
                  for use in server.USE_FILTERS}
        self.assertEqual(median, {"sfr": 100, "mfr": 900, "res": 500, "all": 900})

    def test_evictions_by_year_flag_current_year_and_count_each_reason(self):
        self.cache_hood("Portola", evictions=[
            (2025, "owner_move_in"),
            (2025, "owner_move_in,ellis_act_withdrawal"),
            (2026, "nuisance"),
            (2026, ""),
        ])
        with mock.patch.object(server, "CURRENT_YEAR", 2026):
            out = server.hood_trends("Portola", "res")
        self.assertEqual(out["evictions"], [
            {"year": 2025, "count": 2, "partial": False},
            {"year": 2026, "count": 2, "partial": True},
        ])
        self.assertEqual(out["eviction_total"], 4)
        # One notice can cite several reasons, so reasons outnumber notices.
        self.assertEqual(out["reasons"][0],
                         {"key": "owner_move_in", "label": "Owner / relative move-in", "count": 2})
        self.assertEqual(sum(r["count"] for r in out["reasons"]), 4)


class RentBenchmarkTest(CacheTestCase):
    def test_hood_averages_its_zips_and_applies_metro_bedroom_mix(self):
        # Pacific Heights maps to 94115 and 94123.
        self.cache_rent({
            "94115": (4000, 2.0, [("2026-04", 3900), ("2026-05", 4000)]),
            "94123": (5000, 4.0, [("2026-05", 5000)]),
        }, metro={"overall": 3000, "br1": 2700, "br2": 3600})
        entry = server.rent_benchmark(["Pacific Heights"])["hoods"]["Pacific Heights"]
        self.assertTrue(entry["available"])
        self.assertEqual(entry["zips"], ["94115", "94123"])
        self.assertEqual(entry["overall"], 4500)
        self.assertEqual(entry["yoy"], 3.0)
        self.assertEqual(entry["series"], [{"month": "2026-04", "value": 3900},
                                           {"month": "2026-05", "value": 4500}])
        self.assertEqual(entry["bedrooms"],
                         {"studio": 3510, "br1": 4050, "br2": 5400, "br3": 6975})

    def test_missing_zip_coverage_is_unavailable_not_zero(self):
        self.cache_rent({"94110": (4100, None, [("2026-05", 4100)])})
        out = server.rent_benchmark(["Portola", "Bernal Heights"])
        self.assertEqual(out["hoods"]["Portola"], {
            "available": False, "zips": [], "asof": "2026-05-01",
        })
        self.assertIsNone(out["hoods"]["Bernal Heights"]["yoy"])
        self.assertFalse(out["measured_available"])


class RentMapTest(CacheTestCase):
    def test_features_follow_cached_boundaries(self):
        self.cache_rent({"94110": (4127.4, 1.26, [])})
        self.insert("INSERT INTO zip_geo VALUES (?,?)",
                    [("94110", json.dumps(SQUARE)), ("94111", json.dumps(SQUARE))])
        features = server.rent_map()["features"]
        self.assertEqual([f["zip"] for f in features], ["94110", "94111"])
        self.assertEqual(features[0]["value"], 4127)
        self.assertEqual(features[0]["yoy"], 1.3)
        self.assertEqual(features[0]["hoods"], ["Bernal Heights", "Mission"])
        self.assertIsNone(features[1]["value"])


class ExportTest(CacheTestCase):
    def test_writes_every_file_the_page_requests(self):
        for hood in export_static.FEATURED_HOODS:
            self.cache_hood(hood, [(2025, "SRES", 500000)] * 5, [(2025, "nuisance")])
        self.cache_hood("Mission", [(2025, "SRES", 1)] * 5)  # not featured
        self.cache_rent({"94134": (3900, 1.0, [("2026-05", 3900)])})
        self.insert("INSERT INTO zip_geo VALUES (?,?)", [("94134", json.dumps(SQUARE))])

        with mock.patch.object(server, "fetch_hood",
                               side_effect=AssertionError("cached hoods must not refetch")):
            with mock.patch("builtins.print"):
                export_static.main()

        out = os.path.join(server.STATIC_DIR, "data")
        with open(os.path.join(out, "neighborhoods.json")) as f:
            names = [h["name"] for h in json.load(f)["neighborhoods"]]
        self.assertEqual(sorted(names), sorted(export_static.FEATURED_HOODS))
        # Slugs must match hoodSlug() in static/app.js.
        for slug in ("portola", "bernal-heights", "marina", "pacific-heights",
                     "twin-peaks", "west-of-twin-peaks"):
            for use in ("res", "sfr", "mfr", "all"):
                self.assertTrue(os.path.isfile(os.path.join(out, "trends", f"{slug}-{use}.json")))
        with open(os.path.join(out, "rent.json")) as f:
            rent = json.load(f)
        self.assertEqual(set(rent["hoods"]), set(export_static.FEATURED_HOODS))
        self.assertTrue(rent["hoods"]["Portola"]["available"])
        self.assertTrue(os.path.isfile(os.path.join(out, "rentmap.json")))


if __name__ == "__main__":
    unittest.main()
