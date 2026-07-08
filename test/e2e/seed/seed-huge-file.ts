// seed-huge-file — STUB (dossier §16). Will trip the pathological per-file guard
// so the Changes tab shows the "too large — open live" affordance (acceptance
// B4) rather than a silently-truncated diff. Wired once M1 lands the guard
// thresholds so this seed can assert against the real limit.
import { runSeed, seedSessionWithBash, stubNotImplemented } from "./harness";

const PLAN = `
Init a repo; commit a small base version of big.bin / big.txt; then within one
turn regenerate it above the per-file capture guard (e.g. a multi-MB single-file
diff and a >5MB after-image) plus one normal small change. Expected: the huge
file renders as an "open live" marker while the small change diffs normally, and
the whole-capture guard is NOT tripped.
`;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _future = () =>
  runSeed("huge-file", ({ client, workspaceId }) =>
    seedSessionWithBash(client, workspaceId, {
      title: "Huge single-file diff (guard trip)",
      origin: "workbench-seed-huge-file",
      bashScript: "true",
    }),
  );

stubNotImplemented("huge-file", PLAN);
