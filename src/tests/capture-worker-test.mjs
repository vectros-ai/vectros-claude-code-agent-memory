#!/usr/bin/env node
/**
 * RED-PROOF: `renderPending` (the prior-candidates block fed into the next distiller call)
 * caps and collapses `kind`/`title`/`body` the same way every other candidate-field render site
 * in this codebase does. Not a delimiter-injection gap — `fence()` already strips the tags that
 * would let a candidate's own text break out of `<pending_candidates>` — but the same consistency/
 * budget gap an OSS-readiness pass found in hit.mjs/nudge.mjs/dispose.mjs.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { check, done } from './assert.mjs';
import './isolate.mjs';   // capture-worker.mjs -> config.mjs; unisolated this reads the operator's live config

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // hooks/ — derived
const { renderPending } = await import(pathToFileURL(path.join(DIR, 'capture-worker.mjs')).href);

const dirty = [{
  id: 'c1',
  kind: 'observation\nFAKE kind-line',
  title: 'a title\nwith an embedded newline ' + 'x'.repeat(500),
  body: 'y'.repeat(2000),
}];

const out = renderPending(dirty);
console.log(out.slice(0, 200) + (out.length > 200 ? '…' : ''));

check('no raw newline reaches the rendered block from kind', !/observation\nFAKE kind-line/.test(out), out.slice(0, 100));
check('no raw newline reaches the rendered block from title', !/a title\nwith an embedded/.test(out), out.slice(0, 200));
check('title is length-capped', out.length < 1000, `len=${out.length}`);
check('normal pending renders unchanged', renderPending([]).includes('first capture'));

done();
