import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import { GOOGLE_CALENDAR_REST_MCP_TOOLS } from "@opengeni/runtime";
import { applyGoogleConnectorSetupAvailability } from "@opengeni/core";
import {
  googleCalendarOAuthClientConfigured,
  startMcpOAuth,
} from "../src/integrations/oauth-client";
import {
  DEFAULT_OAUTH_PROFILE,
  OFFICIAL_GMAIL_MCP_URL,
  OFFICIAL_GOOGLE_CALENDAR_MCP_SCOPES,
  OFFICIAL_GOOGLE_CALENDAR_MCP_URL,
  assertAuthorizationServerNotReserved,
  builtInOAuthProfileFor,
} from "../src/integrations/oauth-profiles";

const profile = builtInOAuthProfileFor({ mcpUrl: OFFICIAL_GOOGLE_CALENDAR_MCP_URL })!;
const googleClient = JSON.stringify({
  "https://accounts.google.com": {
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    tokenEndpointAuthMethod: "client_secret_post",
  },
});
const noDatabase = new Proxy(
  {},
  {
    get() {
      throw new Error("Unexpected database access");
    },
  },
);
const start = (settings: ReturnType<typeof testSettings>) =>
  startMcpOAuth(
    { db: noDatabase, settings } as any,
    {
      accountId: "account",
      workspaceId: "workspace",
      subjectId: "human",
      personalOwnershipAllowed: true,
      requestUrl: "https://app.example.test",
      payload: { mcpUrl: OFFICIAL_GOOGLE_CALENDAR_MCP_URL, ownership: "personal" },
    } as any,
  );

describe("Google Calendar REST OAuth profile", () => {
  test("the exact identity is personal, uses pinned Google metadata and verifies the account", () => {
    expect(OFFICIAL_GOOGLE_CALENDAR_MCP_URL).toBe("https://calendarmcp.googleapis.com/mcp/v1");
    expect(profile.key).toBe("official-google-calendar");
    expect(profile.canonicalProviderDomain).toBe("calendarmcp.googleapis.com");
    expect(profile.providerOAuthDiscovery).toEqual({
      issuer: "https://accounts.google.com",
      metadataUrl: "https://accounts.google.com/.well-known/openid-configuration",
    });
    expect(profile.localToolVerification).toMatchObject({
      url: "https://www.googleapis.com/calendar/v3/users/me/calendarList/primary",
      method: "GET",
      required: true,
    });
    expect(profile.sendResourceParameter).toBe(false);
    expect(profile.defaultOwnership).toBe("personal");
    expect(profile.requiredOwnership?.ownership).toBe("personal");
    expect(profile.reportedScopesRequired).toBe(true);
    expect(profile.freshRefreshTokenRequired).toBe(true);
    expect(profile.fullRequestedScopesRequired).toBe(true);
    expect(profile.confidentialClientRequired).toBe(true);
    for (const mcpUrl of [
      `${OFFICIAL_GOOGLE_CALENDAR_MCP_URL}?other=1`,
      `${OFFICIAL_GOOGLE_CALENDAR_MCP_URL}/`,
      "https://other.example.test/mcp",
    ])
      expect(
        builtInOAuthProfileFor({ mcpUrl, providerDomain: "calendarmcp.googleapis.com" }),
      ).toBeNull();
  });

  test("consent asks for the narrow Calendar scopes only, without merging earlier Google grants", () => {
    expect([...OFFICIAL_GOOGLE_CALENDAR_MCP_SCOPES].sort()).toEqual([
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.freebusy",
    ]);
    expect(profile.requestedScopes).toEqual(OFFICIAL_GOOGLE_CALENDAR_MCP_SCOPES);
    expect(profile.extraAuthorizeParams).toEqual({ access_type: "offline", prompt: "consent" });
  });

  test("account verification keeps only the primary calendar's email", () => {
    expect(
      profile.localToolVerification!.validateIdentity({
        id: "person@example.test",
        summary: "Private title",
        timeZone: "Europe/Oslo",
      }),
    ).toEqual({ googleCalendarEmail: "person@example.test" });
    for (const payload of [{}, { id: "primary" }, { id: "a b@example.test" }])
      expect(() => profile.localToolVerification!.validateIdentity(payload)).toThrow();
  });

  test("verified tools follow the scopes Google actually granted", () => {
    const tools = (scopes: readonly string[]) =>
      profile.localToolVerification!.toolsForScopes(scopes, {}).map(({ name }) => name);
    expect(tools([])).toEqual([]);
    expect(tools(["https://www.googleapis.com/auth/gmail.readonly"])).toEqual([]);
    expect(tools(OFFICIAL_GOOGLE_CALENDAR_MCP_SCOPES)).toEqual(
      GOOGLE_CALENDAR_REST_MCP_TOOLS.map(({ name }) => name),
    );
    expect(tools(["https://www.googleapis.com/auth/calendar.events"])).toEqual([
      "list_events",
      "get_event",
      "create_event",
      "update_event",
      "delete_event",
    ]);
    expect(tools(["https://www.googleapis.com/auth/calendar.freebusy"])).toEqual([
      "find_free_busy",
    ]);
  });

  test("Google's authorization server is reserved for the reviewed Google profiles", () => {
    const google = {
      issuer: "https://accounts.google.com",
      authorizationServer: "https://accounts.google.com",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
    };
    expect(() => assertAuthorizationServerNotReserved(google, profile)).not.toThrow();
    expect(() => assertAuthorizationServerNotReserved(google, DEFAULT_OAUTH_PROFILE)).toThrow(
      OFFICIAL_GOOGLE_CALENDAR_MCP_URL,
    );
    expect(() => assertAuthorizationServerNotReserved(google, DEFAULT_OAUTH_PROFILE)).toThrow(
      OFFICIAL_GMAIL_MCP_URL,
    );
  });

  test("setup stays off until the deployment enables Calendar on its Google client", async () => {
    expect(
      googleCalendarOAuthClientConfigured(
        testSettings({ integrationsOauthClientsJson: googleClient }),
      ),
    ).toBe(false);
    expect(
      googleCalendarOAuthClientConfigured(
        testSettings({ integrationsOauthClientsJson: googleClient, googleCalendarEnabled: true }),
      ),
    ).toBe(true);
    expect(googleCalendarOAuthClientConfigured(testSettings({ googleCalendarEnabled: true }))).toBe(
      false,
    );
    await expect(start(testSettings({ integrationsEnabled: true }))).rejects.toThrow(
      "Calendar scopes",
    );
    await expect(
      start(
        testSettings({
          integrationsEnabled: true,
          googleCalendarEnabled: true,
          googleConnectorSetupEnabled: false,
        }),
      ),
    ).rejects.toThrow("temporarily unavailable");
  });

  test("the catalog withholds setup readiness until Calendar is enabled", () => {
    const item = {
      kind: "mcp",
      mcpUrl: OFFICIAL_GOOGLE_CALENDAR_MCP_URL,
      enabled: true,
      runtime: { available: true },
    } as any;
    const gated = applyGoogleConnectorSetupAvailability(item, testSettings());
    expect(gated.enabled).toBe(true);
    expect(gated.runtime?.operatorOAuthClient?.configured).toBe(false);
    expect(
      applyGoogleConnectorSetupAvailability(item, testSettings({ googleCalendarEnabled: true })),
    ).toBe(item);
  });
});
