import { OpenGeniClient } from "@opengeni/sdk/artifacts";
import type { OpenedEditableArtifact } from "@opengeni/react/artifacts";
import { downloadSpreadsheet } from "../../../apps/web/src/lib/editable-spreadsheet-download";
import { mountSpreadsheetUxFixture } from "./artifact-spreadsheet-ux-fixture";
import "./styles.css";

const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const calls: string[] = [];
let fail = false;
let pending = true;
// Only transport/sync are simulated. The control, editor, styles, SDK client and
// pin/materialize/poll/download orchestration below are the production modules.
const client = new OpenGeniClient({
  baseUrl: window.location.origin,
  apiKey: "preview-only",
  fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (fail) {
      fail = false;
      return new Response("Export not permitted", { status: 403 });
    }
    if (path.endsWith("/versions"))
      return Response.json({ id: "preview-pinned-head", headSequence: 1 });
    if (path.endsWith("/download")) return fetch("/sample.xlsx", { signal: init?.signal ?? null });
    if (path.endsWith("/materializations")) pending = true;
    const state = pending ? "pending" : "succeeded";
    pending = false;
    return Response.json({
      id: "preview-job",
      state,
      result: state === "succeeded" ? { mimeType: mime } : null,
    });
  },
});
const root = document.createElement("div");
root.id = "root";
document.body.append(root);
const fixture = mountSpreadsheetUxFixture(root, {
  showHeader: !new URLSearchParams(location.search).has("embedded"),
  download: (signal) =>
    downloadSpreadsheet(
      client,
      "preview-workspace",
      {
        artifact: { id: "preview-artifact", modality: "spreadsheet" },
        replicaId: "preview-replica",
      } as OpenedEditableArtifact,
      signal,
    ),
});
Object.assign(window, {
  downloadFixture: {
    ...fixture,
    calls,
    fail: () => {
      fail = true;
    },
  },
});
