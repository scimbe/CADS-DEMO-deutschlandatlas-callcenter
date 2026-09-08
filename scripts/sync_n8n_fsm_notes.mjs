#!/usr/bin/env node
// Keeps the n8n workflow's "SM:" sticky notes an honest mirror of gui/dialog-fsm.mjs (the single
// source of truth). Run after changing the FSM:  node scripts/sync_n8n_fsm_notes.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FSM, PART, PART_CLASS, OPENER_KIND, BRIDGE_KIND, INVARIANTS } from '../gui/dialog-fsm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'n8n', 'callcenter-workflow.json');
const wf = JSON.parse(fs.readFileSync(file, 'utf8'));

const stateNote = ['## Dialog State Machine  (single source of truth: gui/dialog-fsm.mjs)', '',
  'ONE finite-state machine; every state declares pre / enter / leave (leave ALWAYS runs).', '']
  .concat(Object.entries(FSM.states).flatMap(([name, s]) => [`**${name}**${name === FSM.initial ? '  (initial)' : ''}`, `- pre: ${s.pre}`, `- enter: ${s.enter}`, `- leave: ${s.leave}`,
    '- ' + Object.entries(s.on).map(([ev, to]) => `${ev} -> ${to}`).join('   |   '), ''])).join('\n');

const partsNote = ['## Spoken parts (ONE ordered player; a playing clip is never interrupted)', '']
  .concat(Object.values(PART).map((p) => `- ${p.padEnd(10)} ${PART_CLASS[p].toUpperCase()}`))
  .concat(['', 'soft = bridging only, dropped when the Atlas answer is ready before it started; hard = always spoken to the end.', '',
    'OPENER kinds: ' + Object.values(OPENER_KIND).join(' | '),
    'BRIDGE kinds (while waiting, lookahead 1): ' + Object.values(BRIDGE_KIND).join(' -> ') + ' (gap repeats)',
    '"Wussten Sie schon" (fact) = N1, produced AFTER an answer for the NEXT round, or F1 pool — never fetched live during a wait.']).join('\n');

const invNote = ['## Invariants (asserted by gui/dialog-fsm.mjs + tests/gui)', ''].concat(INVARIANTS.map((i) => '- ' + i)).join('\n');

const notes = { 'SM: Dialog State Machine': stateNote, 'SM: DELIVER parts': partsNote, 'SM: Invariants': invNote };
let n = 0;
for (const node of wf.nodes) {
  if (node.type === 'n8n-nodes-base.stickyNote' && notes[node.name]) { node.parameters.content = notes[node.name]; n++; }
}
fs.writeFileSync(file, JSON.stringify(wf, null, 2) + '\n');
console.log(`synced ${n} sticky note(s) in ${path.relative(root, file)}`);
