import type { SecretUseGrant, VaultItemApproval, VaultsApi } from "@opengeni/react";
import { HumanInputForm } from "@opengeni/react/session-ui";
import { secretUseApprovalHumanInput } from "@opengeni/contracts";

import { ItemApprovalSection } from "@/components/secrets/item-approval";
import { KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";

/* ----------------------------------------------------------------------------
   "Ask before each use" on an item's page, and the card the person answers,
   rendered by the real components. Only the vault API is an in-memory fake.
   -------------------------------------------------------------------------- */

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const FIELDS = [
  { name: "username", label: "Username" },
  { name: "password", label: "Password" },
  { name: "totp", label: "One-time code" },
];

const inAnHour = () => new Date(Date.now() + 47 * 60 * 1000).toISOString();

const GRANTS: SecretUseGrant[] = [
  {
    id: "grant-chat",
    scope: "session",
    sessionId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    fields: ["password"],
    surface: "browser",
    toolName: "browser_act",
    destination: "github.com",
    decidedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
    decidedBySubjectId: "user:kit",
    expiresAt: null,
  },
  {
    id: "grant-hour",
    scope: "window",
    sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    fields: ["password", "totp"],
    surface: "shell",
    toolName: "exec_command",
    destination: null,
    decidedAt: new Date(Date.now() - 13 * 60 * 1000).toISOString(),
    decidedBySubjectId: "user:kit",
    expiresAt: inAnHour(),
  },
];

type FakeMode = "ok" | "loading" | "load-error" | "save-error";

/** An in-memory stand-in for the three approval routes of the vault API. */
function fakeApi(initial: VaultItemApproval, mode: FakeMode = "ok"): VaultsApi {
  let state = initial;
  const api = {
    getItemApproval: async () => {
      if (mode === "loading") return await new Promise<VaultItemApproval>(() => {});
      await wait(300);
      if (mode === "load-error") throw new Error("Couldn't reach the server.");
      return state;
    },
    setItemApproval: async (
      _vaultId: string,
      _itemId: string,
      next: { item: boolean; fields: string[] },
    ) => {
      await wait(700);
      if (mode === "save-error") throw new Error("Couldn't save the change. Try again.");
      state = { ...state, item: next.item, fields: [...next.fields].sort() };
      return state;
    },
    revokeItemGrant: async (_vaultId: string, _itemId: string, grantId: string) => {
      await wait(500);
      state = { ...state, grants: state.grants.filter((grant) => grant.id !== grantId) };
      return state;
    },
  };
  return api as unknown as VaultsApi;
}

function Approval({
  approval,
  mode,
  archived = false,
}: {
  approval: VaultItemApproval;
  mode?: FakeMode;
  archived?: boolean;
}) {
  return (
    <ItemApprovalSection
      api={fakeApi(approval, mode)}
      vaultId="kit-vault"
      itemId="kit-item"
      workspaceId="kit-workspace"
      fields={FIELDS}
      archived={archived}
    />
  );
}

const card = secretUseApprovalHumanInput({
  id: "16fd2706-8baf-433b-82eb-8c7fada847da",
  targets: [
    {
      vaultId: "kit-vault",
      itemId: "kit-item",
      fieldKey: "password",
      vaultName: "Only me",
      itemName: "GitHub",
      fieldName: "password",
    },
  ],
  surface: "browser",
  toolName: "browser_act",
  destination: "github.com",
});

export default function SecretApprovalSection() {
  const base: VaultItemApproval = { item: false, fields: [], grants: [], canChange: true };
  return (
    <KitSection sectionKey="secret-approval">
      <StatesGrid
        title="Item page"
        description="Marks are saved as they are switched; a failed save switches back and says why."
        columns={2}
      >
        <StateCell label="Password marked, approvals in force" align="stretch">
          <Approval approval={{ ...base, fields: ["password"], grants: GRANTS }} />
        </StateCell>
        <StateCell label="Nothing marked" align="stretch">
          <Approval approval={base} />
        </StateCell>
        <StateCell label="Every field" align="stretch">
          <Approval approval={{ ...base, item: true }} />
        </StateCell>
        <StateCell
          label="Can't change"
          align="stretch"
          note="People without secrets:write see the marks and approvals only."
        >
          <Approval
            approval={{ ...base, fields: ["password"], grants: GRANTS, canChange: false }}
          />
        </StateCell>
        <StateCell label="Archived item" align="stretch">
          <Approval approval={{ ...base, fields: ["password"] }} archived />
        </StateCell>
        <StateCell label="Save fails" align="stretch" note="Switch a field to see it switch back.">
          <Approval approval={base} mode="save-error" />
        </StateCell>
        <StateCell label="Loading" align="stretch">
          <Approval approval={base} mode="loading" />
        </StateCell>
        <StateCell label="Couldn't load" align="stretch">
          <Approval approval={base} mode="load-error" />
        </StateCell>
      </StatesGrid>
      <StatesGrid
        title="Approval card"
        description="The host writes this card from the stored request; agents can't change its text. No Other answer, no Skip."
        columns={2}
      >
        <StateCell label="In the chat" align="stretch">
          <HumanInputForm
            request={{
              id: "kit-approval",
              questions: card.questions.map((question) => ({
                ...question,
                label: question.label ?? undefined,
                helpText: question.helpText ?? undefined,
                options: question.options.map((option) => ({
                  id: option.id,
                  label: option.label,
                  ...(option.description ? { description: option.description } : {}),
                })),
              })),
              allowSkip: false,
              expiresAt: null,
            }}
            autoFocus={false}
            onSubmit={async () => {
              await wait(900);
            }}
          />
        </StateCell>
      </StatesGrid>
      <UsageNotes
        use={[
          "A value an agent should only use when the person says so each time, like a bank login or a production key.",
          "One field of an item, like the password but not the username.",
        ]}
        avoid={["Hiding an item from agents altogether: use the vault's access settings."]}
      />
    </KitSection>
  );
}
