import { describe, expect, test } from "bun:test";
import {
  meetingSharingDecision,
  meetingSharingTargets,
  type MeetingSharingMeeting,
  type MeetingSharingWorkspace,
} from "../src/meeting-sharing";

const personal = "p";
const sales = "s";
const design = "d";
const workspaces: MeetingSharingWorkspace[] = [
  { id: personal, personal: true },
  { id: sales, shareable: true },
  { id: design, shareable: false },
];
const meeting = (input: Partial<MeetingSharingMeeting> = {}): MeetingSharingMeeting => ({
  workspaceId: sales,
  visibility: "private",
  sharedWorkspaceId: null,
  reachWorkspaceIds: [],
  ...input,
});
const decide = (
  target: string | null,
  recording: MeetingSharingMeeting,
  viewingWorkspaceId: string,
  known: readonly MeetingSharingWorkspace[] | undefined = workspaces,
) => meetingSharingDecision({ target, meeting: recording, viewingWorkspaceId, workspaces: known });

describe("meetingSharingTargets", () => {
  test("a team workspace's meeting is shared only there", () => {
    expect(meetingSharingTargets(meeting(), workspaces)).toEqual({
      targets: [sales],
      current: null,
      personal: false,
    });
    expect(meetingSharingTargets(meeting({ visibility: "workspace" }), workspaces).current).toBe(
      sales,
    );
  });

  test("a Personal-workspace meeting lists the team workspaces where the person may start work", () => {
    const stored = meeting({ workspaceId: personal });
    expect(meetingSharingTargets(stored, workspaces).targets).toEqual([sales]);
    // Where it is shared stays listed.
    expect(
      meetingSharingTargets(
        { ...stored, visibility: "workspace", sharedWorkspaceId: design },
        workspaces,
      ),
    ).toEqual({ targets: [sales, design], current: design, personal: true });
    // Shared in the Personal workspace itself, nobody else sees it.
    expect(meetingSharingTargets({ ...stored, visibility: "workspace" }, workspaces).current).toBe(
      null,
    );
  });
});

describe("meetingSharingDecision", () => {
  test("Only me", () => {
    expect(decide(null, meeting({ visibility: "workspace" }), sales)).toEqual({
      ok: true,
      request: { visibility: "private" },
      leavesHere: false,
    });
  });

  test("Only me from another team workspace keeps it working there", () => {
    expect(decide(null, meeting({ workspaceId: personal, reachWorkspaceIds: [] }), sales)).toEqual({
      ok: true,
      request: { visibility: "private", reachWorkspaceIds: [sales] },
      leavesHere: false,
    });
    // Already there, everywhere, or viewed from the Personal workspace: nothing to keep.
    for (const reachWorkspaceIds of [[sales], null]) {
      expect(
        decide(null, meeting({ workspaceId: personal, reachWorkspaceIds }), sales),
      ).toMatchObject({ request: { visibility: "private" } });
    }
    expect(decide(null, meeting({ workspaceId: sales }), personal)).toMatchObject({
      request: { visibility: "private" },
    });
  });

  test("shared with the team workspace that stores it", () => {
    expect(decide(sales, meeting(), sales)).toEqual({
      ok: true,
      request: { visibility: "workspace" },
      leavesHere: false,
    });
  });

  test("a Personal-workspace meeting is shared with a team workspace by naming it", () => {
    const stored = meeting({ workspaceId: personal });
    expect(decide(sales, stored, sales)).toEqual({
      ok: true,
      request: { visibility: "workspace", sharedWorkspaceId: sales },
      leavesHere: false,
    });
    // From the Personal workspace, it then shows there and still here.
    expect(decide(sales, stored, personal)).toMatchObject({ ok: true, leavesHere: false });
    expect(decide(sales, stored, design)).toMatchObject({ ok: true, leavesHere: true });
  });

  test("refusals", () => {
    const stored = meeting({ workspaceId: personal });
    expect(decide(design, stored, design)).toEqual({ ok: false, code: "not_allowed" });
    expect(decide("elsewhere", stored, "elsewhere")).toEqual({ ok: false, code: "not_allowed" });
    expect(decide(personal, stored, personal)).toEqual({
      ok: false,
      code: "not_shareable",
      because: "personal_workspace",
    });
    // A team workspace's meeting can't be shared with another workspace.
    expect(decide(design, meeting(), design)).toEqual({
      ok: false,
      code: "not_shareable",
      because: "other_workspace",
    });
    expect(decide(personal, meeting(), personal)).toMatchObject({ because: "other_workspace" });
  });

  test("without the person's workspaces, only the storing workspace is offered", () => {
    expect(decide(sales, meeting(), sales, undefined)).toMatchObject({
      ok: true,
      request: { visibility: "workspace" },
    });
    expect(decide(sales, meeting(), design, undefined)).toEqual({
      ok: true,
      request: { visibility: "workspace", sharedWorkspaceId: sales },
      leavesHere: true,
    });
  });
});
