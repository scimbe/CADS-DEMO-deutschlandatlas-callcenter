// Which backend serves each AI-dependent service. "local" = the existing setup (litellm-proxy +
// the llm2 ct-agent channel/Piper/whisper.cpp) — DSGVO-conform, entirely EU-hosted. "cloudflare" =
// Cloudflare Workers AI (https://developers.cloudflare.com/workers-ai/), a US-headquartered global
// network — data leaves the EU/Germany guarantee the "local" setup was built on. Nothing else in
// the app needs to know WHICH provider is active; every call site keeps using the same function
// (understand()/narrate()/ttsSpeak()/transcribe()) regardless — only these three lines decide.
//
// AI_PROVIDER sets the default for all three services; LLM_PROVIDER / TTS_PROVIDER / STT_PROVIDER
// override it per service (operator: "nur die Dienste umgeschaltet werden" — e.g. keep STT local
// while switching LLM+TTS to Cloudflare). Values: "local" (default) | "cloudflare".
const DEFAULT_PROVIDER = (process.env.AI_PROVIDER || 'local').toLowerCase();
export const LLM_PROVIDER = (process.env.LLM_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
export const TTS_PROVIDER = (process.env.TTS_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
export const STT_PROVIDER = (process.env.STT_PROVIDER || DEFAULT_PROVIDER).toLowerCase();

/** True the instant ANY service is on a non-EU-guaranteed provider — drives the GDPR notice
 *  (GUI banner + the spoken service intro, see bridging.mjs) and is exposed at GET /health. */
export const usesNonEuProvider = [LLM_PROVIDER, TTS_PROVIDER, STT_PROVIDER].some((p) => p === 'cloudflare');

export function providerSummary() {
  return { llm: LLM_PROVIDER, tts: TTS_PROVIDER, stt: STT_PROVIDER, gdprNotice: usesNonEuProvider };
}
