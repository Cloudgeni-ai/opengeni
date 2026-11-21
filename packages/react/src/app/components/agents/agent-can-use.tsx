/**
 * The agent page's Can use (docs/agents.md): Allow, Ask first or Block per
 * tool in its chats, for any connection. Only connections with a rule are
 * listed, each with its logo; Add rule picks a connection (or one of its
 * tools) and a choice. Each change saves on its own.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon } from "lucide-react";
import type {
  Agent,
  AgentToolPermission,
  AgentToolPermissionRule,
  CapabilityCatalogItem,
} from "@opengeni/sdk";

import { AGENT_BUILT_IN_GITHUB_CONNECTOR, GITHUB_REST_TOOL_NAMES } from "@opengeni/contracts";

import { Button } from "../../../ui/button";
import { DetailSection } from "../../../ui/detail-sheet";
import { LogoTile } from "../../../ui/logo-tile";
import { SelectMenu } from "../../../ui/select-menu";
import { SettingRow, SettingRowSkeleton } from "../../../ui/setting-row";
import { useAppContext } from "../../app-context";
import { connectionLogoResolver } from "../../lib/composer-connectors";
import { FIRST_PARTY_CAPABILITY_LOGOS } from "../capabilities/capability-logo-source";
import { PermissionSelect } from "../capabilities/connector-tool-permissions";

/** The rule key a connection is named by: its provider's domain, else its server id. */
export function agentConnectorKey(
  item: Pick<CapabilityCatalogItem, "id" | "providerDomain" | "connectionRef" | "tools">,
): string {
  const domain = item.connectionRef?.providerDomain ?? null;
  if (domain) return domain;
  return item.tools.find((tool) => tool.kind === "mcp")?.id ?? item.id;
}

/** The rules with one connector's choice for one tool (`*`: all its tools) set, or cleared with null. */
export function withAgentRule(
  rules: readonly AgentToolPermissionRule[],
  connector: string,
  tool: string,
  permission: AgentToolPermission | null,
): AgentToolPermissionRule[] {
  const rest = rules.filter((rule) => !(rule.connector === connector && rule.tool === tool));
  return permission === null ? rest : [...rest, { connector, tool, permission }];
}

/** One thing a rule can name: a connection (all its accounts) or Opengeni's own GitHub tools. */
export interface CanUseConnection {
  /** The rule key: a provider domain, a server id, or `*`. */
  key: string;
  name: string;
  logo: string | null;
  /** The catalog entries behind it, whose tools it lists. */
  itemIds: string[];
  /** What applies without a rule. */
  defaultLabel: string;
}

const CONNECTION_DEFAULT = "Connection's setting";

function canUseTarget(item: CapabilityCatalogItem): boolean {
  return item.enabled && item.kind === "mcp" && item.source !== "built_in";
}

/**
 * Every connection a rule can name, one per rule key (two accounts of one
 * provider share it), with the logo the Connectors picker shows. Opengeni's
 * own GitHub tools are named by `github.com`, so they come last unless a
 * GitHub connection already covers that key.
 */
export function canUseConnections(
  catalog: readonly CapabilityCatalogItem[],
  assetUrl: (path: string | null) => string | null,
): CanUseConnection[] {
  const logoFor = connectionLogoResolver(catalog, assetUrl);
  const byKey = new Map<string, CanUseConnection>();
  for (const item of catalog.filter(canUseTarget)) {
    const key = agentConnectorKey(item);
    const logo = logoFor(item, item.connectionRef?.providerDomain ?? item.providerDomain);
    const known = byKey.get(key);
    if (known) {
      known.itemIds.push(item.id);
      known.logo ??= logo;
      continue;
    }
    byKey.set(key, {
      key,
      name: item.name,
      logo,
      itemIds: [item.id],
      defaultLabel: CONNECTION_DEFAULT,
    });
  }
  if (!byKey.has(AGENT_BUILT_IN_GITHUB_CONNECTOR)) {
    byKey.set(AGENT_BUILT_IN_GITHUB_CONNECTOR, {
      key: AGENT_BUILT_IN_GITHUB_CONNECTOR,
      name: "GitHub",
      logo: FIRST_PARTY_CAPABILITY_LOGOS["api:github-app"] ?? null,
      itemIds: [],
      defaultLabel: "Default",
    });
  }
  return [...byKey.values()];
}

/**
 * The connections that have a rule, in list order. A rule for a connection
 * not listed (another person's, or not set up yet, such as a ready-made
 * agent's suggestion) still shows, named by its key, so it can be changed or
 * removed.
 */
export function ruledConnections(
  connections: readonly CanUseConnection[],
  rules: readonly AgentToolPermissionRule[],
  logoForDomain: (domain: string) => string | null = () => null,
): CanUseConnection[] {
  const ruled = new Set(rules.map((rule) => rule.connector));
  const listed = connections.filter((connection) => ruled.has(connection.key));
  const known = new Set(connections.map((connection) => connection.key));
  const unlisted = [...ruled]
    .filter((key) => !known.has(key))
    .map((key) => ({
      key,
      name: key === "*" ? "Every connection" : key,
      logo: key === "*" ? null : logoForDomain(key),
      itemIds: [],
      defaultLabel: CONNECTION_DEFAULT,
    }));
  return [...listed, ...unlisted];
}

function ConnectionLogo({ connection }: { connection: Pick<CanUseConnection, "name" | "logo"> }) {
  return <LogoTile size="sm" src={connection.logo} name={connection.name} />;
}

/** One connection's rules: all its tools, then any tool set on its own. */
function CanUseRuleRow({
  connection,
  loadTools,
  rules,
  disabled,
  onChange,
}: {
  connection: CanUseConnection;
  loadTools: () => Promise<string[]>;
  rules: readonly AgentToolPermissionRule[];
  disabled: boolean;
  onChange: (rules: AgentToolPermissionRule[]) => void;
}) {
  const { key, name, defaultLabel } = connection;
  const own = rules.filter((rule) => rule.connector === key);
  const all = own.find((rule) => rule.tool === "*")?.permission;
  const toolRules = own.filter((rule) => rule.tool !== "*");
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<string[] | null>(null);
  // Read once, the first time the list opens.
  const loadToolsOnce = useRef(loadTools);
  loadToolsOnce.current = loadTools;
  const requested = useRef(false);
  useEffect(() => {
    if (!open || requested.current) return;
    requested.current = true;
    loadToolsOnce.current().then(setTools, () => setTools([]));
  }, [open]);
  const toolNames = [
    ...new Set([...toolRules.map((rule) => rule.tool), ...(open ? (tools ?? []) : [])]),
  ];
  return (
    <SettingRow
      data-agent-can-use={key}
      label={
        <span className="flex min-w-0 items-center gap-2">
          <ConnectionLogo connection={connection} />
          <span className="min-w-0 break-words">{name}</span>
        </span>
      }
      description={
        <button
          type="button"
          className="text-xs text-fg-muted underline decoration-fg/25 underline-offset-2 hover:decoration-fg"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide tools" : "Choose per tool"}
        </button>
      }
      controlWidth="select"
      control={
        <PermissionSelect
          label={`${name}: all tools`}
          value={all ?? "default"}
          disabled={disabled}
          resetLabel={all ? "Remove" : defaultLabel}
          onChange={(permission) => onChange(withAgentRule(rules, key, "*", permission))}
        />
      }
    >
      {toolNames.map((tool) => {
        const value = toolRules.find((rule) => rule.tool === tool)?.permission;
        return (
          <SettingRow
            key={tool}
            label={<code className="text-xs">{tool}</code>}
            controlWidth="select"
            control={
              <PermissionSelect
                label={`${name}: ${tool}`}
                value={value ?? "default"}
                disabled={disabled}
                resetLabel={value ? "Remove" : all ? "Same as all tools" : defaultLabel}
                onChange={(permission) => onChange(withAgentRule(rules, key, tool, permission))}
              />
            }
          />
        );
      })}
      {open && tools === null ? <SettingRowSkeleton /> : null}
    </SettingRow>
  );
}

const ALL_TOOLS = "*";

/** Add rule: a connection (with its logo), all its tools or one, then the choice. */
export function AddCanUseRule({
  connections,
  loadTools,
  disabled,
  onAdd,
  onCancel,
}: {
  connections: readonly CanUseConnection[];
  loadTools: (connection: CanUseConnection) => Promise<string[]>;
  disabled: boolean;
  onAdd: (connector: string, tool: string, permission: AgentToolPermission) => void;
  onCancel: () => void;
}) {
  const [key, setKey] = useState<string | null>(null);
  const [tool, setTool] = useState(ALL_TOOLS);
  const [tools, setTools] = useState<{ key: string; names: string[] } | null>(null);
  const connection = connections.find((entry) => entry.key === key);
  const loadToolsRef = useRef(loadTools);
  loadToolsRef.current = loadTools;
  useEffect(() => {
    if (!connection) return;
    let live = true;
    loadToolsRef.current(connection).then(
      (names) => live && setTools({ key: connection.key, names }),
      () => live && setTools({ key: connection.key, names: [] }),
    );
    return () => {
      live = false;
    };
  }, [connection]);
  const toolNames = tools && tools.key === key ? tools.names : null;
  return (
    <div data-agent-add-rule="" className="flex flex-wrap items-center gap-2 py-3">
      <SelectMenu
        variant="combobox"
        aria-label="Connection"
        name="connection"
        size="sm"
        className="w-full sm:w-60"
        value={key}
        placeholder="Choose a connection"
        searchPlaceholder="Search connections"
        disabled={disabled}
        options={connections.map((entry) => ({
          value: entry.key,
          label: entry.name,
          leading: <ConnectionLogo connection={entry} />,
          keywords: [entry.key],
        }))}
        onValueChange={(next) => {
          setKey(next);
          setTool(ALL_TOOLS);
        }}
      />
      {connection ? (
        <SelectMenu
          variant="combobox"
          aria-label="Tool"
          name="tool"
          size="sm"
          className="w-full sm:w-48"
          value={tool}
          searchPlaceholder="Search tools"
          disabled={disabled}
          loading={toolNames === null}
          loadingLabel="Loading tools…"
          options={[
            { value: ALL_TOOLS, label: "All tools" },
            ...(toolNames ?? []).map((name) => ({ value: name, label: name })),
          ]}
          onValueChange={setTool}
        />
      ) : null}
      {connection ? (
        <SelectMenu<AgentToolPermission>
          aria-label="Choice"
          name="permission"
          size="sm"
          className="w-full sm:w-36"
          value={null}
          placeholder="Choose"
          disabled={disabled}
          options={[
            { value: "allow", label: "Allow", description: "Run without asking." },
            { value: "ask", label: "Ask first", description: "Review each action before it runs." },
            { value: "block", label: "Block", description: "Do not run this action." },
          ]}
          onValueChange={(permission) => onAdd(connection.key, tool, permission)}
        />
      ) : null}
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

export function AgentCanUse({
  agent,
  workspaceId,
  onSaved,
  onError,
}: {
  agent: Agent;
  workspaceId: string;
  onSaved: (agent: Agent) => void;
  onError: (error: unknown) => void;
}) {
  const { client } = useAppContext();
  const [catalog, setCatalog] = useState<CapabilityCatalogItem[] | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    let live = true;
    client.listCapabilities(workspaceId).then(
      (response) => live && setCatalog(response.items),
      () => live && setCatalog([]),
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  const assetUrl = useMemo(() => (path: string | null) => client.catalogAssetUrl(path), [client]);
  const connections = useMemo(
    () => (catalog ? canUseConnections(catalog, assetUrl) : null),
    [assetUrl, catalog],
  );
  const ruled = useMemo(() => {
    if (!catalog || !connections) return null;
    const logoFor = connectionLogoResolver(catalog, assetUrl);
    return ruledConnections(connections, agent.toolPermissions, (domain) =>
      logoFor(undefined, domain),
    );
  }, [agent.toolPermissions, assetUrl, catalog, connections]);
  const loadTools = async (connection: CanUseConnection): Promise<string[]> => {
    const lists = await Promise.all(
      connection.itemIds.map((id) =>
        client
          .getConnectorToolPermissions(workspaceId, id)
          .then((response) => response.tools.map((tool) => tool.name)),
      ),
    );
    // A github.com rule also covers Opengeni's own GitHub tools.
    const builtIn =
      connection.key === AGENT_BUILT_IN_GITHUB_CONNECTOR ? GITHUB_REST_TOOL_NAMES : [];
    return [...new Set([...lists.flat(), ...builtIn])];
  };
  // One change at a time: each saves at the version the last one returned.
  const [saving, setSaving] = useState(false);
  const save = async (rules: AgentToolPermissionRule[]) => {
    setSaving(true);
    try {
      onSaved(
        await client.updateAgent(workspaceId, agent.id, {
          expectedVersion: agent.version,
          toolPermissions: rules,
        }),
      );
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const canEdit = agent.viewer.canEdit;
  return (
    <DetailSection
      title="Can use"
      description="Ask first or Block applies in this agent's chats. Allow follows the connection's own setting."
      action={
        canEdit && !adding ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={catalog === null}
            onClick={() => setAdding(true)}
          >
            <PlusIcon />
            Add rule
          </Button>
        ) : undefined
      }
    >
      {ruled === null ? <SettingRowSkeleton /> : null}
      {ruled?.length === 0 && !adding ? (
        <p className="m-0 text-sm text-fg-muted">Each connection follows its own setting.</p>
      ) : null}
      {ruled?.map((connection) => (
        <CanUseRuleRow
          key={connection.key}
          connection={connection}
          loadTools={() => loadTools(connection)}
          rules={agent.toolPermissions}
          disabled={!canEdit || saving}
          onChange={(rules) => void save(rules)}
        />
      ))}
      {adding && connections ? (
        <AddCanUseRule
          connections={connections}
          loadTools={loadTools}
          disabled={saving}
          onCancel={() => setAdding(false)}
          onAdd={(connector, tool, permission) =>
            void save(withAgentRule(agent.toolPermissions, connector, tool, permission)).then(
              (saved) => saved && setAdding(false),
            )
          }
        />
      ) : null}
    </DetailSection>
  );
}
