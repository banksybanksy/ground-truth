# Ground Truth

Get a feel for a San Francisco neighborhood while apartment hunting: a citywide rent heat map, historical assessed property values, eviction-notice activity, and an asking-rent benchmark by bedroom, searchable by neighborhood or ZIP.

The current edition is intentionally narrowed to six neighborhoods: Portola,
Bernal Heights, Marina, Pacific Heights, Twin Peaks, and West Portal (which
uses San Francisco's broader "West of Twin Peaks" reporting area). The page
reads precomputed JSON from `static/data/`, so it can be served as a static
site. Run `python3 export_static.py` to refresh that JSON.

![Rent benchmark for two neighborhoods, above the citywide heat map](docs/screenshots/dashboard.png)

## What it does

Pick up to three of the six neighborhoods and the page shows, for each: an asking-rent benchmark by bedroom count with its recent trend, where that rent sits on a citywide ZIP heat map, the median assessed value per parcel from 2007 to 2025, eviction notices filed per year since 1997, and eviction notices by stated reason. You can filter assessed values by property type and switch any chart to a table. Chart.js is vendored, so nothing loads from a CDN.

The earlier citywide version also took ZIP searches and looked up single parcels. `server.py` still serves those JSON endpoints, but the current page does not use them, and some screenshots further down come from that version.

## Why I built it

I was apartment hunting and wanted one place to sanity-check a neighborhood: is rent here high or low for the city, is it climbing, what does the property and eviction history look like. The public data exists, but it is scattered across datasets that do not line up cleanly, and pulling it turned into the actual engineering work.

## Data sources

| Source | What it provides | API key | Updates |
|---|---|---|---|
| [Assessor Historical Secured Property Tax Rolls](https://data.sfgov.org/Housing-and-Buildings/Assessor-Historical-Secured-Property-Tax-Rolls/wv5m-vpq2) (`wv5m-vpq2`) | Assessed value (land + improvements + fixtures) per parcel per roll year, 2007 to 2025; property lookup | No | About yearly |
| [Eviction Notices](https://data.sfgov.org/Housing-and-Buildings/Eviction-Notices/5cei-gny5) (`5cei-gny5`) | Notices filed with the SF Rent Board, 1997 to present, with reason flags | No | Monthly |
| [Zillow ZORI](https://www.zillow.com/research/data/) (ZIP level) | Asking-rent index by ZIP, all home types | No | Monthly |
| [Apartment List Rent Estimates](https://www.apartmentlist.com/research/category/data-rent-estimates) | SF-metro overall / 1BR / 2BR, supplies the bedroom mix | No | Monthly |
| [Census ACS B25031](https://www.census.gov/data/developers/data-sets/acs-5year.html) (optional) | Measured citywide median rent by bedroom | Free key | Yearly (5-year ACS) |
| [Census TIGERweb ZCTA](https://tigerweb.geo.census.gov/) | ZIP boundary polygons for the heat map | No | Static |

## The interesting problem

This project had three separate data problems, one for each source that does not behave the way you would hope.

**What I expected.** Query the assessor dataset for a neighborhood's parcels, chart the median value, add a ZIP filter, and read Apartment List's rent CSV from a fixed URL. Four sources, four straightforward reads.

**What actually happened, and how I found out.**

1. **The assessor dataset is enormous and the naive query stalled.** Some neighborhoods have hundreds of thousands of parcel rows. Pulling them in one request would hang or get throttled by DataSF. I instrumented the fetch with page counts and progress state (the `_progress` phase/fetched/total that drives the download bar) so I could see exactly where it stalled, which was on the size of each page and the total row count.
2. **The assessor roll has no ZIP field.** I wanted ZIP-level search, but reading the schema directly showed there is no ZIP column on the assessor data. A ZIP has no assessed-value answer at all.
3. **Apartment List's CSV URL changes every month.** A URL I hardcoded worked, then 404'd a month later, because the filename embeds the year and month (`Rent_Estimates_YYYY_MM.csv`).

**What I decided to do.**

- **Column-scoped, paged, retried, cached fetches.** The assessor request `$select`s only the three fields it needs and computes the total assessed value server-side, which shrinks each row dramatically. It pages with `$limit`/`$offset`, retries with backoff on timeouts, and caches each neighborhood in SQLite so it is fetched once ([server.py](server.py), `soda_get` and `fetch_hood`).
- **Mark property values explicitly unavailable for ZIP searches.** Because the assessor roll has no ZIP column, a ZIP selection skips the assessor fetch entirely and the UI says "assessed values aren't ZIP-coded." ZIPs still get exact eviction counts and an exact rent benchmark. I did not invent a ZIP-to-parcel mapping to paper over the gap.
- **Resolve the Apartment List file at runtime.** Instead of hardcoding the CSV URL, the app scrapes the Apartment List data page for the current `Rent_Estimates_YYYY_MM.csv` link each time it refreshes ([server.py](server.py), `_fetch_apartment_list_metro`).

**What I chose not to do.** I did not fake a ZIP-to-value mapping, I did not hardcode a URL that expires monthly, and I did not pull full assessor records when three computed columns were enough. And because assessed value is not market price, I did not present it as one. The UI repeats that caveat rather than letting the number be misread.

![A ZIP has eviction counts and rent, but assessed values are marked not available (earlier citywide version)](docs/screenshots/zip-tiles.png)

## Running it locally

Requires **Python 3.9+**. The backend is standard library only, so there is nothing to install.

```bash
python3 server.py
```

Then open **http://127.0.0.1:8000** (it tries to open your browser; set `NO_BROWSER=1` to suppress). The page loads the committed JSON in `static/data/`, so this works offline. Any static file server pointed at `static/` works too.

To refresh the data, run the exporter. It needs network access to DataSF, Zillow, Apartment List, and Census TIGERweb, fetches each neighborhood once into `data/cache.db`, and rewrites `static/data/`:

```bash
python3 export_static.py
```

Optional environment variables (copy `.env.example`; they apply to the exporter and the live API, not to the page itself):

| Variable | Purpose |
|---|---|
| `CENSUS_API_KEY` | Adds measured citywide-by-bedroom rent from the Census ACS to the exported rent data. Free key, everything works without it. |
| `SODA_APP_TOKEN` | Raises the DataSF rate limit for large fetches. |
| `PORT` | Server port (default 8000). |

## Architecture

- **Frontend** (`static/index.html`, `app.js`, `styles.css`) is a single-page app that reads `static/data/*.json`. Charts use a vendored Chart.js (`static/vendor/`), and the rent heat map is a custom SVG choropleth drawn from ZCTA polygons, so nothing loads from a CDN.
- **Exporter** (`export_static.py`) calls the server's fetch and aggregation functions for the six neighborhoods and writes the JSON the page reads.
- **Server** (`server.py`) is a stdlib `http.server`. It serves `static/` and a live JSON API that fetches each neighborhood from DataSF on demand (column-scoped, paged, retried, progress-tracked), builds the rent benchmark from Zillow and Apartment List, and caches all of it in SQLite.
- **Cache** (`data/cache.db`) holds slim per-parcel value rows and eviction notices per neighborhood, the rent tables, and the ZIP polygons. It is regenerated on demand and safe to delete.

Local JSON API: `/api/neighborhoods`, `/api/trends`, `/api/progress`, `/api/rent`, `/api/rentmap`, `/api/lookup`, and `POST /api/refresh` / `/api/refresh_rent`.

## Known limitations

- **Assessed value is not market price.** Prop 13 caps assessed-value growth at about 2%/yr until a property sells, so levels sit far below market and move slowly. Read the shape of the trend and the jumps on resale, not the dollar level. The app says this prominently.
- **ZIP is not a neighborhood.** The ZIP-to-neighborhood crosswalk is a hand-built approximation, so neighborhoods sharing a ZIP read alike. And ZIP searches have no assessed value, by the nature of the source data.
- **Per-bedroom rents are estimates** (neighborhood asking-rent level times the metro bedroom mix), unless you set `CENSUS_API_KEY`, which adds measured citywide ACS medians.
- **The Apartment List benchmark depends on scraping their page.** If they change the page structure or the CSV filename pattern, the metro benchmark breaks. The failure is caught and surfaced rather than silent.
- **The page is a snapshot.** Numbers are as fresh as the last `export_static.py` run; the eviction chart dashes the year that was still in progress at export time.
- **First fetch of a large neighborhood is slow** (a live paged fetch), and DataSF can throttle anonymous use. It is cached after the first pull.
- **An eviction notice is not a completed eviction,** and one notice can cite several reasons, so reasons sum to more than the notice count.
- **This is not a listings tool.** It does not browse Craigslist or Zillow for available units. It tells you what a fair price looks like so you can judge listings you find elsewhere.
- **The server is local and single-user.** It binds to localhost. Only the static `static/` folder is meant to be hosted.

## Screenshots

These come from the earlier citywide version, so some show ZIP searches and the property lookup, which the current page does not have.

Compare median assessed value across neighborhoods (2007 to 2025):

![Median assessed value comparison](docs/screenshots/compare-assessed-value.png)

Eviction notices filed per year, with the in-progress year drawn dashed:

![Eviction notices per year](docs/screenshots/compare-evictions.png)

Eviction notices broken down by stated reason:

![Eviction reasons](docs/screenshots/compare-reasons.png)

The asking-rent benchmark by bedroom for a ZIP (Zillow plus Apartment List):

![Rent benchmark by bedroom](docs/screenshots/zip-rent-benchmark.png)

Look up one property's assessed-value history (the flat stretches are the Prop 13 cap; the jump is a reassessment on sale):

![Property lookup](docs/screenshots/property-lookup.png)
