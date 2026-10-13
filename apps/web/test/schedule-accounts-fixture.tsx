import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ScheduleAccounts,
  scheduleAccountsDescription,
} from "../src/components/schedules/schedule-accounts";
import { DetailPageBody } from "../src/components/ui/detail-page";
import {
  DetailFact,
  DetailFacts,
  DetailPage,
  DetailSection,
} from "../src/components/ui/detail-sheet";
import type { ScheduledTaskAccountPlan } from "../src/types";
import "../src/styles.css";

const pinned: ScheduledTaskAccountPlan = {
  connectors: [
    {
      id: "slack",
      name: "Slack",
      mode: "default",
      accounts: [
        {
          connectionId: "33333333-3333-4333-8333-333333333333",
          label: "ana.lindqvist@example.com · Only me",
          scope: "personal",
        },
        {
          connectionId: "44444444-4444-4444-8444-444444444444",
          label: "Example Team workspace · This workspace",
          scope: "shared",
        },
      ],
      unavailablePins: [],
    },
    {
      id: "gmail",
      name: "Gmail",
      mode: "pinned",
      accounts: [],
      unavailablePins: [{ connectionId: "22222222-2222-4222-8222-222222222222" }],
    },
    {
      id: "billing",
      name: "Billing mailbox",
      mode: "pinned",
      accounts: [
        {
          connectionId: "11111111-1111-4111-8111-111111111111",
          label: "billing@example.com · This workspace",
          scope: "shared",
        },
      ],
      unavailablePins: [],
    },
    { id: "notion", name: "Notion", mode: "default", accounts: [], unavailablePins: [] },
  ],
};

function Fixture() {
  const params = new URLSearchParams(window.location.search);
  const chat = params.has("chat");
  const [plan, setPlan] = useState<ScheduledTaskAccountPlan>(
    chat
      ? { connectors: pinned.connectors.filter((connector) => connector.mode === "default") }
      : pinned,
  );
  const runMode = chat ? "existing_session" : "new_session_per_run";
  return (
    <DetailPage>
      <DetailPageBody>
        <DetailSection title="Setup">
          <DetailFacts>
            <DetailFact label="Each run">
              {chat ? "Posts into an existing chat" : "New chat each run"}
            </DetailFact>
          </DetailFacts>
        </DetailSection>
        <DetailSection
          title="Accounts"
          description={scheduleAccountsDescription({ runMode }, plan)}
        >
          <ScheduleAccounts
            plan={plan}
            skipsRuns={params.has("skips")}
            canEdit={!params.has("readonly")}
            busy={false}
            onUseCurrentAccounts={(id) =>
              setPlan((current) => ({
                connectors: current.connectors.map((connector) =>
                  connector.id === id
                    ? { ...connector, mode: "default", unavailablePins: [] }
                    : connector,
                ),
              }))
            }
          />
        </DetailSection>
      </DetailPageBody>
    </DetailPage>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
