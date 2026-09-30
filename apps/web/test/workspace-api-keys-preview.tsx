import { createRoot } from "react-dom/client";
import { WorkspaceApiKeysPage } from "../src/routes/workspace-api-keys";
import { submittedRequests, workspaceId } from "./workspace-api-keys-preview-context";
import "../src/styles.css";

Object.assign(window, { submittedRequests });
createRoot(document.getElementById("root")!).render(
  <main className="min-h-dvh bg-bg px-6 py-6 text-fg">
    <div className="mx-auto max-w-[960px]">
      <p className="mb-6 text-xs text-fg-muted">Preview · Sample workspace · No real keys</p>
      <WorkspaceApiKeysPage workspaceId={workspaceId} keyParam="new" />
    </div>
  </main>,
);
