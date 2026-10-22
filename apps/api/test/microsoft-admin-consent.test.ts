import { describe, expect, test } from "bun:test";
import { MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION } from "@opengeni/capabilities";
import {
  MICROSOFT_ADMIN_CONSENT_STATE,
  microsoftAdminConsentResultPage,
  microsoftAdminConsentUrl,
  microsoftAuthorizationNotGranted,
} from "../src/integrations/microsoft-admin-consent";

const callback = "https://app.example.com/v1/integrations/provider-oauth/callback";

describe("Microsoft admin consent", () => {
  test("builds an organization approval link for the definition's Graph permissions", () => {
    const url = new URL(
      microsoftAdminConsentUrl({
        clientId: "client-1",
        redirectUri: callback,
        definition: MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION,
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/organizations/v2.0/adminconsent",
    );
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(callback);
    expect(url.searchParams.get("state")).toBe(MICROSOFT_ADMIN_CONSENT_STATE);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "https://graph.microsoft.com/User.Read",
      "https://graph.microsoft.com/Mail.ReadWrite",
      "https://graph.microsoft.com/Mail.Send",
      "https://graph.microsoft.com/MailboxSettings.ReadWrite",
    ]);
  });

  test("names admin approval when Microsoft says only an administrator can grant access", () => {
    const link = "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=x";
    for (const description of [
      "AADSTS90094: The grant requires admin permission.",
      "AADSTS65001: The user or administrator has not consented to use the application.",
    ]) {
      const denial = microsoftAuthorizationNotGranted({
        error: "access_denied",
        description,
        adminConsentUrl: link,
      });
      expect(denial.state).toBe("failed");
      expect(denial.error.code).toBe("admin_consent_required");
      expect(denial.error.message).toContain(link);
      expect(denial.error.retryable).toBe(true);
    }
  });

  test("a plain decline stays cancelled but still offers the approval link", () => {
    const link = "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=x";
    const denial = microsoftAuthorizationNotGranted({
      error: "access_denied",
      description: "AADSTS65004: User declined to consent to access the app.",
      adminConsentUrl: link,
    });
    expect(denial.state).toBe("cancelled");
    expect(denial.error.code).toBe("provider_denied");
    expect(denial.error.message).toContain(link);
  });

  test("the administrator's result page reports approval without echoing provider text", async () => {
    const granted = microsoftAdminConsentResultPage({ adminConsent: "True" });
    expect(granted.status).toBe(200);
    expect(await granted.text()).toContain("Approved");
    const denied = microsoftAdminConsentResultPage({ error: "<script>access_denied</script>" });
    expect(denied.status).toBe(400);
    const body = await denied.text();
    expect(body).toContain("Not approved");
    expect(body).not.toContain("<script>");
  });
});
