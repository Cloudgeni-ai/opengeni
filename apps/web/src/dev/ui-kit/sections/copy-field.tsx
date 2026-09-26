import { KeyRoundIcon } from "lucide-react";

import { CopyField } from "@/components/ui/copy-field";
import { Field } from "@/components/ui/field";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { SettingRow } from "@/components/ui/setting-row";
import { KitBlock, KitCanvas, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";
import { apiKeys, currentWorkspace, newApiKeySecret, organization } from "../fixtures";

const failedCopy = async () => false;

function WorkspaceIdRow() {
  return (
    <SettingRow
      label="Workspace ID"
      description="Use it with the API and the CLI."
      controlWidth="auto"
      control={
        <CopyField size="md" value={currentWorkspace.id} truncate="middle" label="workspace ID" />
      }
    />
  );
}

export default function CopyFieldSection() {
  const terraform = apiKeys[1]!;
  const ci = apiKeys[0]!;
  return (
    <KitSection sectionKey="copy-field">
      <KitBlock
        title="Variants"
        description="Inline for rows and meta, where the value is one detail among others. Field when the value is the point of the row, or when someone has to copy it now."
      >
        <div className="grid min-w-0 gap-4 @2xl/kit-section:grid-cols-2">
          <KitCanvas canvas="surface">
            <p className="mb-2 text-xs font-medium text-fg-muted">Inline · sm, in a list row</p>
            <RowList variant="resource" label="API keys">
              {[terraform, ci].map((key) => (
                <ListRow
                  key={key.id}
                  leading={<LogoTile icon={<KeyRoundIcon />} name={key.name} />}
                  title={key.name}
                  meta={[
                    <CopyField
                      key="prefix"
                      value={key.prefix}
                      display={key.prefixLabel}
                      label={`${key.name} key prefix`}
                    />,
                    key.lastUsedLabel === "Never" ? "Never used" : `Used ${key.lastUsedLabel}`,
                  ]}
                />
              ))}
            </RowList>
          </KitCanvas>
          <KitCanvas canvas="surface">
            <p className="mb-2 text-xs font-medium text-fg-muted">Inline · md, in a setting row</p>
            <WorkspaceIdRow />
          </KitCanvas>
          <KitCanvas canvas="surface" className="@2xl/kit-section:col-span-2">
            <p className="mb-3 text-xs font-medium text-fg-muted">Field</p>
            <div className="max-w-[560px]">
              <Field
                label="Organization ID"
                hint="Use it with the API and when you contact support."
              >
                <CopyField variant="field" value={organization.id} label="organization ID" />
              </Field>
            </div>
          </KitCanvas>
        </div>
      </KitBlock>

      <StatesGrid columns={3}>
        <StateCell label="Default">
          <CopyField size="md" value={currentWorkspace.id} truncate="middle" label="workspace ID" />
        </StateCell>
        <StateCell label="Copied" note="Two seconds, then back. Announced as “Copied”.">
          <CopyField
            size="md"
            value={currentWorkspace.id}
            truncate="middle"
            label="workspace ID"
            previewState="copied"
          />
        </StateCell>
        <StateCell
          label="Clipboard blocked"
          note="The full value is selected, and the tooltip says how to copy it."
        >
          <div className="pt-10">
            <CopyField
              size="md"
              value={currentWorkspace.id}
              truncate="middle"
              label="workspace ID"
              copy={failedCopy}
              previewState="failed"
            />
          </div>
        </StateCell>
        <StateCell
          label="Narrow · middle truncation"
          note="Only when space runs out: the start gives way, the end people compare stays."
        >
          <div className="w-[200px] max-w-full">
            <CopyField
              size="md"
              value={currentWorkspace.id}
              truncate="middle"
              label="workspace ID"
            />
          </div>
        </StateCell>
        <StateCell label="Field · copied" align="stretch">
          <CopyField
            variant="field"
            value={organization.id}
            label="organization ID"
            previewState="copied"
          />
        </StateCell>
        <StateCell label="Field · clipboard blocked" align="stretch">
          <CopyField
            variant="field"
            value={organization.id}
            label="organization ID"
            copy={failedCopy}
            previewState="failed"
          />
        </StateCell>
        <StateCell
          label="Disabled"
          align="stretch"
          note="Only when the value doesn't exist yet. Otherwise hide the row."
        >
          <CopyField
            variant="field"
            value=""
            placeholder="Created when you save"
            label="workspace ID"
            disabled
          />
        </StateCell>
        <StateCell
          label="Long value · wraps"
          align="stretch"
          note="One-time tokens wrap so nothing hides behind a scroll."
        >
          <div className="mx-auto w-full max-w-[320px]">
            <CopyField variant="field" wrap value={newApiKeySecret.token} label="new API key" />
          </div>
        </StateCell>
        <StateCell
          label="Mobile 390"
          width="mobile"
          align="stretch"
          note="44px targets on touch screens."
        >
          <WorkspaceIdRow />
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "Workspace ID, organization ID and API key prefixes",
          "A token shown once, inside the flow that created it",
          "Anything people paste into a terminal, a config file or a support ticket",
        ]}
        avoid={[
          "Saved secrets: they are write-only, so there is nothing to copy",
          "Links (use a link) and long text (use a code block)",
          "Values people read but never paste, like a region: plain text is enough",
        ]}
      />
    </KitSection>
  );
}
