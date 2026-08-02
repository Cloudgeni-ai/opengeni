import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { ConnectionHealth } from "@/lib/capabilities";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@/types";
import {
  ConnectionStatus,
  DEFAULT_CONNECTION_OWNERSHIP,
  OwnershipSelector,
} from "./capability-detail-sheet";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function item(connectionRef: CapabilityCatalogItem["connectionRef"]): CapabilityCatalogItem {
  return { connectionRef } as CapabilityCatalogItem;
}

function connection(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    subjectId: null,
    providerDomain: "linear.app",
    kind: "oauth2",
    status: "active",
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: {},
    createdBySubjectId: "subject-a",
    updatedBySubjectId: "subject-a",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("connection ownership UI", () => {
  test("defaults to workspace ownership and exposes two labeled radio choices", async () => {
    expect(DEFAULT_CONNECTION_OWNERSHIP).toBe("workspace");
    const onChange = mock((_value: "workspace" | "personal") => {});
    const rendered = await render(
      <OwnershipSelector value={DEFAULT_CONNECTION_OWNERSHIP} onChange={onChange} />,
    );
    try {
      const radios = [
        ...rendered.container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ];
      expect(radios).toHaveLength(2);
      expect(radios[0]?.value).toBe("workspace");
      expect(radios[0]?.checked).toBe(true);
      expect(radios[1]?.value).toBe("personal");
      expect(radios[1]?.checked).toBe(false);
      expect(rendered.container.textContent).toContain("Who can use this connection?");
      expect(rendered.container.textContent).toContain("Connect for workspace");
      expect(rendered.container.textContent).toContain("Connect only for me");

      await act(async () => radios[1]!.click());
      expect(onChange).toHaveBeenCalledWith("personal");
    } finally {
      await rendered.unmount();
    }
  });

  test("a deleted workspace row is not misreported as personal", async () => {
    const health: ConnectionHealth = { state: "attention", connection: null };
    const rendered = await render(
      <ConnectionStatus
        item={item({
          connectionId: "11111111-1111-4111-8111-111111111111",
          providerDomain: "linear.app",
          kind: "oauth2",
          subjectScope: "workspace",
        })}
        health={health}
      />,
    );
    try {
      expect(rendered.container.textContent).toContain(
        "Workspace connection needs to be reconnected.",
      );
      expect(rendered.container.textContent).not.toContain("Personal connection");
    } finally {
      await rendered.unmount();
    }
  });

  test("connected personal ownership is explicit without exposing its row id", async () => {
    const health: ConnectionHealth = {
      state: "connected",
      connection: connection({ subjectId: "subject-a" }),
    };
    const rendered = await render(
      <ConnectionStatus
        item={item({
          providerDomain: "linear.app",
          kind: "oauth2",
          subjectScope: "subject",
        })}
        health={health}
      />,
    );
    try {
      expect(rendered.container.textContent).toContain("Personal connection to linear.app");
      expect(rendered.container.textContent).toContain("only when explicitly delegated");
      expect(rendered.container.textContent).not.toContain("11111111-1111-4111-8111-111111111111");
    } finally {
      await rendered.unmount();
    }
  });
});
