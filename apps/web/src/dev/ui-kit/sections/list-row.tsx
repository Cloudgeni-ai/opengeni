import { useMemo, useState, type ReactNode } from "react";
import {
  BotIcon,
  BracesIcon,
  CalendarClockIcon,
  CopyIcon,
  KeyRoundIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
  UserMinusIcon,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { EmptyState, EmptyStateLink } from "@/components/ui/empty-state";
import {
  ListRow,
  ListRowSkeleton,
  RowList,
  type ListRowProps,
  type RowListColumn,
  type RowListSort,
  type RowListVariant,
} from "@/components/ui/list-row";
import { LogoTile, type LogoTileSize } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { RelativeTime } from "@/components/ui/relative-time";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { usageLevel, usageValueText } from "@/components/ui/usage-meter";
import { cn } from "@/lib/utils";

import airtableLogo from "../../../../../../data/catalog/logos/airtable-com-c6ce8ea28476.jpg";
import frontLogo from "../../../../../../data/catalog/logos/front-com-96ac210c4196.jpg";
import linearLogo from "../../../../../../data/catalog/logos/linear-app-4b4a9f349c60.png";
import notionLogo from "../../../../../../data/catalog/logos/notion-com-3b56ae2f8166.png";
import posthogLogo from "../../../../../../data/catalog/logos/posthog-com-bc08ccdbe582.jpg";
import slackLogo from "../../../../../../data/catalog/logos/slack-com-5a15dccc0dc0.jpg";
import {
  KIT_NOW,
  KIT_TIME_ZONE,
  apiKeys,
  codexOrganizationAccounts,
  codexWorkspaceAccounts,
  connectedCapabilities,
  people,
  personById,
  popularCapabilities,
  schedules,
  skillCapabilities,
  variableSets,
  type Capability,
  type ModelAccount,
  type Person,
} from "../fixtures";
import { Alternative, Fork, KitBlock, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";
import { usePick } from "../picks";

/* ----------------------------------------------------------------------------
   Datasets: every resource the list row has to carry, on the shared fixtures.
   -------------------------------------------------------------------------- */

type DatasetKey =
  | "variable-sets"
  | "api-keys"
  | "schedules"
  | "people"
  | "accounts"
  | "capabilities";

interface RowSpec extends Omit<ListRowProps, "onOpen" | "selected"> {
  id: string;
  /** Plain name, for sorting and menu labels. */
  name: string;
  sort: Record<string, string | number>;
  /**
   * Cells for the table layout, where the header already names the column:
   * "3 days ago" under Updated instead of "Updated 3 days ago".
   */
  tableCells?: Record<string, ReactNode>;
}

interface Dataset {
  key: DatasetKey;
  label: string;
  /** Accessible name of the list. */
  listLabel: string;
  columns: RowListColumn[];
  rows: RowSpec[];
}

const TIME = { now: KIT_NOW, timeZone: KIT_TIME_ZONE } as const;

const LOGOS: Record<string, string> = {
  gmail: "/capability-logos/gmail.ico",
  github: "/capability-logos/github.svg",
  linear: linearLogo,
  posthog: posthogLogo,
  slack: slackLogo,
  notion: notionLogo,
  airtable: airtableLogo,
  front: frontLogo,
};

function capabilityTile(capability: Capability) {
  if (capability.kind === "skill") return <LogoTile icon={<SkillGlyph />} />;
  const src = capability.logoKey ? LOGOS[capability.logoKey] : undefined;
  return (
    <LogoTile
      src={src}
      fit={capability.logoKey === "gmail" ? "contain" : "cover"}
      name={capability.name}
      monogram={capability.monogram}
    />
  );
}

function SkillGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      aria-hidden="true"
    >
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </svg>
  );
}

function PersonAvatar({ person, size }: { person: Person; size: LogoTileSize }) {
  if (person.kind === "service") return <LogoTile size={size} icon={<BotIcon />} />;
  return (
    <Avatar size={size === "lg" ? "lg" : size === "sm" ? "sm" : "default"}>
      <AvatarFallback className="bg-surface-2 text-xs font-semibold text-fg-muted">
        {person.initials}
      </AvatarFallback>
    </Avatar>
  );
}

function UsageText({ percent }: { percent: number | null }) {
  const level = usageLevel(percent);
  return (
    <span
      className={cn(level === "low" || level === "exhausted" ? "font-medium text-danger" : null)}
    >
      {usageValueText(percent)}
    </span>
  );
}

function variableSetRows(): RowSpec[] {
  return variableSets.map((set) => ({
    id: set.id,
    name: set.name,
    leading: <LogoTile icon={<BracesIcon />} />,
    title: set.name,
    titleAddon: set.scopeLabel ? <MetaChip variant="outline">{set.scopeLabel}</MetaChip> : null,
    description: set.description,
    cells: {
      variables: set.variablesLabel,
      usage: set.usageLabel,
      updated: <RelativeTime date={set.updatedAt} prefix="Updated" {...TIME} />,
    },
    tableCells: {
      variables: set.variables.length,
      usage: set.usageLabel.replace(/^Used by /, ""),
      updated: <RelativeTime date={set.updatedAt} {...TIME} />,
    },
    indicator: "open",
    sort: {
      name: set.name,
      variables: set.variables.length,
      usage: set.usedBy.length,
      updated: -new Date(set.updatedAt).getTime(),
    },
  }));
}

function apiKeyRows(): RowSpec[] {
  const lastUsedOrder: Record<string, number> = {
    "2 hours ago": 1,
    "3 weeks ago": 2,
    "12 Aug": 3,
    Never: 9,
  };
  return apiKeys.map((key) => ({
    id: key.id,
    name: key.name,
    leading: <LogoTile icon={<KeyRoundIcon />} />,
    title: key.name,
    titleAddon:
      key.status === "active" ? null : (
        <StatusBadge variant="dot" status={key.status === "expired" ? "expired" : "revoked"}>
          {key.statusLabel}
        </StatusBadge>
      ),
    description: (
      <>
        <span className="font-mono">{key.prefixLabel}</span> · {key.accessLabel}
      </>
    ),
    cells: {
      lastUsed: key.lastUsedLabel,
      expires: key.status === "revoked" ? null : key.expiresLabel,
    },
    indicator: "open",
    sort: {
      name: key.name,
      lastUsed: lastUsedOrder[key.lastUsedLabel] ?? 5,
      expires: key.expiresLabel,
    },
  }));
}

function scheduleMenu(paused: boolean) {
  return (
    <>
      <DropdownMenuItem>
        <PlayIcon />
        Run now
      </DropdownMenuItem>
      <DropdownMenuItem>
        {paused ? <PlayIcon /> : <PauseIcon />}
        {paused ? "Resume" : "Pause"}
      </DropdownMenuItem>
      <DropdownMenuItem>
        <PencilIcon />
        Edit
      </DropdownMenuItem>
      <DropdownMenuItem>
        <CopyIcon />
        Duplicate
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive">
        <Trash2Icon />
        Delete
      </DropdownMenuItem>
    </>
  );
}

function scheduleRows(): RowSpec[] {
  const ordered = [...schedules].sort((left, right) => {
    if (left.state !== right.state) return left.state === "active" ? -1 : 1;
    return (left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? "");
  });
  return ordered.map((schedule) => {
    const paused = schedule.state === "paused";
    const owner = personById(schedule.ownerId);
    const last = schedule.lastRun;
    return {
      id: schedule.id,
      name: schedule.name,
      leading: <LogoTile icon={<CalendarClockIcon />} />,
      title: schedule.name,
      titleAddon: paused ? <StatusBadge variant="dot" status="paused" /> : null,
      description: schedule.cadenceShortLabel,
      cells: {
        next: schedule.nextRunAt ? (
          <RelativeTime date={schedule.nextRunAt} format="absolute" {...TIME} />
        ) : (
          <span className="text-fg-subtle">Paused</span>
        ),
        // Status, then when, as one phrase: "Failed yesterday".
        last:
          last.status === "never" || !last.at ? (
            <span className="text-fg-subtle">Never run</span>
          ) : (
            <span className="inline-flex max-w-full min-w-0 items-center gap-1">
              <StatusBadge
                variant="dot"
                status={last.status === "failed" ? "failed" : "succeeded"}
                className="text-fg-muted"
              />
              <RelativeTime date={last.at} inSentence {...TIME} />
            </span>
          ),
        owner: owner.name.split(" ")[0],
      },
      control: paused ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 rounded-[10px] px-2.5 pointer-coarse:h-11"
        >
          <PlayIcon />
          Resume
        </Button>
      ) : null,
      menu: scheduleMenu(paused),
      menuLabel: `More actions for ${schedule.name}`,
      sort: {
        name: schedule.name,
        next: schedule.nextRunAt ?? "9999",
        last: last.at ?? "0000",
        owner: owner.name,
      },
    } satisfies RowSpec;
  });
}

function peopleRows(): RowSpec[] {
  return people.map((person) => {
    const statusBadge =
      person.status === "invited" ? (
        <StatusBadge variant="dot" status="invited">
          {person.statusLabel}
        </StatusBadge>
      ) : person.status === "suspended" ? (
        <StatusBadge variant="dot" status="suspended" />
      ) : person.status === "invite_failed" ? (
        <StatusBadge variant="dot" status="invite_failed" />
      ) : null;
    const role =
      person.kind === "service"
        ? "Service account"
        : person.organizationRole === "owner"
          ? "Owner"
          : person.organizationRole === "admin"
            ? "Admin"
            : "Member";
    return {
      id: person.id,
      name: person.name,
      leading: (size: LogoTileSize) => <PersonAvatar person={person} size={size} />,
      title: person.name,
      titleAddon: person.isYou ? <MetaChip variant="outline">You</MetaChip> : null,
      description: person.email ?? "Runs CI jobs through the API",
      cells: {
        role,
        workspaces:
          person.workspaceAccess.length === 0
            ? "No workspaces"
            : person.workspaceAccess.length === 1
              ? person.workspaceAccess[0]!.workspaceName
              : `${person.workspaceAccess.length} workspaces`,
        status: statusBadge,
      },
      menu: person.isYou ? null : (
        <>
          <DropdownMenuItem>
            <PencilIcon />
            Change role
          </DropdownMenuItem>
          {person.status === "invited" || person.status === "invite_failed" ? (
            <DropdownMenuItem>
              <RefreshCwIcon />
              Resend invitation
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">
            <UserMinusIcon />
            Remove from organization
          </DropdownMenuItem>
        </>
      ),
      sort: {
        name: person.name,
        role,
        workspaces: person.workspaceAccess.length,
        status: person.statusLabel ?? "",
      },
    } satisfies RowSpec;
  });
}

function accountRows(): RowSpec[] {
  const accounts: ModelAccount[] = [...codexWorkspaceAccounts, ...codexOrganizationAccounts];
  return accounts.map((account) => {
    const weekly = account.usage.find((window) => window.label === "Weekly");
    const fiveHour = account.usage.find((window) => window.label === "5-hour");
    return {
      id: account.id,
      name: account.name,
      leading: <LogoTile name="Codex" monogram="C" />,
      title: account.name,
      titleAddon: (
        <>
          {account.isPrimary ? <MetaChip variant="outline">Primary</MetaChip> : null}
          {account.state === "paused" ? <StatusBadge variant="dot" status="paused" /> : null}
        </>
      ),
      description: `${account.plan} · ${account.sourceLabel}${
        account.availableInLabel ? ` · ${account.availableInLabel}` : ""
      }`,
      cells: {
        weekly: <UsageText percent={weekly?.percentLeft ?? null} />,
        fiveHour: <UsageText percent={fiveHour?.percentLeft ?? null} />,
        resets: account.resets.length > 0 ? `${account.resets.length} available` : null,
      },
      indicator: "open",
      sort: {
        name: account.name,
        weekly: weekly?.percentLeft ?? -1,
        fiveHour: fiveHour?.percentLeft ?? -1,
        resets: account.resets.length,
      },
    } satisfies RowSpec;
  });
}

function capabilityRows(): RowSpec[] {
  const items = [
    ...connectedCapabilities,
    ...popularCapabilities.slice(0, 5),
    ...skillCapabilities.slice(0, 2),
  ];
  return items.map((capability) => {
    const unavailable = capability.status === "unavailable";
    const indicator: RowSpec["indicator"] =
      capability.status === "connected" || capability.status === "installed"
        ? { kind: "added", label: capability.status === "installed" ? "Installed" : "Connected" }
        : capability.status === "needs_reconnect"
          ? { kind: "attention", label: "Needs reconnect" }
          : unavailable
            ? { kind: "unavailable", label: "Unavailable" }
            : { kind: "add", label: capability.actionLabel ?? "Available to add" };
    return {
      id: capability.id,
      name: capability.name,
      leading: capabilityTile(capability),
      title: capability.name,
      description:
        capability.status === "needs_reconnect" ? capability.statusDetail : capability.description,
      disabled: unavailable,
      disabledReason: unavailable ? capability.statusDetail : undefined,
      cells: { by: capability.byLine },
      indicator,
      sort: { name: capability.name, by: capability.byLine },
    } satisfies RowSpec;
  });
}

const DATASETS: Record<DatasetKey, () => Dataset> = {
  "variable-sets": () => ({
    key: "variable-sets",
    label: "Variable sets",
    listLabel: "Variable sets",
    columns: [
      { id: "variables", label: "Variables", width: 88, hideLabel: true, sortable: true },
      { id: "usage", label: "Used by", width: 224, hideLabel: true, sortable: true },
      { id: "updated", label: "Updated", width: 148, hideLabel: true, sortable: true },
    ],
    rows: variableSetRows(),
  }),
  "api-keys": () => ({
    key: "api-keys",
    label: "API keys",
    listLabel: "API keys",
    columns: [
      { id: "lastUsed", label: "Last used", width: 112, sortable: true },
      { id: "expires", label: "Expires", width: 112, sortable: true },
    ],
    rows: apiKeyRows(),
  }),
  schedules: () => ({
    key: "schedules",
    label: "Schedules",
    listLabel: "Schedules",
    columns: [
      { id: "next", label: "Next run", width: 136, sortable: true },
      { id: "last", label: "Last run", width: 176, sortable: true },
      { id: "owner", label: "Owner", width: 72, sortable: true },
    ],
    rows: scheduleRows(),
  }),
  people: () => ({
    key: "people",
    label: "People",
    listLabel: "People in Acme Robotics",
    columns: [
      { id: "role", label: "Role", width: 144, sortable: true },
      { id: "workspaces", label: "Access", width: 144, sortable: true },
      { id: "status", label: "Status", width: 196, hideLabel: true },
    ],
    rows: peopleRows(),
  }),
  accounts: () => ({
    key: "accounts",
    label: "Model accounts",
    listLabel: "Codex accounts",
    columns: [
      { id: "weekly", label: "Weekly", width: 104, sortable: true },
      { id: "fiveHour", label: "5-hour", width: 120, sortable: true },
      { id: "resets", label: "Resets", width: 96, sortable: true },
    ],
    rows: accountRows(),
  }),
  capabilities: () => ({
    key: "capabilities",
    label: "Capabilities",
    listLabel: "Connections",
    columns: [{ id: "by", label: "Made by", width: 176, hideLabel: true }],
    rows: capabilityRows(),
  }),
};

const DATASET_ORDER: DatasetKey[] = [
  "variable-sets",
  "api-keys",
  "schedules",
  "people",
  "accounts",
  "capabilities",
];

const VARIANT_BY_PICK: Record<string, RowListVariant> = {
  a: "catalog",
  b: "resource",
  c: "table",
};

/* ----------------------------------------------------------------------------
   One interactive list: selection follows clicks, tables sort.
   -------------------------------------------------------------------------- */

function DatasetList({
  dataset,
  variant,
  limit,
}: {
  dataset: Dataset;
  variant: RowListVariant;
  limit?: number;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [sort, setSort] = useState<RowListSort>({ column: "name", direction: "asc" });
  const rows = useMemo(() => {
    const base = limit ? dataset.rows.slice(0, limit) : dataset.rows;
    if (variant !== "table") return base;
    const factor = sort.direction === "asc" ? 1 : -1;
    return [...base].sort((left, right) => {
      const a = left.sort[sort.column] ?? "";
      const b = right.sort[sort.column] ?? "";
      if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
      return String(a).localeCompare(String(b)) * factor;
    });
  }, [dataset, limit, sort, variant]);

  return (
    <RowList
      variant={variant}
      columns={dataset.columns}
      label={dataset.listLabel}
      nameSortable
      sort={variant === "table" ? sort : undefined}
      onSortChange={setSort}
    >
      {rows.map(({ id, sort: _sort, name: _name, tableCells, cells, ...row }) => (
        <ListRow
          key={id}
          {...row}
          cells={variant === "table" && tableCells ? tableCells : cells}
          selected={selected === id}
          onOpen={() => setSelected((current) => (current === id ? null : id))}
        />
      ))}
    </RowList>
  );
}

function DatasetSwitch({
  value,
  onChange,
}: {
  value: DatasetKey;
  onChange: (value: DatasetKey) => void;
}) {
  return (
    <span
      className="mt-3 flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label="Sample data"
    >
      <span className="mr-1 text-xs font-medium text-fg-subtle">Show with</span>
      {DATASET_ORDER.map((key) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(key)}
            className={cn(
              "inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-medium transition-colors duration-[120ms] pointer-coarse:h-9",
              active
                ? "border-brand/40 bg-brand/10 text-brand"
                : "border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg",
            )}
          >
            {DATASETS[key]().label}
          </button>
        );
      })}
    </span>
  );
}

/* ----------------------------------------------------------------------------
   The section.
   -------------------------------------------------------------------------- */

export default function ListRowSection() {
  const [datasetKey, setDatasetKey] = useState<DatasetKey>("variable-sets");
  const dataset = useMemo(() => DATASETS[datasetKey](), [datasetKey]);
  const picked = VARIANT_BY_PICK[usePick("list-row") ?? "b"] ?? "resource";
  const variableSetData = useMemo(() => DATASETS["variable-sets"](), []);
  const scheduleData = useMemo(() => DATASETS.schedules(), []);
  const capabilityData = useMemo(() => DATASETS.capabilities(), []);
  const aws = variableSetData.rows[0]!;
  const linear = capabilityData.rows.find((row) => row.id === "cap-linear")!;
  const github = capabilityData.rows.find((row) => row.id === "cap-github")!;

  return (
    <KitSection sectionKey="list-row">
      <Fork
        layout="stack"
        description={
          <>
            We recommend B for things you own and A for catalogs. They share the tile, type and
            hover, so they read as one family. Click a row to select it; table headers sort.
            <DatasetSwitch value={datasetKey} onChange={setDatasetKey} />
          </>
        }
      >
        <Alternative id="a">
          <DatasetList key={`a-${datasetKey}`} dataset={dataset} variant="catalog" />
        </Alternative>
        <Alternative id="b">
          <DatasetList key={`b-${datasetKey}`} dataset={dataset} variant="resource" />
        </Alternative>
        <Alternative id="c">
          <DatasetList key={`c-${datasetKey}`} dataset={dataset} variant="table" />
        </Alternative>
      </Fork>

      <KitBlock
        title="Every resource, in the version you pick"
        description="The same row carries variable sets, keys, schedules, people and accounts. This block follows your pick."
      >
        <div className="flex min-w-0 flex-col gap-8 rounded-[14px] border border-border bg-bg p-5">
          {DATASET_ORDER.filter((key) => key !== "capabilities").map((key) => {
            const data = DATASETS[key]();
            return (
              <section key={key} className="min-w-0">
                <h3 className="mb-3 text-sm leading-5 font-semibold text-fg">{data.label}</h3>
                <DatasetList dataset={data} variant={picked} />
              </section>
            );
          })}
        </div>
      </KitBlock>

      <StatesGrid columns={2} description="The recommended divided resource row (B).">
        <StateCell label="Default" align="stretch">
          <StateList dataset={variableSetData}>
            <ListRow {...rowProps(aws)} onOpen={noop} />
          </StateList>
        </StateCell>
        <StateCell label="Hover" note="A surface-2 fill, 120ms, color only." align="stretch">
          <StateList dataset={variableSetData}>
            <ListRow {...rowProps(aws)} onOpen={noop} className="bg-surface-2" />
          </StateList>
        </StateCell>
        <StateCell
          label="Keyboard focus"
          note="2px brand ring at 55% on the whole row."
          align="stretch"
        >
          <StateList dataset={variableSetData}>
            <ListRow
              {...rowProps(aws)}
              onOpen={noop}
              className="outline-2 -outline-offset-2 outline-brand/55"
            />
          </StateList>
        </StateCell>
        <StateCell label="Selected" note="While its sheet or page is open." align="stretch">
          <StateList dataset={variableSetData}>
            <ListRow {...rowProps(aws)} onOpen={noop} selected />
          </StateList>
        </StateCell>
        <StateCell
          label="Disabled with reason"
          note="Says why and who can fix it. Not clickable."
          align="stretch"
        >
          <StateList dataset={capabilityData}>
            <ListRow {...rowProps(github)} />
          </StateList>
        </StateCell>
        <StateCell
          label="Needs attention"
          note="Purple alert and the state in words."
          align="stretch"
        >
          <StateList dataset={capabilityData}>
            <ListRow {...rowProps(linear)} onOpen={noop} />
          </StateList>
        </StateCell>
        <StateCell label="Loading" note="Same geometry, so nothing jumps." align="stretch">
          <RowList variant="resource" columns={variableSetData.columns} label="Variable sets" busy>
            <ListRowSkeleton count={3} />
          </RowList>
        </StateCell>
        <StateCell label="Couldn't load" note="What happened and what to do." align="stretch">
          <EmptyState
            variant="inline"
            title="Couldn't load variable sets."
            description="Check your connection and try again."
            action={<EmptyStateLink onClick={noop}>Try again</EmptyStateLink>}
          />
        </StateCell>
        <StateCell
          label="Long text"
          note="Title and description truncate; nothing wraps under the chevron."
          align="stretch"
        >
          <StateList dataset={variableSetData}>
            <ListRow
              {...rowProps(aws)}
              onOpen={noop}
              title="AWS production (legacy billing account, keep for the cost anomaly schedule)"
              titleAddon={<MetaChip variant="outline">Organization</MetaChip>}
              description="Read-only IAM credentials for the production AWS account in eu-north-1, rotated monthly by the platform team and shared with the cost anomaly schedule."
            />
          </StateList>
        </StateCell>
        <StateCell
          label="With one control"
          note="The row holds a switch, so the row itself is not a button."
          align="stretch"
        >
          <RowList variant="resource" label="Organization connections">
            <ListRow
              leading={<LogoTile src={LOGOS.slack} name="Slack" />}
              title="Slack"
              description="Available in all shared workspaces"
              control={<Switch defaultChecked aria-label="Slack available in all workspaces" />}
            />
            <ListRow
              leading={<LogoTile src={LOGOS.notion} name="Notion" />}
              title="Notion"
              description="Not available in any workspace"
              control={<Switch aria-label="Notion available in all workspaces" />}
            />
          </RowList>
        </StateCell>
        <StateCell
          label="Mobile 390"
          span="full"
          width="mobile"
          note="Fact columns fold into the meta line; the ⋯ menu stays reachable at 44px."
          align="stretch"
        >
          <RowList
            variant="resource"
            columns={scheduleData.columns}
            label="Schedules"
            className="max-w-[390px]"
          >
            {scheduleData.rows.map((spec) => (
              <ListRow key={spec.id} {...rowProps(spec)} onOpen={noop} />
            ))}
          </RowList>
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "Anything you own or manage: variable sets, API keys, schedules, people, model accounts, machines, environments.",
          "Catalogs you browse and add from, with the catalog layout (A): Capabilities, skills, plugins.",
          "The table layout (C) once a list passes about 20 items or needs numeric columns: call log, billing.",
          "Sub-lists inside a detail sheet, like usage limit resets or what uses a variable set.",
        ]}
        avoid={[
          "A single setting with one control: use a setting row.",
          "Several buttons on a row: keep one control, move the rest into the ⋯ menu or the detail sheet.",
          "Rows inside a card, or a list nested in a row: open a sheet instead.",
          "A right chevron that expands in place. A chevron means it opens.",
        ]}
      />
    </KitSection>
  );
}

function noop() {}

function rowProps(spec: RowSpec): ListRowProps {
  const { id: _id, sort: _sort, name: _name, tableCells: _tableCells, ...row } = spec;
  return row;
}

function StateList({ dataset, children }: { dataset: Dataset; children: ReactNode }) {
  return (
    <RowList variant="resource" columns={dataset.columns} label={dataset.listLabel}>
      {children}
    </RowList>
  );
}
