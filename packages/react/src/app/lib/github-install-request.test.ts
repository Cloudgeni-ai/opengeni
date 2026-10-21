import { describe, expect, test } from "bun:test";
import {
  GITHUB_INSTALL_REQUEST_TTL_MS,
  clearGitHubInstallRequest,
  readGitHubInstallRequest,
  recordGitHubInstallRequest,
} from "./github-install-request";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

describe("GitHub install request hint", () => {
  test("records per workspace and clears once connected", () => {
    const storage = memoryStorage();
    recordGitHubInstallRequest("ws-a", { storage, now: 1_000 });
    expect(readGitHubInstallRequest("ws-a", { storage, now: 2_000 })).toBe(1_000);
    expect(readGitHubInstallRequest("ws-b", { storage, now: 2_000 })).toBeNull();
    clearGitHubInstallRequest("ws-a", { storage, now: 2_000 });
    expect(readGitHubInstallRequest("ws-a", { storage, now: 2_000 })).toBeNull();
  });

  test("expires quietly and ignores malformed or future entries", () => {
    const storage = memoryStorage();
    recordGitHubInstallRequest("ws-a", { storage, now: 1_000 });
    expect(
      readGitHubInstallRequest("ws-a", {
        storage,
        now: 1_000 + GITHUB_INSTALL_REQUEST_TTL_MS,
      }),
    ).toBeNull();
    storage.setItem(
      "opengeni.githubInstallRequests.v1",
      JSON.stringify({ "ws-a": "soon", "ws-b": 9_999_999 }),
    );
    expect(readGitHubInstallRequest("ws-a", { storage, now: 5_000 })).toBeNull();
    expect(readGitHubInstallRequest("ws-b", { storage, now: 5_000 })).toBeNull();
    storage.setItem("opengeni.githubInstallRequests.v1", "not json");
    expect(readGitHubInstallRequest("ws-a", { storage, now: 5_000 })).toBeNull();
  });

  test("works without storage", () => {
    recordGitHubInstallRequest("ws-a", { storage: null });
    expect(readGitHubInstallRequest("ws-a", { storage: null })).toBeNull();
  });
});
