// The web app backs the shared session UI with its own router, API helpers and
// optional heavy surfaces, as the page that owns the document. main.tsx
// imports this first, before any session surface renders.
import { apiBaseUrl, request, requestResponse, voiceRealtimeClient } from "@/api";
// Configures navigation itself, so tests can import only the router part.
import "@/navigation-host";
import type { AppApiHost } from "@opengeni/react/app/lib/app-api";
import { configurePageAppHost } from "@opengeni/react/app/lib/app-host";
import { lazySurface } from "@opengeni/react/app/lib/app-surfaces";

export const webAppApiHost: AppApiHost = {
  apiBaseUrl,
  request,
  requestResponse,
  voiceRealtimeClient,
};

configurePageAppHost({
  api: webAppApiHost,
  surfaces: {
    pdfPreview: lazySurface(() => import("@/components/artifacts/pdf-file-preview")),
    codexSubscriptions: lazySurface(async () => ({
      default: (await import("@/components/models/codex-models")).CodexSubscriptionsCard,
    })),
    editableArtifact: lazySurface(() =>
      import("@/routes/editable-artifact").then((module) => ({
        default: module.EditableArtifactRoute,
      })),
    ),
  },
});
