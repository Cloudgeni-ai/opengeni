import React from "react";
import { createRoot } from "react-dom/client";
import { ModelCompactionPage } from "../../../src/components/models/model-compaction-page";
import "../../../src/styles.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.ogTheme = params.get("theme") === "dark" ? "dark" : "light";
createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-bg px-4 py-8 text-fg sm:px-8">
    <div className="mx-auto max-w-3xl">
      <ModelCompactionPage
        workspaceId="sample"
        canManage={params.get("role") !== "viewer"}
        onClose={() => {
          document.body.dataset.closed = "true";
        }}
      />
    </div>
  </main>,
);
