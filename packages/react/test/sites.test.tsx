import { expect, test } from "bun:test";
import type {
  WorkspaceArtifactContentResponse,
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactVersion,
} from "@opengeni/sdk";
import { SiteDetail, SiteList, loadSiteSnapshot, type SiteClient } from "../src/sites";
import { actRun, registerDom, renderComponent } from "./render-hook";
registerDom();
test("native and embedded Site loader pins the selected version and rejects mismatched authority scope", async () => {
  const calls: unknown[] = [];
  const readClient = {
    getWorkspaceArtifact: async () => structuredClone(detail),
    getWorkspaceArtifactHtml: async (_workspace: string, _site: string, options?: unknown) => {
      calls.push(options);
      return content.html;
    },
  };
  const snapshot = await loadSiteSnapshot(readClient, "space", "site");
  expect(snapshot.detail.artifact.id).toBe("site");
  expect(calls).toEqual([{ versionId: "current" }]);
  await expect(loadSiteSnapshot(readClient, "other-space", "site")).rejects.toThrow(
    "scope mismatch",
  );
  expect(calls).toHaveLength(1);
  await expect(
    loadSiteSnapshot(
      {
        ...readClient,
        getWorkspaceArtifactHtml: async () => {
          throw new Error("HTML unavailable");
        },
      },
      "space",
      "site",
    ),
  ).rejects.toThrow("HTML unavailable");
  const archived = {
    ...readClient,
    getWorkspaceArtifact: async () => ({
      ...detail,
      artifact: { ...detail.artifact, status: "archived" as const },
    }),
  };
  expect((await loadSiteSnapshot(archived, "space", "site")).content).toBeNull();
  expect(
    (await loadSiteSnapshot(archived, "space", "site", { includeArchivedContent: true })).content
      ?.versionId,
  ).toBe("current");
});
const version: WorkspaceArtifactVersion = {
  id: "current",
  accountId: "org",
  workspaceId: "space",
  artifactId: "site",
  revision: 2,
  contentType: "text/html",
  contentSha256: "synthetic",
  sizeBytes: 12,
  sourceSha256: null,
  sourceSizeBytes: null,
  requestedTools: [],
  sourceSessionId: null,
  sourceTurnId: null,
  sourceAttemptId: null,
  sourceExecutionGeneration: null,
  createdBySubjectId: "owner",
  createdAt: "2026-09-07T00:00:00Z",
};
const detail: WorkspaceArtifactDetailResponse = {
  artifact: {
    id: "site",
    workspaceId: "space",
    accountId: "org",
    slug: "site",
    title: "My Site",
    description: null,
    status: "active",
    currentVersion: version,
    createdBySubjectId: "owner",
    createdAt: version.createdAt,
    updatedAt: version.createdAt,
  },
  versions: [version, { ...version, id: "older", revision: 1 }],
  events: [],
  versionsTruncated: false,
  eventsTruncated: false,
};
const content: WorkspaceArtifactContentResponse = {
  artifactId: "site",
  versionId: "current",
  contentType: "text/html",
  contentSha256: "synthetic",
  html: "<p>Private inventory</p>",
  source: { entrypoint: "index.html", files: [] },
  requestedTools: [],
};
function client(overrides: Partial<SiteClient> = {}): SiteClient {
  return {
    listWorkspaceArtifacts: async () => ({
      artifacts: [detail.artifact],
      nextCursor: null,
      truncated: false,
    }),
    getWorkspaceArtifact: async () => structuredClone(detail),
    getWorkspaceArtifactHtml: async () => content.html,
    rollbackWorkspaceArtifact: async () => {
      throw new Error("unexpected rollback");
    },
    setWorkspaceArtifactStatus: async () => {
      throw new Error("unexpected status");
    },
    ...overrides,
  };
}
function button(container: HTMLElement, label: string) {
  const result = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  if (!result) throw new Error(`Missing ${label}`);
  return result;
}
test("Site frame reuses opaque sandbox and disappears on denied refresh", async () => {
  let denied = false;
  const source = client({
    getWorkspaceArtifact: async () => {
      if (denied) throw new Error("private diagnostic");
      return detail;
    },
  });
  const view = await renderComponent(
    <SiteDetail client={source} workspaceId="space" siteId="site" />,
  );
  try {
    const frame = view.container.querySelector("iframe")!;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(view.container.textContent).not.toContain("Manage Site");
    denied = true;
    await actRun(() => button(view.container, "Refresh Site").click());
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(view.container.textContent).toContain("access has changed");
    expect(view.container.textContent).not.toContain("private diagnostic");
  } finally {
    await view.unmount();
  }
});
test("Site changes require confirmation and preserve observed version without unsafe retry", async () => {
  const calls: unknown[] = [];
  const source = client({
    setWorkspaceArtifactStatus: async (_workspace, _site, request) => {
      calls.push(request);
      throw new Error("outcome unknown");
    },
  });
  const view = await renderComponent(
    <SiteDetail client={source} workspaceId="space" siteId="site" canPublish />,
  );
  try {
    await actRun(() => button(view.container, "Archive Site").click());
    expect(calls).toHaveLength(0);
    await actRun(() => button(view.container, "Confirm change").click());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ expectedCurrentVersionId: "current", status: "archived" });
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(view.container.textContent).not.toContain("Confirm change");
  } finally {
    await view.unmount();
  }
});
test("Site actor replacement ignores late content even when a transport ignores cancellation", async () => {
  let finish!: (value: string) => void;
  const previous = client({
    getWorkspaceArtifactHtml: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const next = client({
    getWorkspaceArtifact: async () => {
      throw new Error("denied");
    },
  });
  const view = await renderComponent(
    <SiteDetail client={previous} workspaceId="space" siteId="site" />,
  );
  try {
    await view.rerender(<SiteDetail client={next} workspaceId="space" siteId="site" />);
    await actRun(() => finish(content.html));
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(view.container.textContent).not.toContain("My Site");
  } finally {
    await view.unmount();
  }
});
test("Site list keeps navigation in the host and clears inventory on actor change", async () => {
  let selected: unknown;
  const source = client();
  const view = await renderComponent(
    <SiteList
      client={source}
      workspaceId="space"
      onOpen={(site) => {
        selected = site;
      }}
    />,
  );
  try {
    await actRun(() => button(view.container, "My Site").click());
    expect(selected).toEqual(detail.artifact);
    await view.rerender(
      <SiteList
        client={client({
          listWorkspaceArtifacts: async () => ({
            artifacts: [],
            nextCursor: null,
            truncated: false,
          }),
        })}
        workspaceId="space"
        onOpen={() => {}}
      />,
    );
    expect(view.container.textContent).not.toContain("My Site");
    expect(view.container.textContent).toContain("No active Sites");
  } finally {
    await view.unmount();
  }
});
