// node tests/regression/run.mjs  — runs the REAL pipeline (needs LITELLM_* env + network) over the
// regression questions and reports how many return real numbers. Not part of `node --test`.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const qs = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'questions.json'), 'utf8'));
const base = process.env.CC_BASE;                       // optional: run against a live server instead (POST /answer)
let good = 0;
for (const item of qs) {
  const q = item.q;
  let text = '', real = false, ms = 0, table = ''; const t0 = Date.now();
  if (base) {
    const r = await (await fetch(base + '/answer', { method: 'POST', body: JSON.stringify({ query: q }) })).json();
    text = r.answer || ''; table = (r.meta && r.meta.table) || ''; real = !!(r.meta && r.meta.table && r.meta.has_real_data !== false); ms = Date.now() - t0;
  } else {
    const p = spawnSync('node', [join(root, 'scripts/n8n_workflow_runtime.mjs'), '--query', q], { cwd: root, env: process.env, encoding: 'utf8' });
    const last = p.stdout.trim().split('\n').filter(Boolean).pop(); let j = {}; try { j = JSON.parse(last); } catch {}
    text = j.text || j.answer || ''; table = (j.meta && j.meta.table) || ''; real = !!(j.meta && j.meta.table && j.meta.has_real_data !== false); ms = Date.now() - t0;
  }
  // topic check: the answered TABLE must match the question's topic (not just 'has real data')
  const topicOk = new RegExp(item.table, 'i').test(table);
  const hasNum = /\d/.test(text) && real && topicOk; if (hasNum) good++;
  console.log((hasNum ? 'OK  ' : 'MISS') + ' ' + ms + 'ms [' + table + ']  ' + q + '\n       -> ' + text.slice(0, 160));
}
console.log(`\n${good}/${qs.length} = ${Math.round(100 * good / qs.length)} %`);
