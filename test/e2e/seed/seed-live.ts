// seed-live — STUB. A long-running / mid-turn session that stays
// WARM, for the warm-live UI path (live reads, live writes, fs.changed reconcile,
// machine chip = "live"; acceptance A3). Wired at M3 when the capture-vs-live
// source selection exists and the warm no-flicker reconcile is under test. Unlike
// the other seeds this must keep the box warm (hold a viewer / keep a turn
// running), not settle-and-drain.
import { runSeed, seedSessionWithBash, stubNotImplemented } from "./harness";

const PLAN = `
Start a session whose turn kicks off a long-running process (or leave a turn
in-flight) so the box stays warm and reachable. The UI then exercises the live
path: live gitDiff/fsRead, an optimistic fs.write echo, and the machine chip
showing "live". Pair with a viewer-attach hold so the box does not drain during
the screenshot pass.
`;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _future = () =>
  runSeed("live", ({ client, workspaceId }) =>
    seedSessionWithBash(client, workspaceId, {
      title: "Warm/live long-running session",
      origin: "workbench-seed-live",
      bashScript: "true",
    }),
  );

stubNotImplemented("live", PLAN);
