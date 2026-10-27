import { afterEach, expect, test } from "bun:test";

import type { WorkspaceRecordingSettings } from "@opengeni/contracts";

import { createMeetingsFixture } from "../src/testing/meetings-fixture";
import { actRun, flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();
// Imported after the DOM exists: Radix decides at load whether layout effects run.
const { MeetingDefaultsView } = await import("../src/meetings/meeting-settings");

let rendered: RenderedComponent | null = null;
afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
});

async function render(settings: WorkspaceRecordingSettings, canManage = true) {
  const fixture = createMeetingsFixture();
  const saved: WorkspaceRecordingSettings[] = [];
  rendered = await renderComponent(
    <MeetingDefaultsView
      workspaceId={fixture.workspaceId}
      recordings={fixture.client}
      settings={settings}
      personal={false}
      canManage={canManage}
      viewer={{ subjectId: fixture.viewerSubjectId, name: "Ingrid Solberg" }}
      onSave={async (next) => {
        saved.push(next);
        return true;
      }}
    />,
  );
  await flush();
  const toggle = rendered.container.querySelector<HTMLButtonElement>(
    '[aria-label="Write notes after each meeting"]',
  );
  if (!toggle) throw new Error("No notes switch");
  return { toggle, saved };
}

test("meeting notes are written by default, and turning them off saves only false", async () => {
  const { toggle, saved } = await render({ defaultVisibility: "workspace" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(rendered?.container.textContent).toContain(
    "When a meeting's transcript is ready, an agent writes its notes",
  );
  await actRun(() => toggle.click());
  await flush();
  expect(saved).toEqual([{ defaultVisibility: "workspace", autoSummary: false }]);
});

test("turning meeting notes back on removes the setting", async () => {
  const { toggle, saved } = await render({ autoSummary: false, language: "no" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await actRun(() => toggle.click());
  await flush();
  expect(saved).toEqual([{ language: "no" }]);
});

test("only workspace admins can change it", async () => {
  const { toggle, saved } = await render({}, false);
  await actRun(() => toggle.click());
  await flush();
  expect(saved).toEqual([]);
});
