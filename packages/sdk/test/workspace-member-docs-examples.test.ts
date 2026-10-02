// Compile the member-inventory docs against the public SDK and exercise the
// existing REST-envelope unwrapping. No live service or membership mutations.
import { describe, expect, test } from "bun:test";

import { OpenGeniClient } from "../src/index";
import type { WorkspaceMember } from "../src/types";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const fixture: WorkspaceMember = {
  subjectId: "00000000-0000-4000-8000-000000000002",
  subjectLabel: "Example member",
  role: "member",
  permissions: ["workspace:read"],
  createdAt: "2026-10-02T00:00:00.000Z",
};

// Same read shape as the canonical client/setup and public SDK examples.
async function memberInventory(og: OpenGeniClient) {
  const members: WorkspaceMember[] = await og.listWorkspaceMembers(workspaceId);
  const count: number = members.length;
  return { members, count };
}

describe("workspace member docs examples", () => {
  for (const members of [[], [fixture]] satisfies WorkspaceMember[][]) {
    test(`SDK returns a direct array for a REST inventory of ${members.length} members`, async () => {
      const requests: Request[] = [];
      const client = new OpenGeniClient({
        baseUrl: "https://api.example.test",
        apiKey: "og_test_key",
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          return Response.json({ members }); // raw REST envelope stays unchanged
        },
      });
      const inventory = await memberInventory(client);
      expect(inventory.count).toBe(members.length);
      expect(inventory.members).toEqual(members);
      expect(Array.isArray(inventory.members)).toBe(true);
      expect(Reflect.get(inventory.members, "members")).toBeUndefined();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.method).toBe("GET");
      expect(new URL(requests[0]!.url).pathname).toBe(`/v1/workspaces/${workspaceId}/members`);
    });
  }
});
