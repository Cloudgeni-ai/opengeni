import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { KnowledgeBrowser } from "../src/components/knowledge/knowledge-browser";
import "../src/styles.css";
const route = createRootRoute({
  component: () => (
    <main className="mx-auto max-w-5xl p-8">
      <KnowledgeBrowser workspaceId="fixture" />
    </main>
  ),
});
const router = createRouter({ routeTree: route, history: createMemoryHistory() });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
