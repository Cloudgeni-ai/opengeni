import { createRoot } from "react-dom/client";
import type { Session } from "@opengeni/sdk";
import { SessionAdmissionNotice } from "../src/components/session/session-admission-notice";
import "../src/styles.css";

const reasons = [
  "database_claim_rejected",
  "initiator_membership_required",
  "personal_resource_grant_required",
];

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto grid max-w-3xl gap-4 p-6">
    <h1>Session admission checks</h1>
    {reasons.map((reason) => (
      <SessionAdmissionNotice
        key={reason}
        session={{ status: "requires_action", admissionBlock: { reason } } as unknown as Session}
        canControl
        paused={false}
        busy={false}
        onRecheck={async () => {
          throw new Error("private server detail");
        }}
      />
    ))}
  </main>,
);
