#!/usr/bin/env python3
"""Write the JSON the page reads (static/data/) for the six neighborhoods."""

import json
import os
import re

import server

FEATURED_HOODS = [
    "Portola",
    "Bernal Heights",
    "Marina",
    "Pacific Heights",
    "Twin Peaks",
    "West of Twin Peaks",
]


def slug(value):
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))


def main():
    server.init_db()
    output = os.path.join(server.STATIC_DIR, "data")

    neighborhoods = [
        hood for hood in server.get_hood_list()
        if hood["name"] in FEATURED_HOODS
    ]
    write_json(os.path.join(output, "neighborhoods.json"), {
        "neighborhoods": neighborhoods,
    })

    for hood in FEATURED_HOODS:
        if not server.is_cached(hood):
            server.fetch_hood(hood)
        for use_filter in server.USE_FILTERS:
            write_json(
                os.path.join(output, "trends", f"{slug(hood)}-{use_filter}.json"),
                server.hood_trends(hood, use_filter),
            )

    write_json(os.path.join(output, "rent.json"), server.rent_benchmark(FEATURED_HOODS))
    write_json(os.path.join(output, "rentmap.json"), server.rent_map())
    print(f"Static data written to {output}")


if __name__ == "__main__":
    main()
