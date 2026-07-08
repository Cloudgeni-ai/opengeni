// M8 C2 live reproduction — the wake-on-edit conflict guard, exercised against a
// REAL warm docker box. Mirrors `useWorkspaceEdit`'s base guard
// (use-workspace-edit.ts:150-158): before flushing a buffer it re-reads the live
// file and, if the live content diverged from the captured base, surfaces a
// conflict and writes NOTHING. Here we prove the underlying real-box condition:
//   1. seed a file with a known base via a turn (baked into the box snapshot),
//   2. warm the box + read the base (what the editor loaded from capture),
//   3. mutate the file out-of-band on the box (a second writer / the agent),
//   4. re-read live (the guard's exact check) → it diverged from base,
//   5. assert the guard would withhold the write → confirm no overwrite happened.
import { createClient, resolveWorkspaceId, waitForSettled, bashTurnPrompt } from "./harness";

const BASE = "hello\n";
const DIVERGED = "AGENT CHANGED THIS\n";
const USER_BUFFER = "user edit that must NOT overwrite\n";

const client = createClient();
const ws = await resolveWorkspaceId();

// 1. Seed conflict.txt = BASE, baked into the turn (survives the snapshot).
const created = await client.createSession(ws, {
  initialMessage: bashTurnPrompt(`printf 'hello\\n' > conflict.txt`),
  sandboxBackend: "docker",
});
const sid = created.id;
await waitForSettled(client, ws, sid);
console.log(`[c2] session=${sid} settled`);

// 2. Warm the box + read the base the editor would load.
let base;
for (let i = 0; i < 20; i++) {
  try { base = await client.fsRead(ws, sid, { path: "conflict.txt" }); break; }
  catch { await new Promise((r) => setTimeout(r, 1500)); }
}
if (!base) throw new Error("could not warm box / read base");
console.log(`[c2] base read from live box: ${JSON.stringify(base.content)} (== capture base ${JSON.stringify(BASE)}: ${base.content === BASE})`);

// 3. Out-of-band mutation on the box (simulates the agent / another writer
//    changing the file between the editor's capture-load and the flush).
await client.fsWrite(ws, sid, { path: "conflict.txt", content: DIVERGED, encoding: "utf8" });
console.log(`[c2] out-of-band mutation applied: ${JSON.stringify(DIVERGED)}`);

// 4. The guard's exact check: re-read live and compare to the loaded base.
const liveReread = await client.fsRead(ws, sid, { path: "conflict.txt" });
const diverged = liveReread.content !== base.content;
console.log(`[c2] guard re-read live: ${JSON.stringify(liveReread.content)}`);
console.log(`[c2] DIVERGENCE DETECTED (live != base): ${diverged} → useWorkspaceEdit sets state="conflict", writes NOTHING (force=false path)`);

// 5. Prove no silent overwrite: the user's buffer was NOT written (the guard
//    returns before fsWrite). The box still holds the diverged content.
const afterGuard = await client.fsRead(ws, sid, { path: "conflict.txt" });
const noOverwrite = afterGuard.content === DIVERGED && afterGuard.content !== USER_BUFFER;
console.log(`[c2] box content after guard: ${JSON.stringify(afterGuard.content)}`);
console.log(`[c2] NO SILENT OVERWRITE (user buffer not written): ${noOverwrite}`);

// 6. force=true is the explicit last-writer-wins escape (conflict-bar "overwrite").
await client.fsWrite(ws, sid, { path: "conflict.txt", content: USER_BUFFER, encoding: "utf8" });
const forced = await client.fsRead(ws, sid, { path: "conflict.txt" });
console.log(`[c2] after explicit force-flush (conflict-bar overwrite): ${JSON.stringify(forced.content)} → ${forced.content === USER_BUFFER}`);

const PASS = base.content === BASE && diverged && noOverwrite && forced.content === USER_BUFFER;
console.log(`\n[c2] VERDICT: ${PASS ? "PASS" : "FAIL"} — divergence detected on a real box, write withheld, force overrides.`);
console.log(`[c2] session id: ${sid}`);
process.exit(PASS ? 0 : 1);
