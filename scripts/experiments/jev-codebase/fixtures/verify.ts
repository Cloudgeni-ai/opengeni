import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { submit } from './repo/api';
import { JobQueue } from './repo/queue';
import { runOne } from './repo/worker';
import { replay } from './repo/replay';
import { postJob } from './repo/transport';
import { readConfig } from './repo/config';
import { MemoryStore } from './repo/memory-store';
import type { Fetcher } from './repo/types';

const root = import.meta.dir;
const cases = JSON.parse(readFileSync(join(root, 'cases.json'), 'utf8'));
assert.equal(cases.length, 8);
assert.equal(new Set(cases.map((c: any) => c.id)).size, 8);
for (const c of cases) {
  assert.ok(['development', 'holdout'].includes(c.split));
  assert.ok(['yes', 'no', 'indecisive'].includes(c.expectedAnswer));
  for (const key of ['id', 'question', 'category', 'oracleRationale']) assert.ok(typeof c[key] === 'string' && c[key].length);
  assert.ok(Array.isArray(c.requiredPaths) && c.requiredPaths.length);
  if (c.context !== undefined) assert.equal(typeof c.context, 'string');
  if (c.searchHints !== undefined) assert.ok(Array.isArray(c.searchHints) && c.searchHints.every((s: unknown) => typeof s === 'string'));
  for (const path of c.requiredPaths) {
    assert.ok(!path.includes('..') && !path.startsWith('/'));
    assert.ok(existsSync(join(root, 'repo', path)));
  }
}
for (const split of ['development', 'holdout']) assert.equal(cases.filter((c: any) => c.split === split).length, 4);
const files = readdirSync(join(root, 'repo'));
assert.equal(files.length, 12);
for (const file of files) assert.ok(!/expectedAnswer|oracleRationale|holdout|development/.test(readFileSync(join(root, 'repo', file), 'utf8')));

const job = { id: 'job-1', payload: 'invoice' };
const controller = new AbortController();
const seen: (AbortSignal | undefined)[] = [];
const fetcher: Fetcher = async (_url, init) => { seen.push(init.signal); return { status: 404 }; };
const store = new MemoryStore();
const queue = new JobQueue();
let auditWrites = 0;
const audit = { async write() { auditWrites++; } };
const deps = { env: {}, queue, store, fetcher, audit };
assert.equal(await submit(job, controller.signal, deps), 404);
assert.equal(seen[0], controller.signal);
assert.equal(store.statuses.get(job.id), 404);
assert.equal(auditWrites, 0);

assert.equal(await submit(job, controller.signal, { ...deps, env: { DELIVERY_MODE: 'queued' } }), 202);
controller.abort();
assert.equal(await runOne(queue, 'https://local.invalid', fetcher, store), 404);
assert.equal(seen[1], undefined);
const calls = seen.length;
let saves = 0;
await assert.rejects(submit(job, controller.signal, { ...deps, store: { async save() { saves++; } } }));
assert.equal(seen.length, calls);
assert.equal(saves, 0);

let attempts = 0;
await assert.rejects(postJob(async () => { attempts++; return { status: 503 }; }, 'unused', job));
assert.equal(attempts, 1);
store.statuses.clear();
assert.equal(await replay(job, 'unused', fetcher), 404);
assert.equal(store.statuses.size, 0);
assert.equal(seen.at(-1), undefined);
assert.equal(readConfig({}).audit, false);
assert.equal(readConfig({ AUDIT_ENABLED: 'true' }).audit, true);
await submit(job, new AbortController().signal, { ...deps, env: { AUDIT_ENABLED: 'true' } });
assert.equal(auditWrites, 1);
console.log('PASS: eight cases, four per split, 12 source modules, oracle separation, and deterministic behavior checks; no network or inference.');
