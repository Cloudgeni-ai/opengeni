// seed-unicode — STUB (dossier §16). CJK / emoji / RTL in both file PATHS and
// file CONTENTS, to catch tofu glyphs, byte-vs-codepoint width bugs in the diff
// and tree, and mojibake in the terminal. Wired once the Changes tab + terminal
// theming land (M5/M6) so the screenshots have a real target.
import { runSeed, seedSessionWithBash, stubNotImplemented } from "./harness";

const PLAN = `
One turn creates files with unicode paths (e.g. "src/日本語.ts", "docs/café.md",
"emoji-📁/note.txt") and unicode/emoji/RTL contents, commits a base, then edits
them so the diff pane must render mixed-width and combining characters correctly.
Assert the tree + Changes list show the paths without tofu and the diff aligns.
`;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _future = () =>
  runSeed("unicode", ({ client, workspaceId }) =>
    seedSessionWithBash(client, workspaceId, {
      title: "Unicode/CJK/emoji paths and contents",
      origin: "workbench-seed-unicode",
      bashScript: "true",
    }),
  );

stubNotImplemented("unicode", PLAN);
