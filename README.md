# Ground Truth

[![CI](https://github.com/banksybanksy/ground-truth/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/banksybanksy/ground-truth/actions/workflows/ci.yml)

A small dashboard for one apartment-hunting question: is the rent in this San Francisco neighborhood high or low for the city, is it climbing, and what does the property and eviction history look like? It compares up to three of six neighborhoods (Portola, Bernal Heights, Marina, Pacific Heights, Twin Peaks, West Portal) using public data that otherwise lives in sources that don't line up.

![Rent benchmark for Portola and Marina](docs/screenshots/dashboard.png)

For each neighborhood the page shows an asking-rent estimate by bedroom count with its recent trend, a citywide ZIP heat map that outlines the ZIPs the neighborhood is matched to, the median assessed value per parcel from 2007 to 2025, eviction notices filed per year since 1997, and notices by stated reason. Each of those three charts can switch to a table.

## How it works

**Six neighborhoods are exported ahead of time instead of queried live.** `export_static.py` fetches each neighborhood once, aggregates it, and writes the small JSON files in `static/data/`. The page only reads those files, so it loads quickly and works from any static file server. An earlier version ran citywide live queries, where the first look at a large neighborhood took up to 90 seconds.

**Assessor requests are column-scoped, paged, and cached.** The assessor roll has hundreds of thousands of rows per neighborhood. Each request `$select`s only the roll year, use code, and a server-computed total (land + improvements + fixtures), pages with `$limit`/`$offset`, retries failures with a growing delay, and lands in a SQLite cache so a neighborhood is fetched once (`soda_get` and `fetch_hood` in [server.py](server.py)).

**Sources keep their own meanings.** Assessed value is not market price, an eviction notice is not a completed eviction, and a per-bedroom rent here is an estimate, not a measurement. The data is labeled that way in the UI rather than blended into one score. A neighborhood with no rent-index coverage reads as "no benchmark", not as zero. The Apartment List CSV URL changes every month, so the exporter finds the current link on their data page instead of hardcoding it.

## Running it

Python 3.9 or newer, standard library only:

```bash
python3 server.py            # serves static/ at http://127.0.0.1:8000
```

`NO_BROWSER=1` stops it opening a browser tab, and `PORT` changes the port. The page reads the committed JSON, so this works offline.

To refresh the data (needs network access to DataSF, Zillow, Apartment List, and Census TIGERweb):

```bash
python3 export_static.py     # caches raw rows in data/cache.db, rewrites static/data/
```

The exporter reuses anything already in `data/cache.db`. Delete that file to pull everything fresh.

Optional variables (see `.env.example`): `CENSUS_API_KEY` adds measured citywide rent by bedroom from the Census ACS, and `SODA_APP_TOKEN` raises the DataSF rate limit.

Tests and lint:

```bash
python3 -m unittest discover -s tests
ruff check .                 # optional; CI runs it
```

## Data sources

| Source | Used for |
|---|---|
| [Assessor Historical Secured Property Tax Rolls](https://data.sfgov.org/Housing-and-Buildings/Assessor-Historical-Secured-Property-Tax-Rolls/wv5m-vpq2) (DataSF) | Assessed value per parcel per roll year, 2007 to 2025 |
| [Eviction Notices](https://data.sfgov.org/Housing-and-Buildings/Eviction-Notices/5cei-gny5) (DataSF) | Notices filed with the Rent Board since 1997, with reason flags |
| [Zillow Observed Rent Index](https://www.zillow.com/research/data/) | Asking rent by ZIP, all home types |
| [Apartment List rent estimates](https://www.apartmentlist.com/research/category/data-rent-estimates) | SF-metro bedroom mix |
| [Census ACS B25031](https://www.census.gov/data/developers/data-sets/acs-5year.html) (optional) | Measured citywide median rent by bedroom |
| [Census TIGERweb](https://tigerweb.geo.census.gov/) | ZIP boundaries for the map |

## Limits

- **Assessed value lags the market by design.** Prop 13 caps growth at about 2% a year until a property sells, so read the shape of the trend, not the level.
- **ZIPs aren't neighborhoods.** Rent is matched through a hand-built ZIP crosswalk, so neighborhoods that share a ZIP read alike. West Portal uses the city's broader "West of Twin Peaks" reporting area.
- **Per-bedroom rents are estimates:** the neighborhood's asking-rent level times the metro bedroom mix.
- **One notice can cite several reasons,** so reason counts add up to more than the notice count.
- **The Apartment List step depends on their page layout.** If it changes, the exporter falls back to typical bedroom ratios.
- **It's a snapshot.** The committed data was exported in July 2026, with rents through May 2026. The year still in progress at export time is drawn dashed.
- **It isn't a listings tool.** It tells you what a fair price looks like so you can judge listings found elsewhere.

## Status

A personal tool. Data changes only when someone runs the exporter. The server is local and single-user and binds to localhost only.
