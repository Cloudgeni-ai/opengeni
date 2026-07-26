// seed-terminal-burst — STUB. Floods stdout (e.g. `seq`/`yes`
// bursts, ANSI color spam) to stress the terminal renderer's throughput and
// scrollback under the WebGL overhaul (acceptance E6). Wired at M6 when the
// interactive pty-ws terminal + WebGL addon are the thing under test; the fixture
// is a long-lived box, so this pairs with a live/warm capture flow, not a diff.
import { runSeed, seedSessionWithBash, stubNotImplemented } from "./harness";

const PLAN = `
Create a session whose turn writes a burst-generator script (e.g. a loop emitting
thousands of colored lines) but does not run it to completion in-turn — the UI's
Terminal tab runs it interactively to measure frame-time under load. Keep the box
warm (live seed) so the pty-ws socket is exercised. Assert no visible stall vs a
DOM-renderer baseline (frame-time sample, real-behavior doctrine).
`;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _future = () =>
  runSeed("terminal-burst", ({ client, workspaceId }) =>
    seedSessionWithBash(client, workspaceId, {
      title: "Bursty terminal output (renderer stress)",
      origin: "workbench-seed-terminal-burst",
      bashScript: "true",
    }),
  );

stubNotImplemented("terminal-burst", PLAN);
