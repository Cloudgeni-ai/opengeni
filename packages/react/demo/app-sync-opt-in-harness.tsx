// App sync opt-in preview: the console's real join card (personal syncs the
// viewer hasn't joined) and the platform-owned opt-in confirmation an app
// asks for with site.data.syncs.optIn(id). Data is synthetic.
//   ?view=card|dialog   ?accounts=1|2   ?theme=light|dark
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppSyncOptInReview } from "@opengeni/sdk";
import {
  AppSyncJoinCardView,
  AppSyncOptInDialogView,
} from "@opengeni/react/app/lib/app-sync-opt-in";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const dark = params.get("theme") === "dark";
const view = params.get("view") === "dialog" ? "dialog" : "card";
const twoAccounts = params.get("accounts") !== "1";

const REVIEW: AppSyncOptInReview = {
  syncId: "8c1e2f3a-4b5d-4e6f-8a7b-9c0d1e2f3a4b",
  name: "My calendar",
  mode: "personal",
  collection: "events",
  tool: { toolName: "list_events", connector: "Google Calendar" },
  accounts: [
    { id: "srv-1", label: "kari@example.com", connector: "Google Calendar", shared: false },
    ...(twoAccounts
      ? [{ id: "srv-2", label: "kari@work.example", connector: "Google Calendar", shared: false }]
      : []),
  ],
  account: null,
  optedIn: false,
  blocked: null,
};

function Preview() {
  const [account, setAccount] = useState<string | null>("srv-1");
  useEffect(() => {
    document.documentElement.setAttribute("data-og-theme", dark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", dark);
  }, []);
  return (
    <div className="relative h-screen bg-bg text-fg">
      {/* Placed as the site view places it: bottom right, over the app. */}
      <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex flex-col items-end gap-2">
        <AppSyncJoinCardView
          syncs={[
            { id: REVIEW.syncId, name: "My calendar" },
            { id: "9d2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b", name: "My tasks" },
          ]}
          onJoin={() => {}}
          onDismiss={() => {}}
        />
      </div>
      <AppSyncOptInDialogView
        review={REVIEW}
        open={view === "dialog"}
        account={account}
        error={null}
        onAccountChange={setAccount}
        onOpenChange={() => {}}
        onConfirm={async () => true}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
