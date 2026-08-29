# Deutschlandatlas Call-Center Demo — Catalog & Architecture

> **Status: catalog + architecture only.** There is no n8n workflow yet, no
> speech-to-text or text-to-speech yet, no call handling of any kind. This
> repo is the first concrete building block for a future n8n-based voice
> call-center demo backed by the [Deutschlandatlas](https://www.deutschlandatlas.bund.de/)
> — nothing more. Don't mistake it for a working demo.

## What this is

A machine-readable **catalog** of every table exposed by
[bundesAPI/deutschlandatlas-api](https://github.com/bundesAPI/deutschlandatlas-api),
plus the tooling to regenerate that catalog from the live upstream README,
plus documentation of how a future call-center agent would resolve a spoken
German place name to the region code these tables are keyed on — **without**
depending on any third-party geocoding service.

The Deutschlandatlas is a public German-government data portal (published by
the BMWSB) with ~150 regional indicators — employment, housing, demographics,
infrastructure, environment, health, education — each queryable as JSON from
a public, unauthenticated Esri ArcGIS Feature Service.

## Files

| File | Purpose |
|---|---|
| `catalog.json` | The generated catalog: every parsed table, its query URL, its value field, and (for a live-verified sample) the real schema, region-identifier fields, and pass/fail status. |
| `scripts/build_catalog.py` | Regenerates `catalog.json` from the **live** upstream README — run it again any time the upstream table changes. Requires `gh` CLI (authenticated) and Python 3. |

## Regenerating the catalog

```bash
# structure-only (no live API calls, all rows verified:false)
python3 scripts/build_catalog.py --out catalog.json

# also live-verify N sampled indicator rows + M boundary/basemap rows
python3 scripts/build_catalog.py --verify 24 --verify-boundaries 4 --out catalog.json
```

The script:
1. Fetches `Readme.md` from `bundesAPI/deutschlandatlas-api` via `gh api` (raw content, always current).
2. Parses the `|title|snippet|url|x|` markdown table into structured rows. A row
   with an **empty** `x` column is tagged `kind: "boundary_or_basemap"`
   (it's a basemap/boundary layer, not a real indicator); a row with a value
   there is tagged `kind: "indicator"`.
3. Optionally live-queries a topic-spread sample of rows against the real
   MapServer endpoint and records what it actually found — see below.

## catalog.json schema (per row)

```jsonc
{
  "title": "beschq_insg_HA2022",           // {table} name used in the URL
  "snippet": "Sozialversicherungspflichtig …",  // German description from the README
  "url": "https://www.karto365.de/hosting/rest/services/beschq_insg_HA2022/MapServer",
  "field": "beschq_insg",                  // README's "x" column — the value field
  "kind": "indicator",                     // or "boundary_or_basemap"
  "topic_guess": "employment",             // heuristic keyword match on the German snippet
  "verified": true,                        // was this row live-tested? (false = not sampled)
  "verify_error": null,                    // set when a live-verify attempt failed, with why
  "field_confirmed": true,                 // does README's "x" field actually exist in the live response?
  "region_fields": ["GEN", "BEZ", "Gebietskennziffer", "name"],
  "granularity_note": "sample region names: ['Flensburg', 'Kiel', 'Lübeck']",
  "sample_row_count": 5,
  "actual_layer_id": 3,                    // the real queryable Feature Layer id (see below)
  "readme_layer0_mismatch": true,          // true when actual_layer_id != 0
  "no_pagination_fallback": false
}
```

## What live verification found

Out of 199 parsed table rows (152 `indicator`, 47 `boundary_or_basemap`), 29
were live-verified this pass: **26 passed**, 3 failed for documented, benign
reasons (a cached Map-only tile service with no `Query` capability, and one
`Raster Layer` basemap with no attribute data — both correctly pre-classified
as `boundary_or_basemap` by the empty-`x`-column rule). The verified sample
spans employment, housing, demographics, infrastructure, environment, health,
and education indicators. No `crime`-topic indicators exist anywhere in this
dataset — Deutschlandatlas is a regional-development atlas, not police/crime
statistics, so a call-center demo built on it cannot answer crime questions.

Two concrete discrepancies between the README and the live API, worth knowing
before anyone builds a workflow on top of this:

1. **The README's documented query URL hardcodes layer id `0`
   (`.../MapServer/0/query?...`) — but this is frequently wrong.** In our
   verified sample, **14 of 26** passing rows had their real queryable
   Feature Layer at id 3, 4, 5, or 6 instead — id 0 is very often an
   unqueryable cached `Raster Layer` (a basemap tile) rather than the actual
   data. **Never assume `/0/`.** Always discover the real layer id first:
   `GET {table}/MapServer?f=json`, then use the entry in `"layers"` whose
   `"type"` is `"Feature Layer"`. `build_catalog.py`'s `discover_feature_layer_id()`
   does exactly this, and every verified row in `catalog.json` records the
   real id in `actual_layer_id`.
2. **Some services reject the `resultRecordCount` parameter outright**
   (`supportsPagination: false` → `"Pagination is not supported."`), e.g.
   `pendel_a_HA2023` and the `VG250_LAN1217_grenzen` boundary layer. The
   script retries such rows without that parameter (`no_pagination_fallback: true`).

What **matched** the README: every `field_confirmed` in the verified sample
is `true` — the README's `x` column (the value field name) was accurate in
100% of the rows we tested. The mismatch is in the query *URL*, not the
field names.

Geographic granularity also varies per table and is **not** uniform — this
matches the project's ground truth and our own findings: most of the sampled
indicator tables return one row per `Gebietskennziffer` at Kreis
(county/kreisfreie-Stadt) level (e.g. `Flensburg`, `Kiel`, `Lübeck` —
8-9 digit `Gebietskennziffer`), while the boundary layer
`VG250_Verbandsgemeinden1219_Punkt` returns one row per
Verbandsgemeinde/Amt (finer than Kreis, using a 9-digit `ARS` code instead
of `Gebietskennziffer`), and `VG250_LAN1217_grenzen` returns exactly the 16
German Länder (2-digit `RS`/`AGS`). **Don't assume a fixed granularity —
check each table's own region fields and code length before using it.**

## Region resolution: boundary layers, not a geocoder

Per this project's already-decided architecture, a spoken German place name
is resolved to the `Gebietskennziffer` (official municipality/county code)
that the indicator tables are keyed on **using the Deutschlandatlas'
own administrative boundary layers** — never a third-party geocoding
service. Confirmed live:

- **`VG250_LAN1217_grenzen`** — Länder (state) boundaries. Query
  `.../MapServer/0/query?...` returns exactly the 16 German states with
  real `GEN` (name, e.g. `"Bayern"`, `"Nordrhein-Westfalen"`), `BEZ` (type,
  e.g. `"Freistaat"`, `"Land"`), `RS`/`AGS` (2-digit state code) fields.
- **`VG250_Verbandsgemeinden1219_Punkt`** (layer 0) — municipality-association
  level boundaries. Returns real `GEN` (e.g. `"Lübeck"`, `"Brunsbüttel"`,
  `"Mitteldithmarschen"`), `BEZ` (`"Amtsfreie Gemeinde"`, `"Amt"`), and a
  9-digit `ARS` code.
- A handful of other `VG250_*` rows in the catalog (`VG250_GEM1217_neu`,
  `VG250_Kreise_1221_Punkte`, `VG250_Kreise1219_Punkt`, `VG250_v_lte_Grenzen`)
  are **cached Map-tile services with no `Query` capability** — they render
  a map image but cannot return attribute rows via this API and are *not*
  usable for programmatic region lookup. This was discovered by live testing,
  not assumed — see their `verify_error` in `catalog.json`.

The future workflow's plan: match a recognized place name against `GEN`
values in the boundary layer(s) that actually support `Query`, at the finest
granularity available for the target indicator, and use the matched row's
region code (`Gebietskennziffer` / `AGS` / `ARS` — the exact field varies per
layer, see `region_fields`) to filter or join against the indicator table.
This still needs a fuzzy/normalized match strategy (umlauts, "Sankt" vs
"St.", Kreis vs. kreisfreie Stadt naming) which is **not yet designed or
implemented** — this repo only proves the data exists and is reachable.

## Grounding requirement (project rule — non-negotiable)

**Every fact the call-center agent speaks to a caller must come from a real,
live API response — never from the model's own knowledge or invention.**
This is not a nice-to-have; it is the whole point of building on a real
government data API instead of just asking an LLM. Concretely, whatever
n8n workflow eventually consumes this catalog must:

- Resolve the caller's named place to a region code via a live boundary-layer
  query (see above) — never guess a `Gebietskennziffer`.
- Fetch the requested indicator's value via a live query against the
  indicator's actual (verified) MapServer URL and layer id — never recall
  or approximate a number from training data.
- If a live query fails or returns no matching row, the agent must say so
  and decline to answer rather than fabricate a plausible-sounding figure.

## Source

Catalog derived from
[`github.com/bundesAPI/deutschlandatlas-api`](https://github.com/bundesAPI/deutschlandatlas-api)'s
`Readme.md`, live as of the last `build_catalog.py` run recorded in
`catalog.json`'s `source` field. Data itself is served by
`karto365.de` (the underlying Esri ArcGIS hosting used by the
Deutschlandatlas / BMWSB).
