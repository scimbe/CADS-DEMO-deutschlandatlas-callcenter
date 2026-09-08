#!/usr/bin/env node
// A fake `ct-agent channel` in persistent call mode for the ChannelClient tests: one stdin line =
// one call, one NDJSON envelope per call. Behaviour is scripted through env:
//   FAKE_DELAY_MS   per-call latency (default 20)
//   FAKE_FAIL_ON    a substring; a line containing it gets {"ok":false,...} and the process exits 1
//   FAKE_HANG_ON    a substring; a line containing it is never answered
//   FAKE_DIE_AT_START=1  exit immediately without answering anything
//   FAKE_NOISE=1    print a non-envelope diagnostic line before each answer
import { createInterface } from 'node:readline';
if (process.env.FAKE_DIE_AT_START === '1') process.exit(3);
const delay = Number(process.env.FAKE_DELAY_MS || 20);
const rl = createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let n = 0;
rl.on('line', (line) => {
  const t = line.trim(); if (!t) return;
  n++;
  if (process.env.FAKE_HANG_ON && t.includes(process.env.FAKE_HANG_ON)) return;
  setTimeout(() => {
    if (process.env.FAKE_NOISE === '1') process.stdout.write('diag: call ' + n + '\n');
    if (process.env.FAKE_FAIL_ON && t.includes(process.env.FAKE_FAIL_ON)) { out({ ok: false, error: 'scripted failure' }); process.exit(1); }
    let payload; try { payload = JSON.parse(t); } catch { payload = { raw: t }; }
    if (process.env.FAKE_URL === '1') return out({ ok: true, output: 'https://fake.llm2/clip-' + n + '.wav' });
    out({ ok: true, output: 'echo#' + n + ':' + (payload.text || payload.audio_url || payload.raw || '') + ' pid=' + process.pid });
  }, delay);
});
rl.on('close', () => process.exit(0));
