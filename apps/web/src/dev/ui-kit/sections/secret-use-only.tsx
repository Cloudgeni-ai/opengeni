import type { VaultItem, VaultsApi } from "@opengeni/react";

import { ItemEditorPage } from "@/components/secrets/item-editor";
import { ItemPage, type ItemPageActions } from "@/components/secrets/item-page";
import { buildMockState, type MockItem } from "@/dev/secrets-mock/fixtures";
import { KitSection, PagePreview, StateCell, StatesGrid, UsageNotes } from "../kit";

/* ----------------------------------------------------------------------------
   Who can see a value: an item's page for someone who may see it, for someone
   who may only use it, and for a use-only item; and the editor's one switch.
   The real item page and editor; only the vault API is an in-memory fake.
   -------------------------------------------------------------------------- */

const state = buildMockState("kit-workspace");
const shared = state.vaults.find((vault) => vault.name === "Shared")!;
const mock = state.items.find((item) => item.vaultId === shared.id && item.name === "Staging DB")!;

function asItem(item: MockItem, extra: Partial<VaultItem>): VaultItem {
  return {
    ...item,
    fields: item.fields.map(({ versions: _versions, ...field }) => field),
    ...extra,
  };
}

const api = {
  revealField: async () => ({ value: "fake-st4g1ng-pw", encoding: "utf8", version: 1, totp: null }),
  getItemApproval: async () => ({
    item: false,
    fields: [],
    grants: [],
    canChange: true,
    canAddMarks: true,
  }),
} as unknown as VaultsApi;

const noop = async () => undefined;
const actions: ItemPageActions = {
  back: () => undefined,
  edit: () => undefined,
  archive: noop,
  restore: noop,
  deletePermanently: () => undefined,
  move: () => undefined,
  refresh: noop,
};

function Page({ item }: { item: VaultItem }) {
  return (
    <ItemPage item={item} vault={shared} api={api} canUse actions={actions} workspaceId="kit" />
  );
}

export default function SecretUseOnlySection() {
  return (
    <KitSection sectionKey="secret-use-only">
      <StatesGrid
        title="Item page"
        description="The server decides who may see values; the page hides what it would refuse."
        columns={3}
      >
        <StateCell label="Saved it, or an admin" align="stretch">
          <PagePreview label="Item, can see values" height={480}>
            <Page item={asItem(mock, { useOnly: false, canReveal: true })} />
          </PagePreview>
        </StateCell>
        <StateCell label="Another member: use only" align="stretch">
          <PagePreview label="Item, may only use" height={480}>
            <Page item={asItem(mock, { useOnly: false, canReveal: false })} />
          </PagePreview>
        </StateCell>
        <StateCell label="Use-only item, anyone" align="stretch">
          <PagePreview label="Use-only item" height={480}>
            <Page item={asItem(mock, { useOnly: true, canReveal: false })} />
          </PagePreview>
        </StateCell>
      </StatesGrid>
      <StatesGrid title="Editor" description="One switch, under Expires." columns={2}>
        <StateCell label="New item" align="stretch">
          <PagePreview label="New item">
            <ItemEditorPage
              vault={shared}
              initialType="api_key"
              onClose={() => undefined}
              onCreate={noop}
              onUpdate={noop}
              onReload={() => undefined}
            />
          </PagePreview>
        </StateCell>
        <StateCell label="Editing a use-only item" align="stretch">
          <PagePreview label="Edit use-only item">
            <ItemEditorPage
              vault={shared}
              item={asItem(mock, { useOnly: true, canReveal: false })}
              onClose={() => undefined}
              onCreate={noop}
              onUpdate={noop}
              onReload={() => undefined}
            />
          </PagePreview>
        </StateCell>
      </StatesGrid>
      <UsageNotes
        use={["A production key agents should use but no person should ever copy."]}
        avoid={["Secrets you may need to read back later: use-only can't be undone."]}
      />
    </KitSection>
  );
}
