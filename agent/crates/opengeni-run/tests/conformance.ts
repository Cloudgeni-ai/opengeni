/** Finite Linux fixtures; no accounts, network or deployment data. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'journal-conformance-'));
const journal = join(root, 'journal');
const runBinary = process.env.CONFORMANCE_RUN_BINARY ?? '/usr/local/bin/opengeni-run';
const supervisorBinary = process.env.CONFORMANCE_SUPERVISOR_BINARY ?? '/usr/local/bin/opengeni-command-supervisor';
const fixtureBinary = process.env.CONFORMANCE_FIXTURE_BINARY ?? '/usr/local/bin/command-supervisor-fixture';
const faultsLibrary = process.env.CONFORMANCE_FAULTS_LIBRARY ?? '/usr/local/lib/opengeni-journal-faults.so';
const run = [runBinary, '--root', journal, '--supervisor', supervisorBinary];

interface StartRequest {
  operationId: string;
  diskLineage: string;
  bootId: string;
  program: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  stdin?: boolean;
  pty?: { columns: number; rows: number };
}
interface Page { data: string; nextOffset: number; eof: boolean }
interface Observation {
  state: string;
  stdout: Page;
  stderr: Page;
  receipt: { leaderExitCode: number; receiptId: string; acceptedInputSequence?: number;
    incompleteInputSequence?: number } | null;
}
interface InputReply { status: string; acceptedThrough: number | null }
type InputAction = { kind: 'data'; base64: string } | { kind: 'close' } |
  { kind: 'resize'; columns: number; rows: number };

type CliOptions = { supervisor?: string; env?: Record<string, string> };
async function raw(action: string[], payload?: object, options?: CliOptions) {
  const command = options?.supervisor
    ? [runBinary, '--root', journal, '--supervisor', options.supervisor] : run;
  const child = Bun.spawn([...command, ...action], {
    stdin: payload ? Buffer.from(JSON.stringify(payload)) : 'ignore',
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, ...options?.env },
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    assert(!timedOut, `CLI timeout: ${action[0]}`);
    return { stdout, stderr, exitCode };
  } finally { clearTimeout(timer); }
}
async function invoke<T = Observation>(action: string[], payload?: object, options?: CliOptions): Promise<T> {
  const result = await raw(action, payload, options);
  assert.equal(result.exitCode, 0, `${action[0]}: ${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}
const capability = await invoke<{ bootId: string; stdin: boolean; pty: boolean }>(['capabilities']);
assert(capability.stdin && capability.pty, 'Native I/O must be exercised, not inferred from an SDK');
function request(command: string): StartRequest {
  return {
    operationId: crypto.randomUUID(), diskLineage: crypto.randomUUID(), bootId: capability.bootId,
    program: '/bin/sh', args: ['-c', command], cwd: root,
    environment: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root },
  };
}
function observe(spec: StartRequest, ...extra: string[]) {
  return invoke(['read', '--operation', spec.operationId, '--boot-id', spec.bootId,
    '--disk-lineage', spec.diskLineage, ...extra]);
}
function cancelArgs(spec: StartRequest) {
  return ['cancel', '--operation', spec.operationId, '--boot-id', spec.bootId,
    '--disk-lineage', spec.diskLineage];
}
async function exited(spec: StartRequest) {
  const deadline = performance.now() + 6_000;
  let result: Observation | undefined;
  while (performance.now() < deadline) {
    result = await observe(spec);
    if (result.state === 'exited') {
      assert(result.stdout.eof && result.stderr.eof);
      return result;
    }
    await Bun.sleep(15);
  }
  assert.fail(`Missing terminal proof: ${result?.state}`);
}
function content(name: string) { return readFileSync(join(root, name)); }
function contentOrEmpty(name: string) {
  return existsSync(join(root, name)) ? content(name) : Buffer.alloc(0);
}
function input(spec: StartRequest, sequence: number, action: InputAction) {
  return invoke<InputReply>(['input'], { operationId: spec.operationId, sequence, input: action });
}
function data(bytes: Buffer | string): InputAction {
  return { kind: 'data', base64: Buffer.from(bytes).toString('base64') };
}
async function accepted(spec: StartRequest, sequence: number, action: InputAction) {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    const result = await input(spec, sequence, action);
    if (result.status === 'accepted') return result;
    assert.equal(result.status, 'pending');
    await Bun.sleep(15);
  }
  assert.fail('Input remained backpressured');
}
function supervisorOwner(spec: StartRequest) {
  for (const directory of readdirSync('/proc')) {
    if (!/^\d+$/.test(directory)) continue;
    try {
      const argv = readFileSync(`/proc/${directory}/cmdline`).toString().split('\0');
      if (argv[0] === supervisorBinary && argv.includes('launch') && argv.includes(spec.operationId)) {
        return Number(directory);
      }
    } catch { /* Exact fixture exited while being inspected. */ }
  }
  assert.fail('Missing exact fixture supervisor');
}

// Concurrent retries after a lost acknowledgement perform the effect once.
const spec = request('printf x >> once; printf "output\\360\\237\\230\\200"; printf err >&2; sleep .2; exit 7');
await Promise.all(Array.from({ length: 16 }, () => invoke(['start'], spec)));
const terminal = await exited(spec);
assert.equal(content('once').toString(), 'x');

// Distinct operations can prepare shared private tmpfs directories concurrently.
const independent = Array.from({ length: 8 }, (_, i) => request(`printf x >> independent-${i}`));
await Promise.all(independent.map(command => invoke(['start'], command)));
await Promise.all(independent.map(exited));
for (let i = 0; i < independent.length; i++) assert.equal(content(`independent-${i}`).toString(), 'x');
assert.equal(terminal.receipt?.leaderExitCode, 7);
assert.deepEqual(Buffer.from(terminal.stdout.data, 'base64'), Buffer.from('output😀'));
const receiptId = terminal.receipt!.receiptId;
for (let i = 0; i < 3; i++) assert.equal((await invoke(['start'], spec)).receipt?.receiptId, receiptId);
assert.equal(content('once').toString(), 'x');

// Byte pages, including split UTF-8, replay without reinterpretation.
const pages: Buffer[] = [];
let offset = 0;
for (;;) {
  const page = (await observe(spec, '--stdout', String(offset), '--bytes', '3')).stdout;
  const replay = (await observe(spec, '--stdout', String(offset), '--bytes', '3')).stdout;
  assert.deepEqual(page, replay);
  pages.push(Buffer.from(page.data, 'base64'));
  offset = page.nextOffset;
  if (page.eof) break;
}
assert.deepEqual(Buffer.concat(pages), Buffer.from('output😀'));
assert.equal((await observe(spec)).receipt?.receiptId, receiptId);

// Reusing an ID cannot change argv or environment after completion.
assert.equal((await raw(['start'], { ...spec, args: ['-c', 'printf duplicate >> once'] })).exitCode, 125);
assert.equal((await raw(['start'], { ...spec, environment: { ...spec.environment, CHANGED: 'value' } })).exitCode, 125);
assert.equal(content('once').toString(), 'x');

// A crash in the directory/claim gap cannot authorize a successor launch.
const incomplete = request('printf forbidden > incomplete-side-effect');
mkdirSync(join(journal, incomplete.operationId));
for (let i = 0; i < 3; i++) assert.equal((await invoke(['start'], incomplete)).state, 'unknown');
assert(!existsSync(join(root, 'incomplete-side-effect')));

// Pre-cancel wins the same immutable launch gate.
const cancelFirst = request('printf forbidden > cancelled-side-effect');
const staleCancel = { ...cancelFirst, operationId: crypto.randomUUID(), bootId: '0'.repeat(64) };
assert.equal((await raw(cancelArgs(staleCancel))).exitCode, 125);
assert.equal((await observe(staleCancel)).state, 'not_found');
assert(!existsSync(join(journal, staleCancel.operationId)));
assert.equal((await invoke(cancelArgs(cancelFirst))).state, 'cancelled');
assert.equal((await raw(cancelArgs({ ...cancelFirst, diskLineage: crypto.randomUUID() }))).exitCode, 125);
assert.equal((await invoke(['start'], cancelFirst)).state, 'cancelled');
assert(!existsSync(join(root, 'cancelled-side-effect')));

// Protocol-looking user output supplies no quiescence authority.
const spoof = request("printf '{\"state\":\"quiescent\"}'; sleep 1; exit 9");
const initial = await invoke(['start'], spoof);
assert.equal(initial.state, 'running');
assert.equal(initial.receipt, null);
assert.equal((await exited(spoof)).receipt?.leaderExitCode, 9);

// Native double-fork + setsid fixture survives leader exit until drained.
const detached = request('unused');
detached.program = fixtureBinary;
detached.args = ['double-fork', join(root, 'detached-writes')];
await invoke(['start'], detached);
await Bun.sleep(200);
assert.equal((await observe(detached)).state, 'running');
await invoke(cancelArgs(detached));
assert.equal((await exited(detached)).receipt?.leaderExitCode, 17);
const detachedBefore = content('detached-writes');
await Bun.sleep(150);
assert.deepEqual(content('detached-writes'), detachedBefore);

// TERM-ignoring descendants must stop before terminal proof is published.
const busy = request("trap '' TERM; while :; do printf x >> cancelled-writes; sleep .02; done");
await invoke(['start'], busy);
await invoke(cancelArgs(busy));
const proof = await exited(busy);
assert([137, 143].includes(proof.receipt!.leaderExitCode));
const cancelledBefore = contentOrEmpty('cancelled-writes');
await Bun.sleep(150);
assert.deepEqual(contentOrEmpty('cancelled-writes'), cancelledBefore);

// Killing the exact fixture supervisor produces unknown, never a replay.
const crash = request('printf x >> crash-count; sleep 2');
await invoke(['start'], crash);
const effectDeadline = performance.now() + 1_000;
while (!existsSync(join(root, 'crash-count')) && performance.now() < effectDeadline) await Bun.sleep(5);
process.kill(supervisorOwner(crash), 'SIGKILL');
for (let i = 0; i < 3; i++) assert.equal((await invoke(['start'], crash)).state, 'unknown');
assert.equal(content('crash-count').toString(), 'x');
await Bun.sleep(2_100);
assert.equal((await observe(crash)).state, 'unknown');

// Credentials are neither journaled nor left in the consumed tmpfs payload.
const secret = request('printf done');
secret.environment.SYNTHETIC_SECRET = 'synthetic-private-value';
await invoke(['start'], secret);
await exited(secret);
const claimBytes = readFileSync(join(journal, secret.operationId, 'claim.json'));
assert(!claimBytes.includes('synthetic-private-value'));
assert(!claimBytes.includes('SYNTHETIC_SECRET'));
const claim = JSON.parse(claimBytes.toString()) as { nonce: string };
assert(!existsSync(join('/dev/shm/opengeni-run-launch', `${claim.nonce}.json`)));

// /dev/stdout is a stream: ordinary redirects cannot truncate replayed bytes.
const redirect = request('printf first; sleep .3; printf second > /dev/stdout; printf error > /dev/stderr');
await invoke(['start'], redirect);
const prefixDeadline = performance.now() + 1_000;
while (Buffer.from((await observe(redirect)).stdout.data, 'base64').length < 5 &&
  performance.now() < prefixDeadline) await Bun.sleep(5);
const prefix = await observe(redirect, '--bytes', '5');
assert.equal(Buffer.from(prefix.stdout.data, 'base64').toString(), 'first');
const redirectExit = await exited(redirect);
assert.equal(Buffer.from(redirectExit.stdout.data, 'base64').toString(), 'firstsecond');
assert.equal(Buffer.from(redirectExit.stderr.data, 'base64').toString(), 'error');
assert.equal(Buffer.from((await observe(redirect, '--bytes', '5')).stdout.data, 'base64').toString(), 'first');
assert.equal(Buffer.from((await observe(redirect, '--stdout', '5')).stdout.data, 'base64').toString(), 'second');

// A starter dying after terminal hard-link publication cannot retire history
// before a peer makes both the receipt file and directory entry durable.
const publish = request('while [ ! -f publish-release ]; do sleep .01; done; printf retained; exit 11');
await invoke(['start'], publish);
await Bun.write(join(root, 'publish-release'), 'release');
const publishClaim = JSON.parse(readFileSync(join(journal, publish.operationId, 'claim.json')).toString()) as {
  nonce: string; controlPath: string;
};
const quiescenceDeadline = performance.now() + 2_000;
for (;;) {
  const status = Bun.spawn([supervisorBinary, 'control', '--invocation', publish.operationId,
    '--nonce', publishClaim.nonce, '--socket', publishClaim.controlPath, '--action', 'status'], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
  });
  const [output, code] = await Promise.all([new Response(status.stdout).text(), status.exited]);
  assert.equal(code, 0);
  if (JSON.parse(output).state === 'quiescent') break;
  assert(performance.now() < quiescenceDeadline, 'Native receipt not ready for publication fault');
  await Bun.sleep(10);
}
const gate = join(root, 'terminal-link-gate');
const trace = join(root, 'terminal-sync-trace');
const publisher = Bun.spawn([...run, 'read', '--operation', publish.operationId,
  '--boot-id', publish.bootId, '--disk-lineage', publish.diskLineage], {
  stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  env: { ...process.env, LD_PRELOAD: faultsLibrary, CONFORMANCE_TERMINAL_LINK_GATE: gate },
});
try {
  const gateDeadline = performance.now() + 2_000;
  while (!existsSync(gate) && performance.now() < gateDeadline) await Bun.sleep(10);
  if (!existsSync(gate)) assert.fail('Terminal publication barrier was not exercised');
  const peer = await invoke(['read', '--operation', publish.operationId, '--boot-id', publish.bootId,
    '--disk-lineage', publish.diskLineage], undefined, {
    env: { LD_PRELOAD: faultsLibrary, CONFORMANCE_SYNC_TRACE: trace,
      CONFORMANCE_OPERATION_DIRECTORY: join(journal, publish.operationId) },
  });
  assert.equal(peer.state, 'exited');
  assert.equal(peer.receipt?.leaderExitCode, 11);
  const events = content('terminal-sync-trace').toString().trim().split('\n');
  const ack = events.indexOf('native_ack');
  assert(ack > events.indexOf('terminal_fsync') && events.indexOf('terminal_fsync') >= 0);
  assert(ack > events.indexOf('operation_dir_fsync') && events.indexOf('operation_dir_fsync') >= 0);
} finally {
  publisher.kill('SIGKILL');
  await publisher.exited;
}
assert.equal((await observe(publish)).receipt?.leaderExitCode, 11);

// Withholding release leaves credentials unconsumed; cancellation erases them.
const withheld = join(root, 'withheld-release');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
await Bun.write(withheld, '#!/bin/sh\nif [ "$1" = control ]; then\n' +
  ' for value in "$@"; do if [ "$value" = release ]; then exit 125; fi; done\nfi\n' +
  `exec ${quote(supervisorBinary)} "$@"\n`);
chmodSync(withheld, 0o700);
const unreleased = request('printf forbidden > unreleased-side-effect');
unreleased.environment.SYNTHETIC_SECRET = 'synthetic-unconsumed-credential';
assert.equal((await invoke(['start'], unreleased, { supervisor: withheld })).state, 'prepared');
const unconsumedClaim = JSON.parse(readFileSync(join(journal, unreleased.operationId, 'claim.json')).toString()) as { nonce: string };
const unconsumedPath = join('/dev/shm/opengeni-run-launch', `${unconsumedClaim.nonce}.json`);
assert(existsSync(unconsumedPath));
await invoke(cancelArgs(unreleased), undefined, {
  supervisor: withheld,
});
assert(!existsSync(unconsumedPath));
assert.equal((await exited(unreleased)).receipt?.leaderExitCode, 125);
assert(!existsSync(join(root, 'unreleased-side-effect')));

// Binary pipe input, concurrent/dropped replies, ordering and exact EOF replay.
const piped = request('cat > pipe-input; cat pipe-input; printf pipe-error >&2; exit 4');
piped.stdin = true;
await invoke(['start'], piped);
const firstBytes = Buffer.from([0, 255, 240, 159, 152, 128, 10]);
const tail = data('tail');
assert.equal((await input(piped, 2, tail)).status, 'rejected');
const repeated = await Promise.all(Array.from({ length: 12 }, () => input(piped, 1, data(firstBytes))));
assert(repeated.every(result => result.status === 'accepted'));
assert.equal((await raw(['input'], {
  operationId: piped.operationId, sequence: 1, input: data('different'),
})).exitCode, 125);

await input(piped, 2, tail); // Discard a successful acknowledgement, then retry it.
assert.equal((await input(piped, 2, tail)).status, 'accepted');
assert.equal((await input(piped, 1, data(firstBytes))).status, 'accepted');
await accepted(piped, 3, { kind: 'close' });
const pipeExit = await exited(piped);
const expectedPipe = Buffer.concat([firstBytes, Buffer.from('tail')]);
assert.deepEqual(content('pipe-input'), expectedPipe);
assert.deepEqual(Buffer.from(pipeExit.stdout.data, 'base64'), expectedPipe);
assert.equal(Buffer.from(pipeExit.stderr.data, 'base64').toString(), 'pipe-error');
assert.equal(pipeExit.receipt?.leaderExitCode, 4);
assert.equal(pipeExit.receipt?.acceptedInputSequence, 3);
assert.equal((await input(piped, 3, { kind: 'close' })).status, 'accepted');
assert.equal((await input(piped, 4, data('late'))).status, 'rejected');
assert.equal((await input(piped, 1, data(firstBytes))).status, 'accepted');
unlinkSync(join(journal, piped.operationId, 'input-1.json'));
assert.equal((await input(piped, 1, data(firstBytes))).status, 'unknown');
assert(!existsSync(join(journal, piped.operationId, 'input-1.json')));

// A full pipe holds one pending action in RAM; identical retries resume it.
const blocked = request('sleep 2; cat > delayed-input');
blocked.stdin = true;
await invoke(['start'], blocked);
const block = data(Buffer.alloc(4096, 255));
let pendingSequence = 0;
for (let sequence = 1; sequence <= 64; sequence++) {
  const reply = await input(blocked, sequence, block);
  if (reply.status === 'pending') { pendingSequence = sequence; break; }
  assert.equal(reply.status, 'accepted');
}
assert(pendingSequence > 0, 'Fixture must actually fill the native pipe');
await accepted(blocked, pendingSequence, block);
await accepted(blocked, pendingSequence + 1, { kind: 'close' });
await exited(blocked);
assert.deepEqual(content('delayed-input'), Buffer.alloc(pendingSequence * 4096, 255));

// No input plaintext in the journal; missing history is never reconstructed.
const privateInput = request('cat >/dev/null');
privateInput.stdin = true;
await invoke(['start'], privateInput);
const syntheticInput = data('synthetic-input-credential');
await accepted(privateInput, 1, syntheticInput);
for (const file of readdirSync(join(journal, privateInput.operationId))) {
  assert(!readFileSync(join(journal, privateInput.operationId, file)).includes('synthetic-input-credential'));
}
unlinkSync(join(journal, privateInput.operationId, 'input-1.json'));
assert.equal((await input(privateInput, 1, syntheticInput)).status, 'unknown');
assert(!existsSync(join(journal, privateInput.operationId, 'input-1.json')));
await accepted(privateInput, 2, { kind: 'close' });
await exited(privateInput);

// PTY identity, merged output and terminal resize remain bound to this owner.
const terminalInput = request(
  'stty -echo; test -t 0 && test -t 1 && test -t 2 || exit 90; ' +
  'stty size; printf ready\\n; IFS= read -r value; ' +
  'printf "value:%s\\n" "$value"; printf merged >&2; stty size; exit 6',
);
terminalInput.stdin = true;
terminalInput.pty = { columns: 80, rows: 24 };
await invoke(['start'], terminalInput);
const readyDeadline = performance.now() + 2_000;
while (!Buffer.from((await observe(terminalInput)).stdout.data, 'base64').includes('ready') &&
  performance.now() < readyDeadline) await Bun.sleep(10);
assert(Buffer.from((await observe(terminalInput)).stdout.data, 'base64').includes('24 80'));
await accepted(terminalInput, 1, { kind: 'resize', columns: 132, rows: 41 });
await accepted(terminalInput, 2, data('hello😀\n'));
const terminalExit = await exited(terminalInput);
const terminalBytes = Buffer.from(terminalExit.stdout.data, 'base64');
assert(terminalBytes.includes('value:hello😀\r\n'));
assert(terminalBytes.includes('merged41 132\r\n'));
assert.equal(terminalExit.stderr.data, '');
assert.equal(terminalExit.receipt?.leaderExitCode, 6);
assert.equal(terminalExit.receipt?.acceptedInputSequence, 2);
assert.equal((await input(terminalInput, 1, { kind: 'resize', columns: 132, rows: 41 })).status, 'accepted');
assert.equal((await raw(['input'], {
  operationId: terminalInput.operationId, sequence: 3, input: { kind: 'close' },
})).exitCode, 125);

// A temporarily closed terminal may be reopened by a surviving descendant.
const reopened = request('terminal=$(tty); exec 0<&- 1>&- 2>&-; sleep .2; printf reopened > "$terminal"; exit 12');
reopened.stdin = true;
reopened.pty = { columns: 80, rows: 24 };
await invoke(['start'], reopened);
const reopenedExit = await exited(reopened);
assert.equal(Buffer.from(reopenedExit.stdout.data, 'base64').toString(), 'reopened');
assert.equal(reopenedExit.receipt?.leaderExitCode, 12);

// Cancellation freezes input admission, including an actual partial PTY write.
const partial = request('stty raw -echo; printf ready; sleep 4; cat >/dev/null');
partial.stdin = true;
partial.pty = { columns: 80, rows: 24 };
await invoke(['start'], partial);
const partialReady = performance.now() + 2_000;
while (!Buffer.from((await observe(partial)).stdout.data, 'base64').includes('ready') &&
  performance.now() < partialReady) await Bun.sleep(10);
assert(Buffer.from((await observe(partial)).stdout.data, 'base64').includes('ready'));
const partialBytes = data(Buffer.alloc(4096, 65));
let partialSequence = 0;
for (let sequence = 1; sequence <= 64; sequence++) {
  const reply = await input(partial, sequence, partialBytes);
  if (reply.status === 'pending') { partialSequence = sequence; break; }
  assert.equal(reply.status, 'accepted');
}
assert(partialSequence > 0);
await invoke(cancelArgs(partial));
const partialExit = await exited(partial);
assert.equal(partialExit.receipt?.acceptedInputSequence, partialSequence - 1);
assert.equal(partialExit.receipt?.incompleteInputSequence, partialSequence);
assert.equal((await input(partial, partialSequence, partialBytes)).status, 'unknown');
assert.equal((await input(partial, partialSequence + 1, data('late'))).status, 'rejected');
assert.equal((await invoke(['start'], partial)).state, 'exited');

const cancelInput = request('trap "" TERM; while IFS= read -r value; do printf "%s" "$value" >> cancel-input; done; sleep 4');
cancelInput.stdin = true;
await invoke(['start'], cancelInput);
await accepted(cancelInput, 1, data('before\n'));
await invoke(cancelArgs(cancelInput));
assert.equal((await input(cancelInput, 2, data('after\n'))).status, 'rejected');
await exited(cancelInput);
assert(!contentOrEmpty('cancel-input').includes('after'));
assert.equal((await input(cancelInput, 1, data('before\n'))).status, 'accepted');
// A crashed I/O owner cannot be replaced to replay an uncertain input action.
const deadInput = request('cat > crashed-input');
deadInput.stdin = true;
await invoke(['start'], deadInput);
await accepted(deadInput, 1, data('once'));
process.kill(supervisorOwner(deadInput), 'SIGKILL');
assert.equal((await input(deadInput, 1, data('once'))).status, 'unknown');
assert.equal((await invoke(['start'], deadInput)).state, 'unknown');
await Bun.sleep(100);
assert.equal(content('crashed-input').toString(), 'once');
console.log('journal Linux conformance passed: retry, bytes, crash windows, cancel, descendants, secrets, stdin, backpressure, PTY');
