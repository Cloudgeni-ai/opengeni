import { describe, expect, test } from "bun:test";

import { OpenGeniCoreClient } from "../src/core";
import {
  previewOrganizationUserSetup,
  retryOrganizationUserSetupDelivery,
} from "../src/organization-user-setup";

describe("organization user setup SDK", () => {
  test("keeps preview and retry behind their optional entry", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const client = new OpenGeniCoreClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json(
          request.url.endsWith("/preview")
            ? { state: "unavailable" }
            : {
                id: "delivery-1",
                state: "sent",
                attemptCount: 2,
                revision: 3,
                errorClass: null,
                sentAt: "2026-08-25T00:00:00.000Z",
                updatedAt: "2026-08-25T00:00:00.000Z",
              },
        );
      },
    });

    expect(await previewOrganizationUserSetup(client, { token: "setup-token" })).toEqual({
      state: "unavailable",
    });
    expect(
      await retryOrganizationUserSetupDelivery(client, "organization-1", "invitation-1", {
        operationId: "operation-1",
      }),
    ).toMatchObject({ state: "sent", attemptCount: 2 });
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/auth/organization-setup/preview",
        body: { token: "setup-token" },
      },
      {
        method: "POST",
        path: "/v1/organizations/organization-1/invitations/invitation-1/delivery/retry",
        body: { operationId: "operation-1" },
      },
    ]);
  });
});
