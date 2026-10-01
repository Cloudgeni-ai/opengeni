// Settings > Developer against an in-memory API: webhooks with deliveries, a
// failing test, a connected provider whose test returns credential names, and
// an organization webhook the workspace inherits. `?view=` and `?webhook=` in
// the fixture URL pick the starting page.
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { WorkspaceDeveloperSettings } from "../src/components/workspace-developer-settings";
import { SectionVariantProvider } from "../src/components/ui/section-variant";
import { Toaster } from "../src/components/ui/sonner";
import { TooltipProvider } from "../src/components/ui/tooltip";
import type { DeveloperLocation } from "../src/lib/developer-route";
import { parseDeveloperView, parseWebhookParam } from "../src/lib/developer-route";
import "../src/styles.css";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const now = Date.now();
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const inMinutes = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

type Webhook = {
  id: string;
  workspaceId: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

const webhooks: Webhook[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId,
    url: "https://product.example/opengeni/events",
    eventTypes: ["turn.completed", "turn.failed", "session.requiresAction"],
    enabled: true,
    description: null,
    createdAt: minutesAgo(60 * 24 * 3),
    updatedAt: minutesAgo(60 * 24 * 3),
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    workspaceId,
    url: "https://staging.product.example/opengeni/events",
    eventTypes: ["turn.completed", "turn.failed"],
    enabled: true,
    description: null,
    createdAt: minutesAgo(60 * 24),
    updatedAt: minutesAgo(60 * 24),
  },
];

function delivery(
  webhookId: string,
  eventType: string,
  status: "pending" | "delivered" | "failed",
  attempts: number,
  minutes: number,
  lastStatus: number | null,
) {
  return {
    id: crypto.randomUUID(),
    webhookId,
    eventId: crypto.randomUUID(),
    eventType,
    status,
    attempts,
    lastStatus,
    lastError: lastStatus && lastStatus >= 300 ? `HTTP ${lastStatus}` : null,
    nextAttemptAt: status === "pending" ? inMinutes(4) : null,
    deliveredAt: status === "delivered" ? minutesAgo(minutes) : null,
    failedAt: status === "failed" ? minutesAgo(minutes) : null,
    createdAt: minutesAgo(minutes),
  };
}

const deliveries: Record<string, ReturnType<typeof delivery>[]> = {
  [webhooks[0]!.id]: [
    delivery(webhooks[0]!.id, "turn.completed", "delivered", 1, 2, 204),
    delivery(webhooks[0]!.id, "session.requiresAction", "delivered", 1, 9, 204),
    delivery(webhooks[0]!.id, "turn.failed", "delivered", 2, 40, 200),
  ],
  [webhooks[1]!.id]: [
    delivery(webhooks[1]!.id, "turn.completed", "pending", 3, 6, 503),
    delivery(webhooks[1]!.id, "turn.failed", "failed", 12, 300, 503),
    delivery(webhooks[1]!.id, "turn.completed", "delivered", 1, 900, 204),
  ],
};

const provider = {
  workspaceId,
  url: "https://product.example/opengeni/credentials",
  enabled: true,
  timeoutMs: 10_000,
  createdAt: minutesAgo(60 * 24 * 5),
  updatedAt: minutesAgo(60 * 24 * 5),
};

async function later<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return structuredClone(value);
}

const client = {
  listWorkspaceWebhooks: async () => later({ webhooks }),
  createWorkspaceWebhook: async (_: string, request: { url: string; eventTypes: string[] }) => {
    const webhook: Webhook = {
      id: "44444444-4444-4444-8444-444444444444",
      workspaceId,
      url: request.url,
      eventTypes: request.eventTypes,
      enabled: true,
      description: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    webhooks.push(webhook);
    deliveries[webhook.id] = [];
    return later({ webhook, secret: "whsec_fixture_shown_once" });
  },
  updateWorkspaceWebhook: async (_: string, id: string, request: Partial<Webhook>) => {
    const webhook = webhooks.find((each) => each.id === id)!;
    Object.assign(webhook, request);
    return later(webhook);
  },
  deleteWorkspaceWebhook: async (_: string, id: string) => {
    webhooks.splice(
      webhooks.findIndex((each) => each.id === id),
      1,
    );
  },
  listWorkspaceWebhookDeliveries: async (_: string, id: string) =>
    later({ deliveries: deliveries[id] ?? [] }),
  redeliverWorkspaceWebhookDelivery: async () => later({}),
  getWorkspaceCredentialProvider: async () => later({ provider }),
  putWorkspaceCredentialProvider: async () => later({ provider }),
  deleteWorkspaceCredentialProvider: async () => undefined,
  requestJson: async (method: string, path: string) => {
    if (path.endsWith("/inherited-integrations")) {
      return later({
        credentialProvider: null,
        webhooks: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            url: "https://analytics.example/hooks/opengeni",
            eventTypes: ["turn.completed"],
            description: null,
          },
        ],
      });
    }
    if (method === "POST" && path.endsWith("/credential-provider/test")) {
      return later({
        lane: "workspace",
        url: provider.url,
        result: {
          ok: true,
          status: 200,
          durationMs: 142,
          error: null,
          request: JSON.stringify({ type: "credentials.request", purpose: "test", workspaceId }),
          responseBody: null,
          credentials: {
            status: "ok",
            environment: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"],
            files: ["gcp/key.json"],
            git: ["github.com"],
            mcp: [],
            expiresAt: inMinutes(55),
            authNeeded: [],
          },
        },
      });
    }
    if (method === "POST" && path.endsWith("/test")) {
      const failing = path.includes(webhooks[1]!.id);
      return later({
        result: {
          ok: !failing,
          status: failing ? 401 : 204,
          durationMs: 87,
          error: failing
            ? "The endpoint refused the request (HTTP 401). Check that it verifies with this webhook's signing secret."
            : null,
          request: JSON.stringify({ id: crypto.randomUUID(), type: "webhook.test", workspaceId }),
          responseBody: failing ? '{"error":"invalid signature"}' : null,
          credentials: null,
        },
      });
    }
    if (path.includes("/rotate-secret")) return later({ secret: "whsec_rotated_shown_once" });
    throw new Error(`fixture has no ${method} ${path}`);
  },
};

function initialLocation(): DeveloperLocation {
  const search = new URLSearchParams(window.location.search);
  const view = parseDeveloperView(search.get("view"));
  const webhook = parseWebhookParam(search.get("webhook"));
  return { ...(view ? { view } : {}), ...(webhook ? { webhook } : {}) };
}

function Fixture() {
  const [location, setLocation] = useState<DeveloperLocation>(initialLocation);
  return (
    <TooltipProvider>
      <main data-canvas className="mx-auto max-w-[960px] px-4 py-6 sm:px-8">
        <SectionVariantProvider variant="group">
          <WorkspaceDeveloperSettings
            client={client as never}
            workspaceId={workspaceId}
            canManage
            location={location}
            onNavigate={setLocation}
          />
        </SectionVariantProvider>
      </main>
      <Toaster />
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
