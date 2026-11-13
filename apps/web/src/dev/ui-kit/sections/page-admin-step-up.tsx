import { ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE } from "@opengeni/contracts/managed-sign-in-methods";
import { Button } from "@opengeni/react/ui/button";
import { Section } from "@opengeni/react/ui/section";
import { SettingRow, SettingRowGroup } from "@opengeni/react/ui/setting-row";
import { Switch } from "@opengeni/react/ui/switch";
import { useState } from "react";

import { AdminStepUpDialog, type StepUpHandoffApi } from "@/components/admin-step-up-dialog";
import { withAdminStepUp } from "@/lib/admin-step-up";
import { ConfirmPasskeyRoute } from "@/routes/confirm-passkey";
import { KitSection, KitCanvas } from "../kit";

/*
 * DEV only. The production step-up prompt and the console's resend path.
 * Sample data stands in for the API: the first save is refused the way the
 * API refuses an admin change, and "Use passkey" waits a moment instead of a
 * real passkey ceremony. "In the desktop app" shows the browser handoff: the
 * sample browser page below shows code 482913, which confirms the app.
 */

const SAMPLE_CODE = "482913";

function sampleHandoff(): StepUpHandoffApi {
  return {
    start: async () => ({
      handoffId: "8f0c3c4e-2f6d-4a8a-9d43-1d8f0e3c6b21",
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      expiresInSeconds: 600,
    }),
    claim: async (_handoffId, code) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (code !== SAMPLE_CODE) throw new Error("That code isn't right.");
    },
    open: () => {},
  };
}

function refusal(passkeyRegistered: boolean): Response {
  return Response.json(
    {
      error: {
        code: "forbidden",
        message: "Confirm it's you with your passkey to change who has access.",
        details: { code: ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE, passkeyRegistered },
      },
    },
    { status: 403 },
  );
}

function SampleAdminChange({ passkeyRegistered }: { passkeyRegistered: boolean }) {
  const [role, setRole] = useState("Member");
  const [status, setStatus] = useState<string | null>(null);
  const save = async () => {
    let sends = 0;
    const response = await withAdminStepUp(
      async () => {
        sends += 1;
        return sends === 1 ? refusal(passkeyRegistered) : Response.json({ ok: true });
      },
      { input: "/v1/organizations/sample/members/sample", init: { method: "PATCH", body: "{}" } },
    );
    if (response.ok) {
      setRole((current) => (current === "Member" ? "Admin" : "Member"));
      setStatus("Saved");
    } else {
      setStatus("Not saved");
    }
  };
  return (
    <SettingRow
      label={passkeyRegistered ? "Ada Lovelace" : "Grace Hopper (no passkey yet)"}
      description={`${role}${status ? ` · ${status}` : ""}`}
      control={
        <Button variant="secondary" size="sm" onClick={() => void save()}>
          Change role
        </Button>
      }
    />
  );
}

export default function AdminStepUpSection() {
  const [desktop, setDesktop] = useState(false);
  const [handoff] = useState(sampleHandoff);
  return (
    <KitSection sectionKey="page-admin-step-up">
      <KitCanvas>
        <Section title="Members">
          <SettingRowGroup>
            <SettingRow
              label="In the desktop app"
              description="Passkeys open in the person's browser on the same server."
              control={
                <Switch
                  checked={desktop}
                  onCheckedChange={setDesktop}
                  aria-label="In the desktop app"
                />
              }
            />
            <SampleAdminChange passkeyRegistered />
            <SampleAdminChange passkeyRegistered={false} />
          </SettingRowGroup>
        </Section>
      </KitCanvas>
      <AdminStepUpDialog
        key={desktop ? "desktop" : "browser"}
        inBrowser={desktop}
        handoff={handoff}
        confirm={() => new Promise((resolve) => setTimeout(resolve, 900))}
      />
      <KitCanvas>
        <div className="flex min-h-80">
          <ConfirmPasskeyRoute
            handoff="8f0c3c4e-2f6d-4a8a-9d43-1d8f0e3c6b21"
            api={{
              confirm: () => new Promise((resolve) => setTimeout(() => resolve(SAMPLE_CODE), 900)),
              confirmSession: () => new Promise((resolve) => setTimeout(resolve, 900)),
            }}
          />
        </div>
      </KitCanvas>
    </KitSection>
  );
}
