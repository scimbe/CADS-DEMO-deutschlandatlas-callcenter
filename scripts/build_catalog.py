#!/usr/bin/env python3
"""
build_catalog.py — regenerate catalog.json for the Deutschlandatlas call-center demo
from the live github.com/bundesAPI/deutschlandatlas-api Readme.md.

Usage:
    python3 build_catalog.py [--verify N] [--out catalog.json]

--verify N   live-query N sampled indicator rows against the real Esri MapServer
             endpoint to confirm the README's field name ("x" column) actually
             exists in the response, and record region-identifier fields /
             a rough granularity signal. Without --verify, all rows are written
             with verified=false (structure-only regeneration).

Requires: `gh` CLI authenticated (to fetch the README raw content), `requests`.
"""
import argparse
import json
import random
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

README_SOURCE = "repos/bundesAPI/deutschlandatlas-api/contents/Readme.md"

QUERY_TEMPLATE = (
    "{url}/query?f=json&where=1%3D1&outFields=*&returnGeometry=false"
    "&resultRecordCount={n}"
)

REGION_FIELD_CANDIDATES = [
    "GEN", "BEZ", "Gebietskennziffer", "name", "NAME", "AGS", "ARS",
    "GEN_1", "BEZ_1", "RS", "SN_L", "SN_R", "SN_K", "SN_G",
]


def fetch_readme() -> str:
    out = subprocess.run(
        ["gh", "api", README_SOURCE, "-H", "Accept: application/vnd.github.raw"],
        check=True, capture_output=True, text=True,
    )
    return out.stdout


def parse_table(readme_text: str):
    """Parse the |title|snippet|url|x| markdown table into row dicts."""
    lines = readme_text.splitlines()
    rows = []
    in_table = False
    header_seen = 0
    for line in lines:
        if line.startswith("|title|snippet|url|x|"):
            in_table = True
            continue
        if not in_table:
            continue
        if line.startswith("|---"):
            continue
        if not line.startswith("|"):
            # table ended
            break
        cells = line.split("|")
        # line looks like: | a | b | c | d |  -> split gives ['', a, b, c, d, '']
        if len(cells) < 5:
            continue
        title = cells[1].strip()
        snippet = cells[2].strip()
        url = cells[3].strip()
        field = cells[4].strip()
        if not title:
            continue
        kind = "indicator" if field else "boundary_or_basemap"
        rows.append({
            "title": title,
            "snippet": snippet,
            "url": url,
            "field": field,
            "kind": kind,
        })
    return rows


TOPIC_KEYWORDS = {
    # Order matters: specific topics first, broad ones last (first match wins).
    "crime": ["kriminal", "straftat", "delikt"],
    "health": ["krankenhaus", "pflege", "arzt", "ärzt", "gesundheit", "hospital"],
    "education": ["schul", "abschluss", "bildung", "kita", "kindertag", "kinderbetr", "betreu", "studier"],
    "finance": ["steuer", "kredit", "einnahme", "kassenkredit", "verschuld", "defizit", "einkommen", "mindestsicher", "grundsicher"],
    "employment": ["beschäft", "arbeitslos", "arbeit", "erwerb", "pendel", "pendler", "verflechtung", "sozialversicher"],
    "infrastructure": ["ladepunkt", "ladestation", "elektrofahrz", "elektroantrieb", "pkw", "breitband", "glasfaser", "lte", "bahnhof", "fahrzeit", "erreichbar", "internet", "öpnv"],
    "environment": ["fläche", "erneuerbar", "energie", "klima", "siedlung", "natur", "heiz", "emission"],
    "housing": ["wohnung", "miete", "mietbelast", "baulandpreis", "eigenheim", "wohngeb", "wohnfläche", "fertiggestellt"],
    "demographics": ["bevölker", "wanderung", "ausländer", "geburt", "sterbe", "altersstruktur", "durchschnittsalter", "zuzug", "fortzug", "dichte", "je km", "wahlbeteil"],
}

# "Einwohner"/"Haushalt(e)" are per-capita DENOMINATORS, not topic signals. They must be
# stripped before keyword matching -- otherwise "wohn" inside "Ein-wohn-er" wrongly tags nearly
# every per-capita indicator as "housing" (this bug mislabeled the crime tables as housing,
# which in turn made the call-center's LLM matcher refuse crime questions).
DENOM_TERMS = ["einwohnerin", "einwohner", "haushalte", "haushalt"]


def guess_topic(snippet: str) -> str:
    s = (snippet or "").lower()
    for d in DENOM_TERMS:
        s = s.replace(d, "")
    for topic, kws in TOPIC_KEYWORDS.items():
        if any(kw in s for kw in kws):
            return topic
    return "other"


def http_get_json(url: str, timeout=20, retries=2, backoff=2.0):
    req = urllib.request.Request(url, headers={"User-Agent": "deutschlandatlas-callcenter-catalog/1.0"})
    last_exc = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            last_exc = e
            if attempt < retries:
                time.sleep(backoff * (attempt + 1))
    raise last_exc


def discover_feature_layer_id(mapserver_url: str):
    """The README's query template hardcodes layer id 0, but many services'
    actual queryable Feature Layer lives at a different id (0 is often a
    Raster Layer / cached basemap that cannot be attribute-queried at all).
    Fetch the MapServer root and return the first Feature Layer's id, or
    None if there isn't one."""
    try:
        meta = http_get_json(f"{mapserver_url}?f=json", timeout=15)
    except Exception:
        return None, None, None
    layers = meta.get("layers", []) or []
    capabilities = meta.get("capabilities", "") or ""
    for layer in layers:
        if layer.get("type") == "Feature Layer":
            return layer.get("id"), layers, capabilities
    return None, layers, capabilities


def verify_row(row: dict):
    """Live-query one row's MapServer endpoint; annotate row in place."""
    result = {
        "verified": False,
        "verify_error": None,
        "field_confirmed": None,
        "region_fields": [],
        "granularity_note": None,
        "sample_row_count": 0,
        "actual_layer_id": None,
        "readme_layer0_mismatch": False,
        "no_pagination_fallback": False,
    }

    layer_id, all_layers, capabilities = discover_feature_layer_id(row["url"])
    time.sleep(0.5)
    if layer_id is None:
        # fall back to layer 0 (README's documented default) even if we
        # couldn't confirm it's a Feature Layer, so we still attempt it
        layer_id = 0
    result["actual_layer_id"] = layer_id
    result["readme_layer0_mismatch"] = layer_id != 0

    if capabilities is not None and "Query" not in capabilities:
        result["verify_error"] = (
            f"service capabilities are '{capabilities}' — no Query capability, "
            "so this table's attribute data cannot be fetched via the query "
            "endpoint at all (a cached Map/tile-only service)"
        )
        row.update(result)
        return row

    url = QUERY_TEMPLATE.format(url=f"{row['url']}/{layer_id}", n=5)
    used_no_pagination_fallback = False
    try:
        data = http_get_json(url)
        # "Invalid or missing input parameters" on a Feature Layer with a
        # freshly-discovered id is often transient server-side throttling
        # rather than a real client error — one retry after a pause clears it.
        if isinstance(data, dict) and "error" in data and "Invalid or missing" in str(data["error"]):
            time.sleep(2.0)
            data = http_get_json(url)
        # Some services have supportsPagination=false and reject
        # resultRecordCount outright — another README-vs-reality gap, since
        # the README's documented query URL doesn't mention this. Retry
        # without it so we can still confirm the table is reachable.
        if isinstance(data, dict) and "error" in data and "Pagination is not supported" in str(data["error"]):
            no_pg_url = f"{row['url']}/{layer_id}/query?f=json&where=1%3D1&outFields=*&returnGeometry=false"
            data = http_get_json(no_pg_url)
            used_no_pagination_fallback = True
    except Exception as e:
        result["verify_error"] = f"request failed: {e}"
        row.update(result)
        return row

    if "error" in data:
        detail = data["error"]
        if all_layers is not None and layer_id == 0 and not any(
            l.get("type") == "Feature Layer" for l in all_layers
        ):
            detail = f"{detail} (no Feature Layer found in service — likely basemap/raster)"
        result["verify_error"] = f"API error: {detail}"
        row.update(result)
        return row

    features = data.get("features", [])
    fields_meta = data.get("fields", [])
    field_names = [f.get("name") for f in fields_meta] if fields_meta else (
        list(features[0]["attributes"].keys()) if features else []
    )

    if not features:
        result["verify_error"] = "no features returned"
        row.update(result)
        return row

    result["verified"] = True
    result["no_pagination_fallback"] = used_no_pagination_fallback
    result["sample_row_count"] = min(len(features), 5) if used_no_pagination_fallback else len(features)
    result["field_confirmed"] = row["field"] in field_names if row["field"] else None

    present_region_fields = [f for f in REGION_FIELD_CANDIDATES if f in field_names]
    result["region_fields"] = present_region_fields

    # rough granularity signal: look at Gebietskennziffer length / distinctness, or GEN sample names
    sample_names = []
    for feat in features[:5]:
        attrs = feat.get("attributes", {})
        for key in ("GEN", "name", "NAME"):
            if key in attrs and attrs[key]:
                sample_names.append(str(attrs[key]))
                break
    gkz_field = "Gebietskennziffer" if "Gebietskennziffer" in field_names else None
    gkz_lengths = set()
    if gkz_field:
        for feat in features[:5]:
            v = feat.get("attributes", {}).get(gkz_field)
            if v is not None:
                gkz_lengths.add(len(str(v)))
    note_parts = []
    if sample_names:
        note_parts.append(f"sample region names: {sample_names[:3]}")
    if gkz_lengths:
        note_parts.append(f"Gebietskennziffer digit-lengths seen: {sorted(gkz_lengths)}")
    if not note_parts:
        note_parts.append(f"fields present: {field_names[:8]}")
    result["granularity_note"] = "; ".join(note_parts)

    row.update(result)
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", type=int, default=0, help="number of indicator rows to live-verify")
    ap.add_argument("--verify-boundaries", type=int, default=0, help="number of boundary/basemap rows to live-verify")
    ap.add_argument("--out", default="catalog.json")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    print("Fetching README from github.com/bundesAPI/deutschlandatlas-api ...", file=sys.stderr)
    readme_text = fetch_readme()
    rows = parse_table(readme_text)
    print(f"Parsed {len(rows)} table rows.", file=sys.stderr)

    for r in rows:
        r["topic_guess"] = guess_topic(r["snippet"])
        r["verified"] = False
        r["verify_error"] = None
        r["field_confirmed"] = None
        r["region_fields"] = []
        r["granularity_note"] = None
        r["sample_row_count"] = 0

    indicators = [r for r in rows if r["kind"] == "indicator"]
    boundaries = [r for r in rows if r["kind"] == "boundary_or_basemap"]

    if args.verify:
        random.seed(args.seed)
        # spread sample across topics
        by_topic = {}
        for r in indicators:
            by_topic.setdefault(r["topic_guess"], []).append(r)
        for lst in by_topic.values():
            random.shuffle(lst)
        topics = list(by_topic.keys())
        sample = []
        i = 0
        while len(sample) < args.verify and any(by_topic.values()):
            t = topics[i % len(topics)]
            if by_topic[t]:
                sample.append(by_topic[t].pop())
            i += 1
            if i > 10000:
                break
        print(f"Live-verifying {len(sample)} indicator rows across topics: "
              f"{sorted(set(r['topic_guess'] for r in sample))}", file=sys.stderr)
        for r in sample:
            print(f"  querying {r['title']} ...", file=sys.stderr)
            verify_row(r)
            time.sleep(1.0)

    if args.verify_boundaries:
        # Prioritize actual VG250 administrative-boundary layers (the region-
        # resolution candidates per the project's decided architecture) over
        # generic empty-field "feature abfrage" rows when sampling.
        vg250 = [r for r in boundaries if r["title"].startswith("VG250")]
        rest = [r for r in boundaries if not r["title"].startswith("VG250")]
        random.shuffle(vg250)
        random.shuffle(rest)
        sample_b = (vg250 + rest)[: args.verify_boundaries]
        print(f"Live-verifying {len(sample_b)} boundary/basemap rows", file=sys.stderr)
        for r in sample_b:
            print(f"  querying {r['title']} ...", file=sys.stderr)
            verify_row(r)
            time.sleep(1.0)

    catalog = {
        "source": "https://github.com/bundesAPI/deutschlandatlas-api/blob/main/Readme.md",
        "generated_by": "build_catalog.py",
        "query_template": "https://www.karto365.de/hosting/rest/services/{table}/MapServer/{layer_id}/query?f=json&where=1%3D1&outFields=*&returnGeometry=false",
        "query_template_caveat": (
            "The upstream README documents this URL with a hardcoded layer id "
            "of 0, but live verification found that is frequently wrong: many "
            "tables' actual queryable Feature Layer lives at id 3, 4, 5, or 6, "
            "and id 0 is often an unqueryable cached Raster Layer instead. "
            "Always discover the real Feature Layer id per table first (GET "
            "{table}/MapServer?f=json, find the layer with type=='Feature "
            "Layer') rather than assuming /0/. See 'actual_layer_id' and "
            "'readme_layer0_mismatch' on verified rows in this catalog."
        ),
        "total_rows": len(rows),
        "indicator_count": len(indicators),
        "boundary_or_basemap_count": len(boundaries),
        "rows": rows,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)

    verified_count = sum(1 for r in rows if r["verified"])
    failed_count = sum(1 for r in rows if r.get("verify_error"))
    print(f"Wrote {args.out}: {len(rows)} rows ({len(indicators)} indicators, "
          f"{len(boundaries)} boundary/basemap), {verified_count} live-verified OK, "
          f"{failed_count} live-verify attempts that failed.", file=sys.stderr)


if __name__ == "__main__":
    main()
