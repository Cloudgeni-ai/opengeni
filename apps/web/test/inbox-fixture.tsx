import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { InboxRoute } from "../src/routes/inbox";
import "../src/styles.css";

// Real Inbox page, deterministic sample items; no API requests.
const route = createRootRoute({ component: () => <InboxRoute workspaceId="fixture" /> });
const router = createRouter({ routeTree: route, history: createMemoryHistory() });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
