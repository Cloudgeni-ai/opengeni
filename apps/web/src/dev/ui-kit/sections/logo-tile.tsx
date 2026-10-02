import type { ReactNode } from "react";
import {
  BotIcon,
  BracesIcon,
  CalendarClockIcon,
  CircleAlertIcon,
  KeyRoundIcon,
  PlugIcon,
  SparklesIcon,
} from "lucide-react";

import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile, type LogoTileSize } from "@/components/ui/logo-tile";
import { StatusBadge } from "@/components/ui/status-badge";

import airtableLogo from "../../../../../../data/catalog/logos/airtable-com-c6ce8ea28476.jpg";
import frontLogo from "../../../../../../data/catalog/logos/front-com-96ac210c4196.jpg";
import linearLogo from "../../../../../../data/catalog/logos/linear-app-4b4a9f349c60.png";
import notionLogo from "../../../../../../data/catalog/logos/notion-com-3b56ae2f8166.png";
import posthogLogo from "../../../../../../data/catalog/logos/posthog-com-bc08ccdbe582.jpg";
import slackLogo from "../../../../../../data/catalog/logos/slack-com-5a15dccc0dc0.jpg";
import { connectedCapabilities, popularCapabilities } from "../fixtures";
import { KitBlock, KitCanvas, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";

const SIZES: Array<{ size: LogoTileSize; px: number; use: string }> = [
  { size: "lg", px: 40, use: "Catalog rows, sheet and page headers, empty states" },
  { size: "md", px: 32, use: "Resource rows, template cards" },
  { size: "sm", px: 24, use: "Tables, inline mentions, menus" },
];

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="m-0 flex min-w-0 flex-col items-center gap-2">
      {children}
      <figcaption className="max-w-24 truncate text-center text-xs leading-4.5 text-fg-muted">
        {label}
      </figcaption>
    </figure>
  );
}

export default function LogoTileSection() {
  const gmail = connectedCapabilities[0]!;
  const linear = connectedCapabilities[1]!;
  const drive = popularCapabilities.find((capability) => capability.id === "cap-google-drive")!;

  return (
    <KitSection sectionKey="logo-tile">
      <KitBlock
        title="Sizes"
        description="Radius 10 at 40 and 32px, 6 at 24px so the small tile stays square. A 1px hairline sits on top of the logo in both themes."
      >
        <KitCanvas padding={false}>
          <div className="grid min-w-0 divide-y divide-border">
            {SIZES.map(({ size, px, use }) => (
              <div
                key={size}
                className="grid min-w-0 grid-cols-[88px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 px-5 py-4 @xl/kit-section:grid-cols-[88px_minmax(0,1fr)_minmax(0,1.2fr)]"
              >
                <div>
                  <p className="text-sm leading-5 font-medium text-fg">{px}px</p>
                  <p className="text-xs leading-4.5 text-fg-subtle">size="{size}"</p>
                </div>
                <div className="flex min-w-0 items-center gap-3">
                  <LogoTile size={size} src={slackLogo} name="Slack" />
                  <LogoTile
                    size={size}
                    src="/capability-logos/gmail.ico"
                    fit="contain"
                    name="Gmail"
                  />
                  <LogoTile size={size} name="Jira & Confluence" monogram="J" />
                  <LogoTile size={size} icon={<BracesIcon />} />
                  <LogoTile size={size} icon={<KeyRoundIcon />} />
                </div>
                <p className="col-span-2 text-xs leading-4.5 text-fg-muted @xl/kit-section:col-span-1">
                  {use}
                </p>
              </div>
            ))}
          </div>
        </KitCanvas>
      </KitBlock>

      <KitBlock
        title="What goes in the tile"
        description="A real logo when there is one. A monogram when a brand has no logo yet. A glyph for things that aren't brands, so a fallback never looks like a logo."
      >
        {/* Two by two, so the long groups share a row and the short ones share the next. */}
        <div className="grid min-w-0 gap-4 @xl/kit-section:grid-cols-2">
          <KitCanvas>
            <p className="mb-4 text-xs leading-4.5 font-medium text-fg-muted">App icons (cover)</p>
            <div className="flex flex-wrap gap-4">
              <Labelled label="Slack">
                <LogoTile src={slackLogo} name="Slack" />
              </Labelled>
              <Labelled label="Linear">
                <LogoTile src={linearLogo} name="Linear" />
              </Labelled>
              <Labelled label="PostHog">
                <LogoTile src={posthogLogo} name="PostHog" />
              </Labelled>
              <Labelled label="Notion">
                <LogoTile src={notionLogo} name="Notion" />
              </Labelled>
              <Labelled label="Airtable">
                <LogoTile src={airtableLogo} name="Airtable" />
              </Labelled>
              <Labelled label="Front">
                <LogoTile src={frontLogo} name="Front" />
              </Labelled>
              <Labelled label="GitHub">
                <LogoTile src="/capability-logos/github.svg" name="GitHub" />
              </Labelled>
            </div>
          </KitCanvas>
          <KitCanvas>
            <p className="mb-4 text-xs leading-4.5 font-medium text-fg-muted">Glyphs</p>
            <div className="flex flex-wrap gap-4">
              <Labelled label="Variable set">
                <LogoTile icon={<BracesIcon />} />
              </Labelled>
              <Labelled label="API key">
                <LogoTile icon={<KeyRoundIcon />} />
              </Labelled>
              <Labelled label="Schedule">
                <LogoTile icon={<CalendarClockIcon />} />
              </Labelled>
              <Labelled label="Service account">
                <LogoTile icon={<BotIcon />} />
              </Labelled>
              <Labelled label="Template">
                <LogoTile icon={<SparklesIcon />} tone="brand" />
              </Labelled>
              <Labelled label="Error">
                <LogoTile icon={<CircleAlertIcon />} tone="danger" />
              </Labelled>
            </div>
          </KitCanvas>
          <KitCanvas>
            <p className="mb-4 text-xs leading-4.5 font-medium text-fg-muted">Marks (contain)</p>
            <div className="flex flex-wrap gap-4">
              <Labelled label="Gmail">
                <LogoTile src="/capability-logos/gmail.ico" fit="contain" name="Gmail" />
              </Labelled>
              <Labelled label="Reddit">
                <LogoTile src="/capability-logos/reddit.svg" fit="contain" name="Reddit" />
              </Labelled>
            </div>
          </KitCanvas>
          <KitCanvas>
            <p className="mb-4 text-xs leading-4.5 font-medium text-fg-muted">Monograms</p>
            <div className="flex flex-wrap gap-4">
              <Labelled label={drive.name}>
                <LogoTile name={drive.name} monogram={drive.monogram} />
              </Labelled>
              <Labelled label="Jira">
                <LogoTile name="Jira & Confluence" monogram="J" />
              </Labelled>
              <Labelled label="Codex">
                <LogoTile name="Codex" monogram="C" />
              </Labelled>
            </div>
          </KitCanvas>
        </div>
      </KitBlock>

      <StatesGrid columns={3}>
        <StateCell
          label="Broken logo"
          note="A missing or failing image falls back to the monogram, never a broken-image glyph."
        >
          <div className="flex items-center gap-4">
            <LogoTile src="/capability-logos/does-not-exist.svg" name="Airtable" />
            <LogoTile size="md" src="/capability-logos/does-not-exist.svg" name="Airtable" />
            <LogoTile size="sm" src="/capability-logos/does-not-exist.svg" name="Airtable" />
          </div>
        </StateCell>
        <StateCell label="No logo yet" note="Monogram on surface-2, the same in light and dark.">
          <LogoTile name="Front" />
        </StateCell>
        <StateCell
          label="Standalone"
          note='With label="Slack" the tile is an image with a name; next to a visible name it stays decorative.'
        >
          <LogoTile src={slackLogo} label="Slack" />
        </StateCell>
        <StateCell
          label="In a list"
          span={2}
          align="stretch"
          note="The list sets the size: 40 in catalogs, 32 in resource rows, 24 in tables."
        >
          <RowList label="Connections">
            <ListRow
              leading={<LogoTile src={linearLogo} name="Linear" />}
              title={linear.name}
              description={linear.statusDetail}
              indicator={{ kind: "attention", label: "Needs reconnect" }}
              onOpen={() => {}}
            />
            <ListRow
              leading={<LogoTile src="/capability-logos/gmail.ico" fit="contain" name="Gmail" />}
              title={gmail.name}
              titleAddon={<StatusBadge variant="dot" status="connected" />}
              description={gmail.description}
              indicator="open"
              onOpen={() => {}}
            />
          </RowList>
        </StateCell>
        <StateCell
          label="Mobile 390"
          width="mobile"
          note="Tiles never shrink; titles truncate instead."
        >
          <div className="flex min-w-0 items-center gap-3">
            <LogoTile icon={<PlugIcon />} />
            <p className="min-w-0 truncate text-sm font-medium text-fg">
              Jira & Confluence (Acme Robotics engineering site)
            </p>
          </div>
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "The leading tile of every list row, sheet header and empty state.",
          "Brand logos from the catalog, shown as app icons (cover) or padded marks (contain).",
          "A lucide glyph for product objects: variable sets, keys, schedules, service accounts.",
        ]}
        avoid={[
          "People: use their avatar.",
          "A white plate behind logos in dark mode, or a bare letter with no tile.",
          "Status in a row: the tile keeps its color; say what's wrong with a status badge.",
        ]}
      />
    </KitSection>
  );
}
