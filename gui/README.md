# Callcenter Service GUI

Interactive end-user GUI for the Deutschlandatlas call-center: ask a question (type or speak),
the full pipeline runs (`scripts/n8n_workflow_runtime.mjs` → catalog match → live Deutschlandatlas
query → grounded German answer), the answer is shown and spoken back.

## Run
```
export LITELLM_BASE_URL=... LITELLM_API_KEY=... LITELLM_DEFAULT_MODEL=local-devstral-small2
# optional spoken answer via the CADS-Tunnel audio_generation channel:
export CC_TTS=1 CT_AGENT_BIN=/path/to/ct-agent CT_RELAY_ENV=/path/to/channel.env \
       CT_AUDIO_CHANNEL_ID=<audio channel id>
node gui/server.mjs   # http://127.0.0.1:8791
```
Dependency-free Node. No secrets are committed — everything is env-driven. Browser mic uses the
Web Speech API (de-DE) for spoken questions; the orb reacts to the spoken answer's audio.
