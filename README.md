# Deutschlandatlas Call-Center Demo — Catalog, Architecture, n8n Workflow & Speech I/O

> **Status: catalog + architecture + n8n workflow + speech I/O (STT/TTS),
> and now wired together and run end-to-end with real audio, real live
> ArcGIS data, and the real litellm-proxy** (see
> [Integration & end-to-end verification](#integration--end-to-end-verification)
> below) — `scripts/run_callcenter_pipeline.py` drives
> STT → the workflow's real logic (`scripts/n8n_workflow_runtime.mjs`) → TTS
> as one process, with no n8n instance and no SIP/telephony leg. A real
> caller question was spoken (Piper), transcribed back (whisper.cpp),
> answered from a live ArcGIS query with the correct real figure, spoken
> again, and transcribed back once more to confirm the number really made
> it into the audio — not just the text. **One real, load-bearing gap was
> found by this integration testing, not assumed away:** the catalog-match
> LLM step is not reliably matching some real, existing tables (crime-rate,
> unemployment) against natural caller phrasing at the dataset's full
> 152-candidate scale, and is not even fully deterministic run-to-run at
> `temperature: 0` on the shared local model — see that section for the
> live evidence. The underlying data/query/grounding machinery itself is
> proven solid; the catalog-match step's match *rate* is not yet reliable
> enough to call this "done" for arbitrary caller questions. Still no
> n8n instance was started (the workflow JSON has not been imported and
> run inside actual n8n), and there is still no SIP/telephony/microphone
> input — see [Not yet done](#not-yet-done-integration) for the precise
> boundary of what is and isn't proven.

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
| `n8n/callcenter-workflow.json` | The n8n workflow (30 nodes) — see [n8n Workflow](#n8n-workflow) below. |
| `src/callcenter_speech/` | STT + TTS module — see [Speech I/O](#speech-io-stttts) below. |
| `scripts/setup_piper_voice.sh` | Creates `.venv`, installs `piper-tts`, downloads the German Piper voice into `voices/`. |
| `scripts/setup_whisper_cpp.sh` | Clones + builds `whisper.cpp` (pinned tag) into `vendor/`, downloads a multilingual ggml model. |
| `scripts/n8n_workflow_runtime.mjs` | Runs the workflow's real `jsCode` (extracted verbatim from `n8n/callcenter-workflow.json`) outside of n8n, following the real `if`-node branches and making real live calls (ArcGIS + litellm-proxy) — see [Integration & end-to-end verification](#integration--end-to-end-verification). |
| `scripts/run_callcenter_pipeline.py` | The STT → workflow → TTS glue script — the actual end-to-end entry point for this demo. |

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

## Speech I/O (STT/TTS)

`src/callcenter_speech/` is a small, standalone module for the two speech
directions a voice call-center needs — **it does not know about n8n, the
catalog, or place-name resolution**. It plugs into a plain-text interface on
both sides (someone else's workflow provides the text in and consumes the
text out), matching the project's split between this repo's speech I/O and
the separate n8n-workflow track:

```python
from callcenter_speech import transcribe, synthesize

text = transcribe("caller-audio.wav")          # German speech -> text
wav  = synthesize("Die Antwort lautet …")       # text -> German speech (WAV path)
```

Both engines are real, local, offline — no cloud STT/TTS API, no account, no
per-call cost:

- **TTS: [Piper](https://github.com/rhasspy/piper)** with the German
  `de_DE-thorsten-medium` voice — the same TTS engine already proven in
  `CADS-DEMO-explainer` (English) and `CADS-DEMO-podcast`, here with a German
  voice instead, since this is a German-language demo.
- **STT: [whisper.cpp](https://github.com/ggml-org/whisper.cpp)** with a
  **multilingual** ggml model (`base` by default — explicitly *not* an
  English-only `.en` model, which cannot transcribe German at all) — the
  same STT engine already proven in `CADS-DEMO-podcast`.

### Setup

```bash
bash scripts/setup_piper_voice.sh    # .venv + piper-tts, downloads voices/de_DE-thorsten-medium.onnx (~63MB)
bash scripts/setup_whisper_cpp.sh    # clones+builds vendor/whisper.cpp, downloads ggml-base.bin (~148MB, multilingual)
```

Both scripts fail loudly (non-zero exit, explicit `FATAL:` message) rather
than silently continuing if a download fails — the same "measure, don't
mock" discipline as the rest of this project's tooling.

### Usage

```bash
# Text -> German speech (WAV)
PYTHONPATH=src python3 -m callcenter_speech.tts "Willkommen beim Deutschlandatlas Callcenter." out.wav

# German speech -> text
PYTHONPATH=src python3 -m callcenter_speech.stt caller-audio.wav
```

`transcribe()` accepts any ffmpeg-readable audio format (it resamples to the
16kHz mono PCM WAV whisper.cpp requires internally via `audio_util.py`), so
telephony audio (e.g. 8kHz from a call leg) doesn't need pre-conversion by
the caller.

### Live verification (real audio, not just wiring)

Both directions were exercised end-to-end with real audio, not assumed to
work from the code alone — see the exact commands and real output in this
module's test suite (`tests/test_tts.py`, `tests/test_stt.py`, run via
`python3 -m unittest discover -s tests`) and below:

```
$ PYTHONPATH=src python3 -m callcenter_speech.tts "Willkommen beim Deutschlandatlas Callcenter. Wie kann ich Ihnen helfen?" /tmp/da-tts-test.wav
+ echo '...' | .venv/bin/piper --model voices/de_DE-thorsten-medium.onnx --output_file /tmp/da-tts-test.wav
/tmp/da-tts-test.wav          # 154668 bytes, 22050Hz mono, 3.51s (ffprobe-confirmed)

$ PYTHONPATH=src python3 -m callcenter_speech.stt /tmp/da-tts-test.wav
Willkommen beim Deutschland-Atlas-Kalkenter, wie kann ich Ihnen helfen?
```

(The `base` model mishears the English loanword "Callcenter" as
"Kalkenter" — a real, minor multilingual-ASR artifact, not a wiring bug; a
second independent round-trip with a domain-relevant sentence —
"Wie hoch ist die Arbeitslosenquote in Bayern im Jahr zweitausendzweiundzwanzig?"
— came back as "Wie hoch ist die arbeitslosen Quote in Bayern im Jahr 2022?",
correctly recognizing the spelled-out year as digits. For materially better
German accuracy, including on loanwords like this, re-run
`WHISPER_MODEL_NAME=small bash scripts/setup_whisper_cpp.sh` — ~488MB,
substantially more accurate multilingual German transcription than `base`.)

### License

- **Piper** itself: MIT.
- **The `de_DE-thorsten-medium` voice model**: **CC0** (public domain) —
  trained on the [Thorsten-Voice](https://github.com/thorstenMueller/Thorsten-Voice)
  dataset, per its [model card](https://huggingface.co/rhasspy/piper-voices/blob/main/de/de_DE/thorsten/medium/MODEL_CARD)
  on the [piper-voices](https://huggingface.co/rhasspy/piper-voices) model
  repository. Not committed to git (downloaded by `setup_piper_voice.sh`,
  gitignored) — same convention as `CADS-DEMO-explainer/voices/`.
- **whisper.cpp**: MIT.
- **The ggml multilingual models** (`base`/`small`/…): released by OpenAI
  under **MIT**, redistributed as ggml-format weights at
  [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp).
  Not committed to git (downloaded by `setup_whisper_cpp.sh` into
  `vendor/whisper.cpp/models/`, gitignored).

### Not yet done

- No microphone/telephony capture — `transcribe()` takes a file path, it
  doesn't record one. A real deployment needs a SIP/telephony leg (out of
  scope for this track) to produce that file.
- No streaming/partial transcripts — each call is a single
  synthesize-a-full-utterance / transcribe-a-full-utterance round trip.
- No place-name resolution wired to this module — that's the separate
  boundary-layer matching work described below, which the n8n workflow (not
  this module) will need to call between STT and TTS.

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

## n8n Workflow

`n8n/callcenter-workflow.json` is a hand-authored, importable n8n workflow
(30 nodes: `webhook`, `httpRequest`, `code`, `if`, `respondToWebhook`) that
implements everything above end-to-end: caller text in, an LLM match against
the real catalog, live layer/schema discovery, a live filtered query, and an
LLM-phrased answer grounded strictly in the data that query returned. It
does **not** touch audio — the separate STT/TTS track
(`src/callcenter_speech/`, above) plugs in on both sides of this workflow's
plain-text webhook.

### Input / output contract

```
POST <n8n base>/webhook/deutschlandatlas-callcenter
Content-Type: application/json
{ "query": "Wie viele Schulabgänger in Kiel haben keinen Hauptschulabschluss?" }

-> 200 OK
{
  "text": "In Kiel, Landeshauptstadt, haben 8,48 Prozent der Schulabgänger im Jahr 2021 keinen Hauptschulabschluss. …",
  "meta": {
    "matched": true, "reformulated": false, "table": "schule_oabschl_HA2023",
    "field": "schule_oabschl", "source_url": "https://www.karto365.de/hosting/rest/services/schule_oabschl_HA2023/MapServer",
    "layer_id": 5, "where_clause": "UPPER(GEN) LIKE UPPER('%Kiel%')",
    "place_name_requested": "Kiel", "place_resolved": null,
    "has_real_data": true, "data_error": null, "live_rows_used": 1
  }
}
```

`text` is exactly what the TTS side should speak; `meta` is for logging/
debugging (which real table and where-clause produced the answer), not
something the caller hears.

### Required environment (n8n instance)

Same convention as every other demo in this portfolio (see
`CADS-DEMO-codereview`/`explainer`/`travel`'s `llmClient.js` / `.env`):

| Variable | Purpose |
|---|---|
| `LITELLM_BASE_URL` | e.g. `https://llm-34a13a96.bunsenbrenner.org/v1` — **includes** the `/v1` prefix; the workflow appends only `/chat/completions`. |
| `LITELLM_API_KEY` | Bearer token for the litellm-proxy. |
| `LITELLM_DEFAULT_MODEL` | `local-devstral-small2` (used for both LLM calls; falls back to this literal if unset). |

n8n must be able to resolve these as `$env.*` in expressions (default for
self-hosted n8n; no other credential/config is needed — `catalog.json` is
fetched live from this repo's GitHub raw URL at runtime, so no volume mount
is required either).

### The five phases (33→30 nodes after a fix described below)

1. **Catalog match** (`Caller Query In` → `Fetch Catalog (GitHub)` →
   `Build Catalog Match Prompt` → `LLM Match Catalog` → `Validate Catalog
   Match` → `Catalog Match Found?`). The LLM sees a compact `{title, field,
   topic, snippet}` view of all 152 real indicator rows and picks one
   verbatim, or reformulates to a nearby real one, or declines. **The
   model's answer is never trusted blindly**: `Validate Catalog Match`
   deterministically checks the returned `table` string exists verbatim in
   `catalog.json` before proceeding — a hallucinated table name fails
   closed into the "no match" branch rather than triggering a query against
   a URL that doesn't exist in the catalog.
2. **Layer + schema discovery** (`Get Indicator MapServer Metadata` →
   `Pick Indicator Layer` → `Indicator Service Queryable?` →
   `Discover Indicator Fields` → `Handle Field Discovery Result` →
   `Finalize Schema`). Implements the project's core constraint exactly:
   `GET {table}/MapServer?f=json`, take the entry in `"layers"` whose
   `"type"` is `"Feature Layer"` — **never** assume `/0/`. If the service's
   root `capabilities` string doesn't contain `"Query"` (a cached map-tile
   service), that's handled as a real, honest failure (`Mark Service Not
   Queryable`), not a silent skip.
3. **Region resolution** (`Has Direct Name Field And Place Given?` →
   either `Build Where Clause Direct Filter`, or `Place Given But No Direct
   Field?` → boundary-layer enrichment via `VG250_Verbandsgemeinden1219_Punkt`
   (`Boundary Layer Metadata` → `Pick Boundary Layer` → `Query Boundary For
   Place` → `Check Boundary Match`), or `Build Where Clause No Filter`).
   Two real, live-verified findings from the samples in `catalog.json` drove
   this design:
   - Several indicator tables carry `GEN`/`name` **directly in their own
     schema** (e.g. `schule_oabschl_HA2023`, `ko_kasskred_HA2022`) — for
     those, the workflow filters the indicator query itself with
     `UPPER(GEN) LIKE UPPER('%<place>%')`. No boundary-layer join needed.
   - For tables **without** a place field (e.g. `pendel_a_HA2023`, an
     origin/destination commuter matrix), the only two *queryable* boundary
     layers (`VG250_LAN1217_grenzen`, 2-digit Land; and
     `VG250_Verbandsgemeinden1219_Punkt`, 9-digit `ARS`) do **not** share a
     digit-length/granularity with the Kreis-level `Gebietskennziffer` most
     indicator tables use. A numeric-prefix "join" across that mismatch
     could silently return the wrong region's number — forbidden by the
     grounding requirement above. So this workflow deliberately does **not**
     attempt that join: it uses the boundary layer only to confirm/
     canonicalize the caller's place name, then queries the indicator table
     unfiltered and has the phrasing LLM state plainly, using the table's
     real field list, that this particular table can't be narrowed to that
     place. This is a documented scope decision, not an oversight — see
     `Check Boundary Match`'s code comment.
   - A related honest limitation surfaced by live testing: the boundary
     layer's `GEN` match is **not** umlaut-normalized — `UPPER(GEN) LIKE
     UPPER('%Luebeck%')` returns zero rows while `'%Lübeck%'` matches. The
     workflow relies on the caller-query LLM step to extract `place_name` in
     correctly-accented German (which it does in practice — verified live,
     see below); a dedicated umlaut/fuzzy-match layer is not implemented.
4. **Final query + phrasing** (`Query Indicator Data Final` → `Validate
   Final Data` → `Build Phrasing Prompt` → `LLM Phrase Answer` → `Extract
   Final Answer` → `Respond With Answer`). The phrasing LLM is handed
   *only* the caller's question and the literal JSON the live query just
   returned, with an explicit instruction to use nothing else — not even
   something that "sounds right" — and to say plainly what isn't covered
   rather than fill the gap. The same prompt shape (with a `failure_reason`
   instead of data) handles the "service not queryable" / "query errored" /
   "no rows found" cases, so the caller always gets a spoken answer, never a
   raw error.
5. **No-match path** (`Catalog Match Found?`'s false branch →
   `No Catalog Match Response` → `Respond No Match`). A deterministic,
   non-LLM-generated refusal — no fact is spoken, so there's nothing to
   fabricate.

**A real bug found and fixed while verifying, not just theorized:** the
first draft of phase 4 sent `resultRecordCount` on every query, including
the final one. That breaks on any table with `supportsPagination: false`
(`pendel_a_HA2023`, `VG250_LAN1217_grenzen` — see "What live verification
found" above) with a live `"Pagination is not supported."` error, which
would have made the workflow return a spurious "no data" for those tables
even though real data exists. Fixed by never sending `resultRecordCount` at
all and instead capping the parsed feature list client-side (first 5 for
schema discovery, first 10 for the final answer) — this is *why* the
pagination-retry subchain from an earlier draft (33 nodes) isn't in the
current 30-node version: omitting the parameter everywhere is strictly
simpler and avoids the whole error class, not just a workaround for it.

### Verification: what's real vs. what's authored-but-not-run-in-n8n

**Not run inside n8n itself** — no n8n instance was started for this task;
the workflow was authored directly as JSON against the real API shapes this
repo already had live-verified, per the task's stated fallback. That said,
every non-LLM code path was verified for real, not just eyeballed:

- **All 15 `code` nodes' `jsCode`** were extracted and run **verbatim**
  (byte-for-byte from the committed JSON, not a paraphrase) in a small
  Node.js harness that reimplements n8n's `$input` / `$('Node Name')` /
  `$env` execution model, driving them with **real, live HTTP responses**
  from `raw.githubusercontent.com` (the catalog fetch) and
  `karto365.de` (every MapServer/query call) — not mocked data. Four
  end-to-end scenarios passed this way:
  1. Direct-name-field filter, real data: `schule_oabschl_HA2023` × `Kiel`
     → real live layer discovery (id 5), real filtered query, correct
     `8.48` value round-tripped into the final response.
  2. No-direct-field boundary enrichment, including the pagination-fix:
     `pendel_a_HA2023` × `Lübeck` → real layer discovery, real schema
     query (would have 400'd pre-fix), real boundary-layer resolution of
     "Lübeck", correct unfiltered-with-honest-reason phrasing prompt.
  3. No catalog match (crime question) → deterministic refusal, no API
     calls attempted past the LLM match step.
  4. A model hallucinating a non-existent table name → deterministically
     rejected by `Validate Catalog Match` before any MapServer call.
  5. (separate check) A real cached map-tile service
     (`VG250_GEM1217_neu`, `capabilities: "Map"`, no `Query`) correctly
     routed through `Mark Service Not Queryable` into the honest-failure
     phrasing prompt.
- **Both LLM calls' prompt design were separately proven live** against the
  real litellm-proxy (`local-devstral-small2`) with the actual 152-row
  candidate list (~34KB request), not a toy subset:
  - Catalog matching correctly picked `schule_oabschl_HA2023` for the Kiel
    question, extracted `place_name: "Kiel"` correctly, and returned the
    table title **verbatim** (byte-identical to `catalog.json`).
  - Catalog matching correctly declined ("no match") a rent-burden question
    the dataset genuinely doesn't cover, and a crime-rate question (this
    dataset only regional-development indicators — no crime topic exists,
    confirmed in "What live verification found" above).
  - Phrasing, given the real Kiel/`schule_oabschl` JSON, produced a
    German sentence using *only* the `8.48`/Kiel facts present, and
    **explicitly declined** to invent the absolute headcount the caller's
    "wie viele" phrasing implied but the data (a percentage) doesn't
    contain — exactly the anti-fabrication behavior this workflow is
    built to enforce.
- **Not separately re-run**: the harness scenarios reuse these
  already-proven-live LLM outputs as fixtures for the two `httpRequest`
  LLM-call nodes (to avoid repeated cost on a budget-capped shared
  litellm-proxy key), rather than calling the live model a second time
  inside the same harness run. The prompts fed to the LLM in the harness are
  the literal ones the real `Build Catalog Match Prompt` / `Build Phrasing
  Prompt` code produced from real catalog/API data, so what was separately
  proven live is proven against byte-identical inputs — but the harness run
  itself did not re-hit the LLM endpoint.
- **What was never exercised**: the actual n8n runtime (its expression
  parser resolving `={{ }}` strings, `sendQuery`/`sendBody` HTTP-node
  behavior, the `if` node's `conditions` schema on a live n8n version) —
  only the logic inside the `code` nodes and the correctness of the API
  calls that logic constructs. Importing this JSON into a real n8n instance
  and running it once end-to-end is the natural next verification step
  before calling this "done".

### Known scope limitations (honest, not hidden)

- Only `VG250_Verbandsgemeinden1219_Punkt` is used for boundary
  enrichment; a `VG250_LAN1217_grenzen` fallback for state-level place names
  (e.g. "Bayern") would follow the identical pattern but isn't wired up.
- No umlaut/fuzzy place-name normalization (see above) — relies on the
  catalog-match LLM step extracting the place name correctly, which it did
  in every case tested live but is not a guarantee.
- `resultRecordCount` is never sent, so an unfiltered query against a very
  large table returns whatever the server's own default page size is before
  the client-side cap of 10 applies — fine for a demo, not tuned for scale.
- No SIP/telephony, no streaming — matches the STT/TTS module's own stated
  scope above.

## Integration & end-to-end verification

The two tracks above (`src/callcenter_speech/` and `n8n/callcenter-workflow.json`)
both plug into the same plain-text contract — a caller question in, a
spoken-ready answer out — so wiring them together is genuinely one glue
layer, not a redesign:

```
caller audio --[STT, whisper.cpp]--> question text
question text --[scripts/n8n_workflow_runtime.mjs]--> { text, meta }   (real litellm-proxy + real ArcGIS calls)
answer text  --[TTS, Piper]--> answer audio
```

- **`scripts/n8n_workflow_runtime.mjs`** runs the workflow's real `code`
  nodes' `jsCode` **extracted verbatim** from the committed
  `n8n/callcenter-workflow.json` (same technique used to verify the
  workflow while it was being built — see [Verification](#verification-whats-real-vs-whats-authored-but-not-run-in-n8n)
  above), but unlike that harness it **follows the workflow's real
  `if`-node branch conditions** to pick a path automatically instead of a
  scenario picking it by hand, and it makes **real live calls to the
  litellm-proxy** for both LLM steps instead of replaying a captured
  fixture. It still does not start an actual n8n instance — see the
  boundary this leaves unproven, below.
- **`scripts/run_callcenter_pipeline.py`** is the actual STT → workflow →
  TTS entry point: it can speak a caller question with Piper and
  transcribe it back with whisper.cpp before handing it to the workflow
  (`--synthesize-caller`), or take a real pre-recorded audio file
  (`--audio`), or skip caller-side STT and pass text directly (`--text`);
  it always speaks the workflow's final answer with Piper and (unless
  `--no-verify-answer`) transcribes that answer audio back with
  whisper.cpp, so the grounding claim can be checked against what the
  audio actually contains, not just the text the workflow returned.

### Real run #1 — grounded answer, full audio round trip

```bash
LITELLM_BASE_URL=... LITELLM_API_KEY=... LITELLM_DEFAULT_MODEL=local-devstral-small2 \
  PYTHONPATH=src python3 scripts/run_callcenter_pipeline.py \
  --text "Wie viele Schulabgänger in Kiel haben keinen Hauptschulabschluss?" \
  --synthesize-caller
```

What actually happened, in order, all real:
1. Piper spoke the caller question; whisper.cpp transcribed it back
   **verbatim correctly**.
2. The real litellm-proxy call matched `schule_oabschl_HA2023`, extracted
   `place_name: "Kiel"`.
3. A real `GET .../MapServer?f=json` found the real queryable layer (id 5).
4. A real filtered query (`UPPER(GEN) LIKE UPPER('%Kiel%')`) returned
   exactly one row: `{"GEN": "Kiel", "schule_oabschl": 8.48, ...}` —
   independently re-confirmed with a bare `curl` against the same live
   endpoint at report time, still `8.48`.
5. The real phrasing LLM call produced: *"In Kiel, Landeshauptstadt,
   hatten im Jahr 2021 8,48 Prozent der Schulabgänger keinen
   Hauptschulabschluss. Die genaue Anzahl der Schulabgänger ohne
   Hauptschulabschluss ist in den vorliegenden Daten nicht enthalten."* —
   correctly declining to invent the absolute headcount implied by "wie
   viele" when the live data is a percentage.
6. Piper spoke that answer (596KB WAV); whisper.cpp transcribed it back
   as *"...hatten im Jahr 2001 und 28,48 % der Schulabgänger..."* — a
   real, minor `base`-model digit-recognition artifact (compare
   `WHISPER_MODEL_NAME=small`), but the grounded figure `8.48` is legible
   in the transcript and the real live value is `8.48` — **the spoken
   answer is demonstrably grounded in real ArcGIS data, confirmed through
   actual audio, not just through the text the workflow produced.**

### Real run #2 — no direct catalog match degrades honestly, not fabricated

```bash
PYTHONPATH=src python3 scripts/run_callcenter_pipeline.py \
  --text "Wie viele Arbeitslose gibt es in Dresden?"
```

The Deutschlandatlas has an unemployment **rate** table (`alq_HA2023`,
"Arbeitslosenquote") but no absolute unemployed-count table. The real
catalog-match call declined the match rather than force one:
`no_match_reason: "No table in the list provides unemployment counts or
rates for specific cities."` (the reason text is slightly wrong — a rate
table does exist — but the *behavior* is correct: it did not invent a
headcount). The deterministic `No Catalog Match Response` node then
produced a fixed, non-LLM refusal sentence — spoken and transcribed back
successfully. **No fact was fabricated on either path tested.**

### A real, load-bearing reliability gap found by this testing

Testing whether a **real, live-verified, currently-existing** crime-rate
indicator (`straft_HA2022` — "Straftaten insgesamt pro 100.000
Einwohner/-innen im Jahr 2021", real, queryable, `GEN` field present)
would be found by the catalog-match step surfaced a genuine problem,
not a demo-script bug:

- With the **full 152-row real candidate list**, the real litellm-proxy
  call for *"Wie hoch ist die Straftatenquote in Kiel?"* / *"Wie viele
  Straftaten gibt es pro 100.000 Einwohner in Kiel?"* declined the match,
  asserting the dataset "does not cover crime statistics" — **false**;
  `straft_HA2022` was in the exact list it was given.
- Isolated to **just the two `straft_*` candidates** (no noise from the
  other 150 rows), the same call **succeeded** on one occasion (`matched:
  true, table: "straft_HA2021"`) but then **failed 5/5 times** on
  identical repeat requests (same query, same 2-candidate list, same
  `temperature: 0`) later in the same session — a real, observed
  non-determinism in the shared local model/serving stack, not a
  scenario-selection artifact. `local-devstral-small2` behind this
  litellm-proxy is **not reliably deterministic at `temperature: 0`**,
  a known class of issue with batched inference serving (floating-point
  summation order depends on what else is in the batch) — worth knowing
  before trusting `temperature: 0` as a reproducibility guarantee
  anywhere else in this portfolio.
- The **rest of the pipeline is proven solid** for this same real crime
  data: `scripts/n8n_workflow_runtime.mjs --force-table straft_HA2022
  --force-place Kiel` (a diagnostic flag, logged loudly, that skips only
  the flaky catalog-match LLM call — every other step, including the
  *second* LLM phrasing call, is real) produced *"Die Straftatenquote in
  Kiel beträgt 8340,19 pro 100.000 Einwohnerinnen und Einwohner im Jahr
  2021"* from a real live query returning `{"GEN": "Kiel", "straft":
  8340.19, ...}` — independently re-confirmed with `curl`, still
  `8340.19`. Spoken with Piper and transcribed back as *"...beträgt
  8.341,9 pro 100.000..."* — a minor digit-order STT artifact, same real
  figure.
- **Net assessment:** the live-query, grounding-validation, and phrasing
  machinery genuinely works for crime data (and presumably other
  currently-unmatched topics). The catalog-*matching* step's reliability
  at full dataset scale, and its non-determinism at `temperature: 0`, are
  the real open problem — not a fabrication risk (every failure mode
  observed was an honest refusal, never an invented number), but a
  **match-rate** problem that would need addressing (a smaller
  topic-filtered candidate shortlist before the final match call, a
  larger/different model, or accepting and communicating a
  best-effort match rate) before this could be called reliable for
  arbitrary caller questions.

### A real bug found by this testing: no-match reasons aren't guaranteed German

`No Catalog Match Response`'s spoken text embeds the LLM's own
`no_match_reason` string verbatim. The system prompt for the
catalog-match call never says what language to use for `no_match_reason`
(unlike the phrasing prompt, which explicitly says "same language as the
caller question") — in practice the model sometimes writes that field in
**English** even for a German caller question (observed live: *"The
caller's question is about 'Straffahrtenkutte' (likely a typo for
'Straftatenquote'...), which is not covered..."*). Piped into German TTS,
this produces genuinely garbled audio (Piper reading English words with
German phonemes), which whisper.cpp then mis-transcribes badly on
round-trip — a real, reproducible, low-effort-to-fix bug (add "respond in
the caller's language" to `no_match_reason`'s instruction in `Build
Catalog Match Prompt`), not yet fixed as of this integration pass.

### A real, honest caller-side STT limitation, observed live

Speaking *"Wie hoch ist die Straftatenquote in Kiel?"* with Piper and
transcribing it back with whisper.cpp's `base` model produced *"Wie hoch
ist die Straffahrtenkutte in Kiel?"* — a real mishearing of an unusual
German compound noun, consistent with the STT module's own documented
`base`-vs-`small` accuracy trade-off (see [Speech I/O](#speech-io-stttts)
above). This, not a workflow bug, is why the synthesize-caller run of
"Straftatenquote" above failed at the STT step rather than testing the
catalog-match step at all — worth knowing when reproducing these results.

### Not yet done (integration) {#not-yet-done-integration}

- **No actual n8n instance was started.** Every real-live claim above is
  about the workflow's extracted logic and its real HTTP dependencies,
  driven by `scripts/n8n_workflow_runtime.mjs` — not about n8n's own
  expression parser, HTTP-node internals, or `if`-node schema on a live
  n8n version. Importing `n8n/callcenter-workflow.json` into a running
  n8n instance and triggering it via its real webhook is the next step
  before calling the *workflow itself* (as opposed to its logic) proven.
- **No SIP/telephony or microphone capture.** `--audio` accepts a real
  file; nothing in this repo produces one from a live call yet.
- **The catalog-match reliability gap above is unresolved**, not just
  undocumented — it would need real design work (shortlisting, a
  different model, or an accepted/communicated best-effort rate) before
  arbitrary caller questions against the full 152-table catalog could be
  trusted end-to-end.

## Source

Catalog derived from
[`github.com/bundesAPI/deutschlandatlas-api`](https://github.com/bundesAPI/deutschlandatlas-api)'s
`Readme.md`, live as of the last `build_catalog.py` run recorded in
`catalog.json`'s `source` field. Data itself is served by
`karto365.de` (the underlying Esri ArcGIS hosting used by the
Deutschlandatlas / BMWSB).
