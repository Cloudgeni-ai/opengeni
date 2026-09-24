import React from "react";
import { createRoot } from "react-dom/client";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { FileTextIcon } from "lucide-react";

import { KnowledgeCard } from "../../../src/components/knowledge/knowledge-card";
import { KnowledgeIndexNotice } from "../../../src/components/knowledge/knowledge-index-status";
import type { KnowledgeIndexStatus } from "@opengeni/sdk";
import "../../../src/styles.css";

const files: { name: string; status: KnowledgeIndexStatus }[] = [
  { name: "Contract.pdf", status: "queued" },
  { name: "Product brief.pdf", status: "awaiting_funding" },
  { name: "Release notes.txt", status: "provider_failed" },
  { name: "Policies.pdf", status: "indexed" },
];

function Preview() {
  return (
    <main className="min-h-screen bg-bg px-4 py-8 text-fg sm:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle">Agent Knowledge · Files</p>
          <h1 className="mt-2 text-2xl font-semibold">Your files</h1>
          <p className="mt-1 text-sm text-fg-muted">Sample data · actual Files status and card components</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {files.map((file) => (
            <section className="grid gap-2" key={file.name} aria-label={file.name}>
              <KnowledgeCard title={file.name} icon={<FileTextIcon className="size-6" />} variant="file"
                metadata={<span>Original saved</span>} onClick={() => {}} />
              <div className="rounded-lg border border-border/60 bg-surface/60 px-4 py-3">
                <p className="mb-2 text-xs font-medium text-fg-subtle">When opened · source status</p>
                <KnowledgeIndexNotice workspaceId="preview-workspace" status={file.status} />
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
const root = createRootRoute({ component: Preview });
const billing = createRoute({ getParentRoute: () => root, path: "/workspaces/$workspaceId/organization", component: () => null });
const router = createRouter({ routeTree: root.addChildren([billing]) });
createRoot(document.getElementById("root")!).render(<React.StrictMode><RouterProvider router={router} /></React.StrictMode>);