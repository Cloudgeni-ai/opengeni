import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScheduledTask } from "@opengeni/react/app/types";

import { ownerName } from "./schedule-model";
import { OwnerValue } from "./schedule-parts";

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const KEY = "api_key:7dbccefa-3591-437a-81d2-6319352f124d";

function task(ownerSubjectId: string, label?: string): ScheduledTask {
  return {
    id: "schedule",
    ownerSubjectId,
    createdBy: { kind: "service", subjectId: ownerSubjectId, ...(label ? { label } : {}) },
  } as unknown as ScheduledTask;
}

describe("schedule owner", () => {
  test("an API key owner shows its name and a bot icon, never initials or its id", () => {
    const named = renderToStaticMarkup(
      <OwnerValue task={task(KEY, "Codex operator 2026-09-11")} viewerSubjectId="user:me" />,
    );
    expect(named).toContain("Codex operator 2026-09-11");
    expect(named).toContain("data-owner-api-key");
    expect(named).not.toContain(">CO<");

    expect(ownerName(task(KEY))).toBe("API key");
    const unnamed = renderToStaticMarkup(<OwnerValue task={task(KEY)} viewerSubjectId="user:me" />);
    expect(unnamed).not.toContain("7dbccefa");
    expect(unnamed).not.toContain(">?<");
  });

  test("a person owner keeps their initials", () => {
    const person = renderToStaticMarkup(
      <OwnerValue task={task("user:ada", "Ada Lovelace")} viewerSubjectId="user:me" />,
    );
    expect(person).toContain(">AL<");
    expect(person).not.toContain("data-owner-api-key");
  });
});
