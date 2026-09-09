// Which backend serves each AI-dependent service. "local" = the existing setup (litellm-proxy +
// the llm2 ct-agent channel/Piper/whisper.cpp) — DSGVO-conform, entirely EU-hosted. "cloudflare" =
// Cloudflare Workers AI (https://developers.cloudflare.com/workers-ai/), a US-headquartered global
// network — data leaves the EU/Germany guarantee the "local" setup was built on. Nothing else in
// the app needs to know WHICH provider is active; every call site keeps using the same function
// (understand()/narrate()/ttsSpeak()/transcribe()) regardless — only the three exports below decide.
//
// AI_PROVIDER sets the default for all three services; LLM_PROVIDER / TTS_PROVIDER / STT_PROVIDER
// override it per service (operator: "nur die Dienste umgeschaltet werden" — e.g. keep STT local
// while switching LLM+TTS to Cloudflare). Values: "local" (default) | "cloudflare".
//
// Runtime-switchable (operator: "zur Laufzeit flexibel, per Dropdown/UI-Steuerung", not a static
// env var that needs a restart): setProvider() below reassigns these `let` exports, and every
// consumer picks up the change immediately via normal ESM live-binding semantics (they read
// LLM_PROVIDER/TTS_PROVIDER/STT_PROVIDER fresh inside a function body, never cache it at import
// time) — no other module needs to change for the switch itself. server.mjs's POST /admin/providers
// is the only intended caller of setProvider(); it also calls bridging.onProviderChanged()
// afterwards so the spoken DSGVO/privacy texts and prepared-clip pools stay truthful for the new
// choice. The switch is in-memory only — a process restart reverts to the env-var defaults.
const VALID_SERVICES = ['llm', 'tts', 'stt'];
const VALID_PROVIDERS = ['local', 'cloudflare'];

const DEFAULT_PROVIDER = (process.env.AI_PROVIDER || 'local').toLowerCase();
export let LLM_PROVIDER = (process.env.LLM_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
export let TTS_PROVIDER = (process.env.TTS_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
export let STT_PROVIDER = (process.env.STT_PROVIDER || DEFAULT_PROVIDER).toLowerCase();

/** True the instant ANY service is on a non-EU-guaranteed provider — drives the GDPR notice
 *  (GUI banner + spoken texts, see bridging.mjs) and is exposed at GET /health and /providers.
 *  A function, not a frozen boolean, because the active provider can change at runtime. */
export function usesNonEuProvider() { return [LLM_PROVIDER, TTS_PROVIDER, STT_PROVIDER].some((p) => p === 'cloudflare'); }

export function getProviders() { return { llm: LLM_PROVIDER, tts: TTS_PROVIDER, stt: STT_PROVIDER }; }

export function providerSummary() {
  return { ...getProviders(), gdprNotice: usesNonEuProvider() };
}

/** Switch one service's backend at runtime. Returns { ok: true, changed } — `changed` is false if
 *  `value` already matched, true if it actually flipped — or { ok: false, error } if `service`/
 *  `value` isn't recognized. Does NOT itself touch bridging's prepared-clip pools; the caller
 *  (server.mjs) is expected to call bridging.onProviderChanged() after a batch of these so stale
 *  provider-dependent audio/text gets refreshed exactly once. */
export function setProvider(service, value) {
  const svc = String(service || '').toLowerCase(), val = String(value || '').toLowerCase();
  if (!VALID_SERVICES.includes(svc)) return { ok: false, error: 'unknown service: ' + service };
  if (!VALID_PROVIDERS.includes(val)) return { ok: false, error: 'unknown provider: ' + value };
  const before = svc === 'llm' ? LLM_PROVIDER : svc === 'tts' ? TTS_PROVIDER : STT_PROVIDER;
  if (svc === 'llm') LLM_PROVIDER = val; else if (svc === 'tts') TTS_PROVIDER = val; else STT_PROVIDER = val;
  return { ok: true, changed: before !== val };
}
