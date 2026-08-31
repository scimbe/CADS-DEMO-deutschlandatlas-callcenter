#!/usr/bin/env node
// A minimal, faithful runtime for n8n/callcenter-workflow.json outside of an
// actual n8n instance.
//
// This is NOT a reimplementation of the workflow's logic -- every `code`
// node's `jsCode` is extracted VERBATIM from the committed workflow JSON and
// executed as-is (same technique as the harness used to verify the workflow
// while it was being built). What's new here versus that harness: this
// script follows the workflow's real `if`-node branch conditions to decide
// which path to take (rather than a scenario script picking the path by
// hand), and it calls the REAL litellm-proxy for both LLM steps instead of
// replaying a captured fixture -- so a single run of this script is a real,
// live, end-to-end execution of the exact logic n8n would run, missing only
// the n8n process itself.
//
// Usage:
//   LITELLM_BASE_URL=... LITELLM_API_KEY=... LITELLM_DEFAULT_MODEL=... \
//     node scripts/n8n_workflow_runtime.mjs --query "Wie hoch ist die Straftatenquote in Kiel?" [--catalog catalog.json] [--trace]
//
// Prints the final { text, meta } JSON to stdout (last line) and a
// step-by-step trace to stderr (or stdout with --trace).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { query: null, catalog: path.join(REPO_ROOT, "catalog.json"), trace: false, workflow: path.join(REPO_ROOT, "n8n", "callcenter-workflow.json"), forceTable: null, forcePlace: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--query") out.query = argv[++i];
    else if (a === "--catalog") out.catalog = argv[++i];
    else if (a === "--workflow") out.workflow = argv[++i];
    else if (a === "--trace") out.trace = true;
    // Diagnostic only: skip the real "LLM Match Catalog" call and inject a
    // fixed table match, to test the REST of the (still fully real/live)
    // pipeline -- layer discovery, live query, phrasing, grounding -- in
    // isolation from the catalog-matching LLM step's own reliability. Never
    // used for a normal run; every use is logged loudly to stderr.
    else if (a === "--force-table") out.forceTable = argv[++i];
    else if (a === "--force-place") out.forcePlace = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.query) {
  console.error("usage: n8n_workflow_runtime.mjs --query \"<caller question>\" [--catalog path] [--trace]");
  process.exit(2);
}

function trace(...parts) {
  console.error("[trace]", ...parts);
}

const wf = JSON.parse(fs.readFileSync(args.workflow, "utf8"));
const nodesByName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));

function newExecution() {
  const outputs = {};
  function runCode(nodeName, inputItemJson) {
    const node = nodesByName[nodeName];
    if (!node || node.type !== "n8n-nodes-base.code") {
      throw new Error(`not a code node: ${nodeName}`);
    }
    const code = node.parameters.jsCode;
    const $input = { first: () => ({ json: inputItemJson }) };
    const $ = (name) => {
      if (!(name in outputs)) throw new Error(`node "${name}" has no output in this run`);
      return { item: { json: outputs[name] }, first: () => ({ json: outputs[name] }) };
    };
    const $env = process.env;
    const fn = new Function("$input", "$", "$env", `${code}\n`);
    const result = fn($input, $, $env);
    const outJson = result[0].json;
    outputs[nodeName] = outJson;
    trace(`code  ${nodeName} ->`, JSON.stringify(outJson).slice(0, 300));
    return outJson;
  }
  function setOutput(name, json) {
    outputs[name] = json;
    trace(`set   ${name} <- (${JSON.stringify(json).length} bytes)`);
  }
  return { outputs, runCode, setOutput };
}

async function esriGet(url, params) {
  const qs = new URLSearchParams(params).toString();
  const full = `${url}?${qs}`;
  trace("GET", full);
  // The karto365 ArcGIS API resets connections under load (ECONNRESET / UND_ERR_SOCKET, bytesRead 0).
  // A single reset otherwise fails the whole answer -> retry transient network/5xx errors a few times
  // with a short backoff before giving up (GET is idempotent, safe to repeat).
  const RETRIES = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const resp = await fetch(full, { headers: { "User-Agent": "callcenter-pipeline/1.0" } });
      if (!resp.ok) {
        if (resp.status >= 500 && attempt < RETRIES) { trace("ArcGIS HTTP", resp.status, `retry ${attempt}/${RETRIES}`); await sleep(400 * attempt); continue; }
        return resp.json();
      }
      return await resp.json();
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.cause && e.cause.code) || (e && e.message) || e);
      if (/ECONNRESET|UND_ERR_SOCKET|ETIMEDOUT|ECONNREFUSED|EPIPE|fetch failed|socket|network/i.test(msg) && attempt < RETRIES) {
        trace("ArcGIS connection error (retrying)", msg, `attempt ${attempt}/${RETRIES}`); await sleep(400 * attempt); continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("esriGet failed after retries");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function llmChat({ system, user, temperature, max_tokens, json_object }) {
  const base = process.env.LITELLM_BASE_URL;
  const key = process.env.LITELLM_API_KEY;
  const model = process.env.LITELLM_DEFAULT_MODEL || "local-devstral-small2";
  if (!base || !key) {
    throw new Error("LITELLM_BASE_URL / LITELLM_API_KEY must be set to run the workflow's real LLM steps");
  }
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model,
    temperature,
    max_tokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (json_object) body.response_format = { type: "json_object" };
  trace("POST", url, `model=${model} temp=${temperature}`);
  // The litellm proxy occasionally resets the TLS connection mid-request (ECONNRESET) or
  // returns a transient 5xx. A single reset otherwise fails the whole answer, so retry a few
  // times with a short backoff before giving up (idempotent request; safe to repeat).
  const RETRIES = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text();
        if (resp.status >= 500 && attempt < RETRIES) {
          trace("LLM HTTP error (retrying)", resp.status, `attempt ${attempt}/${RETRIES}`);
          await sleep(300 * attempt);
          continue;
        }
        trace("LLM HTTP error", resp.status, text.slice(0, 500));
        try { return JSON.parse(text); } catch { throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 200)}`); }
      }
      return await resp.json();
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.cause && e.cause.code) || (e && e.message) || e);
      const transient = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|fetch failed|socket hang up|network/i.test(msg);
      if (transient && attempt < RETRIES) {
        trace("LLM connection error (retrying)", msg, `attempt ${attempt}/${RETRIES}`);
        await sleep(300 * attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("LLM call failed after retries");
}

async function main() {
  const { outputs, runCode, setOutput } = newExecution();

  // 1. Caller Query In
  setOutput("Caller Query In", { body: { query: args.query } });

  // 2. Fetch Catalog (GitHub) -- use the local, just-committed catalog.json
  // rather than the raw GitHub URL, since local changes are not necessarily
  // pushed yet. This is the one deliberate deviation from the node's live
  // URL (documented, not hidden) -- everything else hits the real network.
  const catalog = JSON.parse(fs.readFileSync(args.catalog, "utf8"));
  setOutput("Fetch Catalog (GitHub)", catalog);

  // 3. Build Catalog Match Prompt
  const promptOut = runCode("Build Catalog Match Prompt", catalog);

  let matchOut;
  if (args.forceTable) {
    trace(`!!! DIAGNOSTIC MODE: bypassing the real catalog-match LLM call, forcing table="${args.forceTable}" place="${args.forcePlace}" !!!`);
    const forced = {
      choices: [{ message: { content: JSON.stringify({
        matched: true, table: args.forceTable, reformulated: false,
        reformulation_note: null, place_name: args.forcePlace || null, no_match_reason: null,
      }) } }],
    };
    setOutput("LLM Match Catalog", forced);
    // 5. Validate Catalog Match -- still the REAL deterministic validator:
    // it will fail closed exactly as it would for a real model, if
    // --force-table names something not verbatim in catalog.json.
    matchOut = runCode("Validate Catalog Match", forced);
  } else {
    // 4. LLM Match Catalog -- REAL call to the litellm-proxy
    const _tCM = Date.now();
    const matchResp = await llmChat({
      system: promptOut.llmSystem,
      user: promptOut.llmUser,
      temperature: 0,
      max_tokens: 700,
      json_object: true,
    });
    setOutput("LLM Match Catalog", matchResp);
    trace("TIMING catalog-match-LLM", (Date.now() - _tCM) + "ms");

    // 5. Validate Catalog Match
    matchOut = runCode("Validate Catalog Match", matchResp);
  }

  // Catalog Match Found?
  if (!matchOut.matched) {
    const noMatch = runCode("No Catalog Match Response", matchOut);
    return noMatch; // -> Respond No Match
  }

  // 6. Get Indicator MapServer Metadata
  const _tArc = Date.now();
  const meta = await esriGet(matchOut.catalogRow.url, { f: "json" });
  setOutput("Get Indicator MapServer Metadata", meta);

  // 7. Pick Indicator Layer
  const layerOut = runCode("Pick Indicator Layer", meta);

  let phrasingInput;
  // Indicator Service Queryable?
  if (!layerOut.queryable) {
    phrasingInput = runCode("Mark Service Not Queryable", layerOut);
  } else {
    // 8. Discover Indicator Fields
    const schemaResp = await esriGet(`${matchOut.catalogRow.url}/${layerOut.layerId}/query`, {
      f: "json", where: "1=1", outFields: "*", returnGeometry: "false",
    });
    setOutput("Discover Indicator Fields", schemaResp);
    const fieldsOut = runCode("Handle Field Discovery Result", schemaResp);
    const schema = runCode("Finalize Schema", fieldsOut);

    // Schema Discovery OK?
    if (schema.dataError) {
      phrasingInput = schema; // -> Build Phrasing Prompt (false branch)
    } else {
      let whereCtx;
      // Has Direct Name Field And Place Given?
      if (schema.hasDirectNameField && !!schema.place_name) {
        whereCtx = runCode("Build Where Clause Direct Filter", schema);
      } else if (!!schema.place_name && !schema.hasDirectNameField) {
        // Place Given But No Direct Field? -> boundary enrichment
        const boundaryMeta = await esriGet(
          "https://www.karto365.de/hosting/rest/services/VG250_Verbandsgemeinden1219_Punkt/MapServer",
          { f: "json" },
        );
        setOutput("Boundary Layer Metadata", boundaryMeta);
        const boundaryLayer = runCode("Pick Boundary Layer", boundaryMeta);
        const boundaryResp = await esriGet(`${boundaryLayer.boundaryUrl}/${boundaryLayer.boundaryLayerId}/query`, {
          f: "json", where: boundaryLayer.boundaryWhereClause, outFields: "*", returnGeometry: "false",
        });
        setOutput("Query Boundary For Place", boundaryResp);
        whereCtx = runCode("Check Boundary Match", boundaryResp);
      } else {
        whereCtx = runCode("Build Where Clause No Filter", schema);
      }

      // Query Indicator Data Final
      const finalResp = await esriGet(`${whereCtx.catalogRow.url}/${whereCtx.layerId}/query`, {
        f: "json", where: whereCtx.whereClauseUsed, outFields: "*", returnGeometry: "false",
      });
      setOutput("Query Indicator Data Final", finalResp);
      phrasingInput = runCode("Validate Final Data", finalResp);
    }
  }

  trace("TIMING arcgis-total", (Date.now() - _tArc) + "ms");
  // Build Phrasing Prompt
  const phrasePrompt = runCode("Build Phrasing Prompt", phrasingInput);

  // LLM Phrase Answer -- REAL call to the litellm-proxy
  const _tPh = Date.now();
  const phraseResp = await llmChat({
    system: phrasePrompt.llmPhraseSystem,
    user: phrasePrompt.llmPhraseUser,
    temperature: 0.2,
    max_tokens: 300,
    json_object: false,
  });
  setOutput("LLM Phrase Answer", phraseResp);
  trace("TIMING phrasing-LLM", (Date.now() - _tPh) + "ms");

  // Extract Final Answer
  const final = runCode("Extract Final Answer", phraseResp);
  return final; // -> Respond With Answer
}

main()
  .then((final) => {
    console.log(JSON.stringify(final));
  })
  .catch((e) => {
    console.error("RUNTIME ERROR:", e);
    process.exit(1);
  });
