import { expect, jest, test } from "bun:test";
import type { WorkspaceArtifactDetailResponse, WorkspaceArtifactVersion } from "@opengeni/sdk";
import { ArtifactSandbox, SiteView } from "../src/artifacts";
import { usePortalContainer } from "../src/ui/portal-container";
import { actRun, registerDom, renderComponent, withVirtualClock } from "./render-hook";

registerDom();

const version = (revision: number): WorkspaceArtifactVersion => ({
  id: `version-${revision}`,
  accountId: "org",
  workspaceId: "space",
  artifactId: "site",
  revision,
  contentType: "text/html",
  contentSha256: `sha-${revision}`,
  sizeBytes: 12,
  sourceSha256: null,
  sourceSizeBytes: null,
  requestedTools: [],
  sourceSessionId: null,
  sourceTurnId: null,
  sourceAttemptId: null,
  sourceExecutionGeneration: null,
  createdBySubjectId: "owner",
  createdAt: "2026-10-23T12:00:00Z",
});
const detailAt = (revision: number): WorkspaceArtifactDetailResponse => ({
  artifact: {
    id: "site",
    workspaceId: "space",
    accountId: "org",
    slug: "site",
    title: "Usage",
    description: null,
    status: "active",
    currentVersion: version(revision),
    createdBySubjectId: "owner",
    createdAt: "2026-10-23T12:00:00Z",
    updatedAt: "2026-10-23T12:00:00Z",
  },
  versions: [version(revision)],
  events: [],
  versionsTruncated: false,
  eventsTruncated: false,
});

/** A Site whose live version the test moves, with HTML per version. */
function liveSite() {
  const state = {
    revision: 4,
    fail: false,
    pending: null as null | (() => void),
    hold: false,
  };
  const html: Record<number, string> = {
    4: "<h1 style='color:black'>Usage</h1>",
    5: "<h1 style='color:blue'>Usage</h1>",
  };
  const client = {
    getWorkspaceArtifact: async () => {
      if (state.hold) await new Promise<void>((resolve) => (state.pending = resolve));
      if (state.fail) throw new Error("offline");
      return detailAt(state.revision);
    },
    getWorkspaceArtifactHtml: async () => html[state.revision]!,
  };
  return { state, client };
}

const frame = (container: HTMLElement) => container.querySelector("iframe");
const live = (container: HTMLElement) => container.querySelector("[data-live-status]");
const settle = () => actRun(() => new Promise((resolve) => setTimeout(resolve, 10)));

test("a newly published version reloads the Site in place, keeping the old one until it loads", async () => {
  const site = liveSite();
  const draw = (versionId: string) => (
    <SiteView client={site.client} workspaceId="space" siteId="site" versionId={versionId} />
  );
  const view = await renderComponent(draw("version-4"));
  try {
    await settle();
    const first = frame(view.container)!;
    expect(first.getAttribute("srcdoc")).toContain("color:black");
    expect(live(view.container)?.getAttribute("data-live-status")).toBe("live");
    expect(live(view.container)?.textContent).toBe("Live");
    // The side chat publishes version 5 and the host reads it.
    site.state.revision = 5;
    site.state.hold = true;
    await view.rerender(draw("version-5"));
    await settle();
    // Loading: the old version stays on screen and the label says so.
    expect(frame(view.container)?.getAttribute("srcdoc")).toContain("color:black");
    expect(live(view.container)?.textContent).toBe("Updating");
    expect(live(view.container)?.getAttribute("role")).toBe("status");
    site.state.hold = false;
    await actRun(() => site.state.pending?.());
    await settle();
    const second = frame(view.container)!;
    expect(second.getAttribute("srcdoc")).toContain("color:blue");
    // A new page, not a patched one: the frame was replaced.
    expect(second).not.toBe(first);
    // Once: the Site's load-time code runs once for the new version.
    await settle();
    await settle();
    expect(frame(view.container)).toBe(second);
    expect(live(view.container)?.textContent).toBe("Live");
    expect(view.container.textContent).toContain("v5");
  } finally {
    await view.unmount();
  }
});

test("the frame is replaced once per new version, never patched and then reloaded", async () => {
  const site = liveSite();
  const draw = (versionId: string) => (
    <SiteView client={site.client} workspaceId="space" siteId="site" versionId={versionId} />
  );
  const view = await renderComponent(draw("version-4"));
  try {
    await settle();
    const added: Element[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof Element && node.tagName === "IFRAME") added.push(node);
    });
    observer.observe(view.container, { childList: true, subtree: true });
    const first = frame(view.container)!;
    site.state.revision = 5;
    await view.rerender(draw("version-5"));
    await settle();
    await settle();
    observer.disconnect();
    // The old frame was never handed the new page: one new frame, with it.
    expect(first.getAttribute("srcdoc")).toContain("color:black");
    expect(added).toHaveLength(1);
    expect(added[0]!.getAttribute("srcdoc")).toContain("color:blue");
  } finally {
    await view.unmount();
  }
});

test("a failed update tries again by itself and the Site goes live", async () => {
  await withVirtualClock(async () => {
    const site = liveSite();
    const draw = (versionId: string) => (
      <SiteView client={site.client} workspaceId="space" siteId="site" versionId={versionId} />
    );
    const view = await renderComponent(draw("version-4"));
    try {
      await actRun(() => jest.advanceTimersByTime(10));
      site.state.revision = 5;
      site.state.fail = true;
      await view.rerender(draw("version-5"));
      await actRun(() => jest.advanceTimersByTime(10));
      expect(live(view.container)?.textContent).toBe("Reconnecting");
      // Still failing at the first retry: it waits longer and tries again.
      await actRun(() => jest.advanceTimersByTime(2_000));
      await actRun(() => jest.advanceTimersByTime(10));
      expect(live(view.container)?.textContent).toBe("Reconnecting");
      site.state.fail = false;
      await actRun(() => jest.advanceTimersByTime(4_000));
      await actRun(() => jest.advanceTimersByTime(10));
      expect(frame(view.container)?.getAttribute("srcdoc")).toContain("color:blue");
      expect(live(view.container)?.textContent).toBe("Live");
    } finally {
      await view.unmount();
    }
  });
});

test("a hidden tab doesn't retry a failed update until it is shown again", async () => {
  await withVirtualClock(async () => {
    const site = liveSite();
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let state: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    const draw = (versionId: string) => (
      <SiteView client={site.client} workspaceId="space" siteId="site" versionId={versionId} />
    );
    const view = await renderComponent(draw("version-4"));
    try {
      await actRun(() => jest.advanceTimersByTime(10));
      site.state.revision = 5;
      site.state.fail = true;
      state = "hidden";
      await view.rerender(draw("version-5"));
      await actRun(() => jest.advanceTimersByTime(10));
      expect(live(view.container)?.textContent).toBe("Reconnecting");
      site.state.fail = false;
      await actRun(() => jest.advanceTimersByTime(60_000));
      expect(frame(view.container)?.getAttribute("srcdoc")).not.toContain("color:blue");
      state = "visible";
      await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
      await actRun(() => jest.advanceTimersByTime(10));
      expect(frame(view.container)?.getAttribute("srcdoc")).toContain("color:blue");
      expect(live(view.container)?.textContent).toBe("Live");
    } finally {
      await view.unmount();
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      else delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });
});

test("in full screen, menus opened from the header draw inside the full-screen frame", async () => {
  function Probe() {
    const container = usePortalContainer();
    return <span data-portal={container ? container.nodeName : "body"} />;
  }
  const draw = (fullScreen: boolean) => (
    <ArtifactSandbox
      html="<p>Site</p>"
      title="Usage"
      fullScreen={fullScreen}
      headerControls={<Probe />}
    />
  );
  const view = await renderComponent(draw(false));
  try {
    const portal = () => view.container.querySelector("[data-portal]")?.getAttribute("data-portal");
    // The page's own target (here, <body>) outside full screen.
    expect(portal()).toBe("body");
    await view.rerender(draw(true));
    expect(portal()).toBe("DIALOG");
    await view.rerender(draw(false));
    expect(portal()).toBe("body");
  } finally {
    await view.unmount();
  }
});

test("a failed update keeps the Site on screen and says it is reconnecting", async () => {
  const site = liveSite();
  const draw = (versionId: string, watch?: "live" | "reconnecting") => (
    <SiteView
      client={site.client}
      workspaceId="space"
      siteId="site"
      versionId={versionId}
      watch={watch}
    />
  );
  const view = await renderComponent(draw("version-4"));
  try {
    await settle();
    site.state.fail = true;
    await view.rerender(draw("version-5"));
    await settle();
    expect(frame(view.container)?.getAttribute("srcdoc")).toContain("color:black");
    expect(live(view.container)?.textContent).toBe("Reconnecting");
    // The host's own watch failing says the same.
    site.state.fail = false;
    const steady = await renderComponent(draw("version-4", "reconnecting"));
    try {
      await settle();
      expect(live(steady.container)?.textContent).toBe("Reconnecting");
    } finally {
      await steady.unmount();
    }
  } finally {
    await view.unmount();
  }
});

test("a host that read an older version than the one shown doesn't reload it in a loop", async () => {
  const site = liveSite();
  site.state.revision = 5;
  let reads = 0;
  const read = site.client.getWorkspaceArtifact;
  site.client.getWorkspaceArtifact = async () => {
    reads++;
    return await read();
  };
  const view = await renderComponent(
    <SiteView client={site.client} workspaceId="space" siteId="site" versionId="version-4" />,
  );
  try {
    await settle();
    await settle();
    expect(frame(view.container)?.getAttribute("srcdoc")).toContain("color:blue");
    // One load, then one follow-up for the host's version; never more.
    expect(reads).toBeLessThanOrEqual(2);
  } finally {
    await view.unmount();
  }
});

test("without a watching host the label stays the plain Live badge", async () => {
  const site = liveSite();
  const view = await renderComponent(
    <SiteView client={site.client} workspaceId="space" siteId="site" />,
  );
  try {
    await settle();
    expect(live(view.container)).toBeNull();
    const badge = [...view.container.querySelectorAll("span")].find(
      (span) => span.textContent === "Live",
    );
    expect(badge).toBeDefined();
    expect(badge?.hasAttribute("role")).toBe(false);
  } finally {
    await view.unmount();
  }
});
