import { ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE } from "@opengeni/contracts/managed-sign-in-methods";
import { Button } from "@opengeni/react/ui/button";
import { Section } from "@opengeni/react/ui/section";
import { SettingRow, SettingRowGroup } from "@opengeni/react/ui/setting-row";
import { useState } from "react";

import { AdminStepUpDialog } from "@/components/admin-step-up-dialog";
import { withAdminStepUp } from "@/lib/admin-step-up";
import { KitSection, KitCanvas } from "../kit";

/*
 * DEV only. The production step-up prompt and the console's resend path.
 * Sample data stands in for the API: the first save is refused the way the
 * API refuses an admin change, and "Use passkey" waits a moment instead of a
 * real passkey ceremony.
 */

function refusal(passkeyRegistered: boolean): Response {
  return Response.json(
    {
      error: {
        code: "forbidden",
        message: "Confirm it's you with your passkey to change admin settings.",
        details: { code: ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE, passkeyRegistered },
      },
    },
    { status: 403 },
  );
}

function SampleAdminChange({ passkeyRegistered }: { passkeyRegistered: boolean }) {
  const [name, setName] = useState("Northwind");
  const [status, setStatus] = useState<string | null>(null);
  const save = async () => {
    let sends = 0;
    const response = await withAdminStepUp(
      async () => {
        sends += 1;
        return sends === 1 ? refusal(passkeyRegistered) : Response.json({ ok: true });
      },
      { input: "/v1/organizations/sample", init: { method: "PATCH", body: "{}" } },
    );
    if (response.ok) {
      setName((current) => (current === "Northwind" ? "Northwind Labs" : "Northwind"));
      setStatus("Saved");
    } else {
      setStatus("Not saved");
    }
  };
  return (
    <SettingRow
      label="Organization name"
      description={`${name}${status ? ` · ${status}` : ""}`}
      control={
        <Button variant="secondary" size="sm" onClick={() => void save()}>
          {passkeyRegistered ? "Rename" : "Rename (no passkey yet)"}
        </Button>
      }
    />
  );
}

export default function AdminStepUpSection() {
  return (
    <KitSection sectionKey="page-admin-step-up">
      <KitCanvas>
        <Section title="General">
          <SettingRowGroup>
            <SampleAdminChange passkeyRegistered />
            <SampleAdminChange passkeyRegistered={false} />
          </SettingRowGroup>
        </Section>
      </KitCanvas>
      <AdminStepUpDialog confirm={() => new Promise((resolve) => setTimeout(resolve, 900))} />
    </KitSection>
  );
}
