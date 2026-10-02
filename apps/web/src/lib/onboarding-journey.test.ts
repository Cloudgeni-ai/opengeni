import { beforeEach, describe, expect, test } from "bun:test";

import {
  intentAnalyticsProperties,
  markOnboarding,
  newOnboardingJourney,
  normalizeIntents,
  onboardingJourneyStorageKey,
  parseOnboardingJourney,
  primaryIntent,
  readOnboardingJourney,
  resetOnboardingJourneysForTests,
  sameIntents,
  updateOnboardingJourney,
  writeOnboardingJourney,
} from "./onboarding-journey";

function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

beforeEach(() => resetOnboardingJourneysForTests());

describe("onboarding journey storage", () => {
  test("is keyed by the signed-in subject and the organization", () => {
    expect(onboardingJourneyStorageKey("user:ada", "org-1")).toBe(
      "og.get-started:v1:user%3Aada:org-1",
    );
    expect(onboardingJourneyStorageKey("user:ada", "org-1")).not.toBe(
      onboardingJourneyStorageKey("user:ada", "org-2"),
    );
  });

  test("persists the chosen path, dismissal and marks across reads", () => {
    const storage = memoryStorage();
    const key = onboardingJourneyStorageKey("user:ada", "org-1");
    writeOnboardingJourney(
      key,
      newOnboardingJourney({ intents: ["build"], developmentWorkspaceId: "ws-dev" }),
      storage,
    );
    updateOnboardingJourney(key, (current) => ({ ...current, checklistDismissed: true }), storage);
    markOnboarding(key, "playground", new Date("2026-10-01T08:00:00.000Z"), storage);
    resetOnboardingJourneysForTests();
    expect(readOnboardingJourney(key, storage)).toMatchObject({
      intents: ["build"],
      developmentWorkspaceId: "ws-dev",
      checklistDismissed: true,
      marks: { playground: "2026-10-01T08:00:00.000Z" },
    });
  });

  test("a mark never starts a journey, and the first mark wins", () => {
    const storage = memoryStorage();
    const key = onboardingJourneyStorageKey("user:ada", "org-1");
    markOnboarding(key, "coding_agent", new Date(), storage);
    expect(readOnboardingJourney(key, storage)).toBeNull();
    writeOnboardingJourney(key, newOnboardingJourney({ intents: ["cloud"] }), storage);
    markOnboarding(key, "first_task", new Date("2026-10-01T08:00:00.000Z"), storage);
    markOnboarding(key, "first_task", new Date("2026-10-02T08:00:00.000Z"), storage);
    expect(readOnboardingJourney(key, storage)!.marks.first_task).toBe("2026-10-01T08:00:00.000Z");
  });

  test("drops anything that isn't exactly the stored shape", () => {
    expect(parseOnboardingJourney(null)).toBeNull();
    expect(parseOnboardingJourney("{not json")).toBeNull();
    expect(parseOnboardingJourney(JSON.stringify({ version: 2, intent: "build" }))).toBeNull();
    expect(
      parseOnboardingJourney(
        JSON.stringify({
          version: 1,
          intent: "hack",
          invited: "yes",
          developmentWorkspaceId: 7,
          marks: { playground: "2026-10-01", unknown: "x", api_key: 5 },
        }),
      ),
    ).toMatchObject({
      intents: [],
      invited: false,
      developmentWorkspaceId: null,
      marks: { playground: "2026-10-01" },
    });
  });

  test("Build and cloud combine; looking around stands alone", () => {
    expect(normalizeIntents(["cloud", "build"])).toEqual(["build", "cloud"]);
    expect(normalizeIntents(["explore", "cloud"])).toEqual(["cloud"]);
    expect(normalizeIntents(["explore", "explore"])).toEqual(["explore"]);
    expect(normalizeIntents(["hack", 7])).toEqual([]);
    expect(primaryIntent(["build", "cloud"])).toBe("build");
    expect(primaryIntent([])).toBeNull();
    expect(sameIntents(["cloud", "build"], ["build", "cloud"])).toBe(true);
    expect(sameIntents(["build"], ["build", "cloud"])).toBe(false);
    expect(intentAnalyticsProperties(["cloud", "build"])).toEqual({
      intent: "build",
      intents: "build,cloud",
      build: true,
      cloud: true,
      explore: false,
    });
    // A journey saved by an earlier build with one `intent` still reads.
    expect(
      parseOnboardingJourney(JSON.stringify({ version: 1, intent: "cloud" }))!.intents,
    ).toEqual(["cloud"]);
    expect(
      parseOnboardingJourney(JSON.stringify({ version: 1, intents: ["explore", "build"] }))!
        .intents,
    ).toEqual(["build"]);
  });

  test("keeps working when storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    const key = onboardingJourneyStorageKey("user:ada", "org-1");
    expect(readOnboardingJourney(key, blocked)).toBeNull();
    writeOnboardingJourney(key, newOnboardingJourney({ intents: ["explore"] }), blocked);
    // This page view still remembers it.
    expect(readOnboardingJourney(key, blocked)!.intents).toEqual(["explore"]);
  });
});
