import { useEffect, useState, type ReactNode } from "react";
import {
  Building2,
  SlidersHorizontal,
  Mic,
  Video,
  Shrink,
  Users,
  KeyRound,
  Cpu,
  Plus,
  Check,
  ChevronRight,
  Moon,
  Sun,
  ArrowUpRight,
  Download,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SettingsSwitch } from "@/components/ui/settings-patterns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { CodexSourceSettings } from "@/components/codex-source-settings";
import { SubscriptionAccountRow } from "@/components/subscription-account-row";
import { SubscriptionDeviceCodePanel } from "@/components/subscription-device-code-panel";
import { PermissionGroupPicker } from "@/components/permission-picker";
import type { CodexAccountsResponse } from "@opengeni/sdk";
import "./settings-studio.css";

const pages = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "models", label: "Models & subscriptions", icon: Cpu },
  { id: "members", label: "Members", icon: Users },
  { id: "keys", label: "API keys", icon: KeyRound },
];
const designs = [
  {
    id: "tiles",
    name: "A · Soft modules",
    description:
      "Icon-led tiles. Each setting has its own calm surface; collections become a card grid.",
  },
  {
    id: "ledger",
    name: "B · Quiet index",
    description:
      "An open, continuous list. Section labels sit alongside controls, with minimal framing.",
  },
  {
    id: "focus",
    name: "C · Overview → editor",
    description:
      "Scan concise summaries first. Open one setting at a time in a focused detail dialog.",
  },
];
type SettingItem = {
  id: string;
  title: string;
  description: string;
  icon: ReactNode;
  summary: string;
  control: ReactNode;
  detail?: ReactNode;
};

/** Shared proposed presentation, independent of settings state and backend. */
export function SettingsPresentation({
  variant,
  items,
  onOpen,
}: {
  variant: string;
  items: SettingItem[];
  onOpen: (item: SettingItem) => void;
}) {
  return (
    <div className={`settings-items ${variant}`}>
      {items.map((item) => (
        <article key={item.id} className="setting-item">
          <span className="setting-symbol" aria-hidden="true">
            {item.icon}
          </span>
          <div className="setting-copy">
            <h3>{item.title}</h3>
            <p>{variant === "focus" ? item.summary : item.description}</p>
          </div>
          {variant === "focus" ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Edit ${item.title}`}
              onClick={() => onOpen(item)}
            >
              <ChevronRight />
            </Button>
          ) : (
            <div className="setting-control">{item.control}</div>
          )}
        </article>
      ))}
    </div>
  );
}

export function SettingsStudio() {
  const [page, setPage] = useState("general"),
    [variant, setVariant] = useState("tiles"),
    [theme, setTheme] = useState("dark");
  const [name, setName] = useState("Design engineering"),
    [voice, setVoice] = useState(true),
    [video, setVideo] = useState(false),
    [portable, setPortable] = useState(false);
  const [dialog, setDialog] = useState<string | null>(null),
    [editing, setEditing] = useState<string | null>(null),
    [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<Record<string, string>>({}),
    [notes, setNotes] = useState("");
  const [accountName, setAccountName] = useState("Team subscription"),
    [expanded, setExpanded] = useState(true),
    [allocation, setAllocation] = useState(true),
    [device, setDevice] = useState("idle");
  const [source, setSource] = useState<NonNullable<CodexAccountsResponse["source"]>>({
    accountId: "sample-org",
    workspaceId: "sample-workspace",
    workspaceKind: "shared",
    mode: "automatic",
    effectiveSource: "workspace",
    workspaceAvailable: true,
    organizationAvailable: true,
  });
  const [members, setMembers] = useState([
    { name: "Alex Morgan", email: "alex@example.com", role: "admin", self: true },
    { name: "Sam Rivera", email: "sam@example.com", role: "member", self: false },
  ]);
  const [candidate, setCandidate] = useState(""),
    [role, setRole] = useState("member");
  const [keys, setKeys] = useState([
    { name: "Automation", description: "Internal workflows", revoked: false },
  ]);
  const [keyName, setKeyName] = useState(""),
    [keyDescription, setKeyDescription] = useState(""),
    [permissions, setPermissions] = useState(new Set<string>()),
    [issued, setIssued] = useState(false),
    [revoke, setRevoke] = useState<number | null>(null);
  useEffect(() => {
    document.documentElement.dataset.ogTheme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  const toggle = (label: string, checked: boolean, onChange: (value: boolean) => void) => (
    <SettingsSwitch aria-label={label} checked={checked} onCheckedChange={onChange} />
  );
  const general: SettingItem[] = [
    {
      id: "name",
      title: "Workspace name",
      description: "The name people see in the workspace switcher.",
      icon: <Building2 />,
      summary: name,
      control: (
        <Input aria-label="Workspace name" value={name} onChange={(e) => setName(e.target.value)} />
      ),
    },
    {
      id: "voice",
      title: "Voice input",
      description: "Allow voice input in the chat composer for new sessions.",
      icon: <Mic />,
      summary: voice ? "On for new sessions" : "Off for new sessions",
      control: toggle("Voice input", voice, setVoice),
    },
    {
      id: "video",
      title: "Video generation",
      description: "Allow video generation for new sessions.",
      icon: <Video />,
      summary: video ? "On for new sessions" : "Off for new sessions",
      control: toggle("Video generation", video, setVideo),
    },
    {
      id: "portable",
      title: "Allow other providers (Codex only)",
      description:
        "Switch from Codex models to other providers mid-session. Off is recommended for better compaction.",
      icon: <Shrink />,
      summary: portable ? "Other providers allowed" : "Off · better compaction",
      control: toggle("Allow other providers (Codex only)", portable, setPortable),
    },
  ];
  const modelItems: SettingItem[] = [
    {
      id: "codex",
      title: "Codex",
      description: "Use your ChatGPT subscription. Manage accounts and the subscription source.",
      icon: <Cpu />,
      summary: "1 subscription · workspace source",
      control: (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Manage Codex subscription"
          onClick={() => setDialog("codex")}
        >
          <Check className="text-emerald-500" />
        </Button>
      ),
      detail: (
        <Button
          onClick={() => {
            setEditing(null);
            setDialog("codex");
          }}
        >
          Manage Codex subscription
        </Button>
      ),
    },
  ];
  const memberItems: SettingItem[] = members
    .filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(query.toLowerCase()))
    .map((m) => ({
      id: m.email,
      title: m.name + (m.self ? " (you)" : ""),
      description: m.email,
      icon: <Users />,
      summary: { admin: "Workspace admin", member: "Member", viewer: "Viewer" }[m.role] ?? m.role,
      control: (
        <Select
          aria-label={`Role for ${m.name}`}
          value={m.role}
          disabled={m.self}
          onChange={(e) =>
            setMembers((current) =>
              current.map((person) =>
                person.email === m.email ? { ...person, role: e.target.value } : person,
              ),
            )
          }
        >
          <option value="viewer">Viewer</option>
          <option value="member">Member</option>
          <option value="admin">Workspace admin</option>
        </Select>
      ),
    }));
  const keyItems: SettingItem[] = keys
    .filter((k) => k.name.toLowerCase().includes(query.toLowerCase()))
    .map((k) => ({
      id: k.name,
      title: k.name,
      description: `${k.description} · preview prefix`,
      icon: <KeyRound />,
      summary: k.revoked ? "Revoked" : "Active · workspace-scoped",
      control: (
        <Button
          variant="ghost"
          disabled={k.revoked}
          onClick={() => {
            setRevoke(keys.indexOf(k));
            setDialog("revoke");
          }}
        >
          {k.revoked ? "Revoked" : "Revoke"}
        </Button>
      ),
    }));
  const items =
    page === "general"
      ? general
      : page === "models"
        ? modelItems
        : page === "members"
          ? memberItems
          : keyItems;
  const selected = items.find((item) => item.id === editing);
  const selectedPage = pages.find((p) => p.id === page)!;
  const exportText = JSON.stringify(
    { favorites, notes, scope: "Settings visual preferences only; no real settings changed" },
    null,
    2,
  );
  function download() {
    const url = URL.createObjectURL(new Blob([exportText], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "settings-design-choices.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="settings-studio">
      <header className="studio-header">
        <div>
          <span className="eyebrow">DESIGN REVIEW / SETTINGS ONLY</span>
          <h1>One familiar language. Three different settings layouts.</h1>
          <p>Inspired by Capabilities’ smooth surfaces, not a redesign of Capabilities.</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <Sun /> : <Moon />}
        </Button>
      </header>
      <nav className="design-options" aria-label="Design alternatives">
        {designs.map((d) => (
          <button
            key={d.id}
            aria-pressed={variant === d.id}
            onClick={() => {
              setVariant(d.id);
              setEditing(null);
            }}
          >
            <strong>{d.name}</strong>
            <span>{d.description}</span>
          </button>
        ))}
      </nav>
      <div className={`settings-shell direction-${variant}`}>
        <aside>
          <div className="workspace-mark">
            <Building2 />
            <div>
              <strong>{name || "Workspace"}</strong>
              <span>Workspace settings</span>
            </div>
          </div>
          <nav aria-label="Settings pages">
            {pages.map((p) => (
              <button
                key={p.id}
                aria-current={page === p.id ? "page" : undefined}
                onClick={() => {
                  setPage(p.id);
                  setQuery("");
                  setEditing(null);
                }}
              >
                <p.icon />
                {p.label}
              </button>
            ))}
          </nav>
          <button className="organization-link" onClick={() => setDialog("organization")}>
            <Building2 />
            Organization settings
            <ArrowUpRight />
          </button>
          <p className="sidebar-note">
            Separate scopes. Existing roles and policy meanings stay unchanged.
          </p>
        </aside>
        <main>
          <div className="page-heading">
            <div>
              <span className="eyebrow">WORKSPACE</span>
              <h2>{selectedPage.label}</h2>
              <p>
                {page === "general"
                  ? "Make this space yours. Session defaults apply to new sessions."
                  : page === "models"
                    ? "Subscriptions available to this workspace."
                    : page === "members"
                      ? "People with access. Membership is drawn from your organization."
                      : "Workspace-scoped credentials for your integrations."}
              </p>
            </div>
            {page === "members" ? (
              <Button onClick={() => setDialog("member")}>
                <Plus />
                Add member
              </Button>
            ) : page === "keys" ? (
              <Button
                onClick={() => {
                  setIssued(false);
                  setDialog("key");
                }}
              >
                <Plus />
                Create API key
              </Button>
            ) : null}
          </div>
          {(page === "members" || page === "keys") && (
            <div className="settings-toolbar">
              <Input
                aria-label={`Search ${page}`}
                placeholder={page === "members" ? "Search people…" : "Search API keys…"}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <span>
                {items.length} {page === "members" ? "people" : "keys"}
              </span>
            </div>
          )}
          <SettingsPresentation
            variant={variant}
            items={items}
            onOpen={(item) => setEditing(item.id)}
          />
          {items.length === 0 && <p className="empty-state">No matching results.</p>}
          <p className="preview-boundary">
            Interactive component preview · sample data only.{" "}
            {page === "general"
              ? "Representative session defaults; advanced transcription and funding controls are not shown."
              : page === "models"
                ? "Codex details included; other providers and live authorization are outside this preview."
                : page === "members"
                  ? "Custom permissions and access-request queues are not shown."
                  : "Permission choices below use a limited sample grant."}{" "}
            No account changes are saved.
          </p>
        </main>
      </div>
      <footer className="review-bar">
        <div>
          <strong>Prefer this direction for {selectedPage.label}?</strong>
          <p>Choose per page, then export. Choices last only while this page stays open.</p>
        </div>
        <Button variant="secondary" onClick={() => setFavorites({ ...favorites, [page]: variant })}>
          <Star />
          {favorites[page] === variant ? "Selected" : "Choose this layout"}
        </Button>
        <Button variant="outline" onClick={() => setDialog("choices")}>
          <Download />
          Review choices
        </Button>
      </footer>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selected?.title}</DialogTitle>
            <DialogDescription>{selected?.description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 py-4">{selected?.detail ?? selected?.control}</div>
          <Button onClick={() => setEditing(null)}>Done</Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {dialog === "codex"
                ? "Codex subscription"
                : dialog === "member"
                  ? "Add workspace member"
                  : dialog === "key"
                    ? "Create API key"
                    : dialog === "revoke"
                      ? "Revoke API key?"
                      : dialog === "choices"
                        ? "Your settings design choices"
                        : "Organization settings"}
            </DialogTitle>
            <DialogDescription>
              {dialog === "choices"
                ? "Export your preferences before closing this page."
                : "Preview only. These controls never call a live settings API."}
            </DialogDescription>
          </DialogHeader>
          {dialog === "codex" && (
            <div className="grid gap-5">
              <CodexSourceSettings
                source={source}
                busy={false}
                onChange={(mode) =>
                  setSource({
                    ...source,
                    mode,
                    effectiveSource:
                      mode === "disabled"
                        ? "disabled"
                        : mode === "organization"
                          ? "organization"
                          : "workspace",
                  })
                }
              />
              <Button variant="ghost" onClick={() => setDialog("organization")}>
                Manage in organization settings <ArrowUpRight />
              </Button>
              <SubscriptionAccountRow
                provider="Codex"
                name={accountName}
                label={accountName}
                email="team@example.com"
                plan="Plus"
                selected
                disabled={source.effectiveSource !== "workspace"}
                selectionLabel="Use team subscription by default"
                group="sample-codex"
                expanded={expanded}
                onExpandedChange={setExpanded}
                onSelect={() => {}}
                onRename={setAccountName}
              >
                <div className="px-4 py-3">
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span>Use for new automatic turns</span>
                    {toggle("Use for new automatic turns", allocation, setAllocation)}
                  </div>
                  <p className="mt-2 text-xs text-fg-muted">
                    Pausing affects new automatic selections only.
                  </p>
                </div>
              </SubscriptionAccountRow>
              <Button variant="secondary" onClick={() => setDevice("waiting")}>
                <Plus />
                Connect another account
              </Button>
              {device !== "idle" && (
                <div className="grid gap-3">
                  <label className="grid gap-2 text-sm">
                    Preview authorization state
                    <Select value={device} onChange={(e) => setDevice(e.target.value)}>
                      <option value="waiting">Waiting for authorization</option>
                      <option value="expired">Code expired</option>
                      <option value="error">Verification failed</option>
                    </Select>
                  </label>
                  <p className="text-xs text-fg-muted">
                    Illustrative device code, not valid for sign-in. The real authorization link is
                    intentionally unavailable.
                  </p>
                  {device === "waiting" ? (
                    <SubscriptionDeviceCodePanel
                      provider="codex"
                      userCode="PREVIEW-CODE"
                      verificationUri=""
                    />
                  ) : (
                    <p role="alert">
                      {device === "expired"
                        ? "The code expired before it was authorized. Try again."
                        : "Failed to verify Codex authorization. Try again."}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          {dialog === "member" && (
            <div className="grid gap-4">
              <p className="text-sm">
                Choose an existing organization member. This does not send an invitation.
              </p>
              <label className="grid gap-2">
                Organization member
                <Select
                  aria-label="Organization member"
                  value={candidate}
                  onChange={(e) => setCandidate(e.target.value)}
                >
                  <option value="">Choose a person</option>
                  <option value="Grace Lee" disabled={members.some((m) => m.name === "Grace Lee")}>
                    Grace Lee · grace@example.com
                  </option>
                </Select>
              </label>
              <label className="grid gap-2">
                Workspace role
                <Select
                  aria-label="Workspace role"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                >
                  <option value="viewer">Viewer</option>
                  <option value="member">Member</option>
                  <option value="admin">Workspace admin</option>
                </Select>
              </label>
              <Button
                disabled={!candidate || members.some((m) => m.name === candidate)}
                onClick={() => {
                  setMembers([
                    ...members,
                    { name: candidate, email: "grace@example.com", role, self: false },
                  ]);
                  setCandidate("");
                  setDialog(null);
                }}
              >
                Add member to preview
              </Button>
            </div>
          )}
          {dialog === "key" &&
            (issued ? (
              <div className="grid gap-3">
                <p>No real key was issued. In production this is the one-time token display.</p>
                <code className="break-all">PREVIEW_ONLY_NOT_A_REAL_KEY</code>
              </div>
            ) : (
              <div className="grid gap-4">
                <label className="grid gap-2">
                  Name
                  <Input value={keyName} onChange={(e) => setKeyName(e.target.value)} />
                </label>
                <label className="grid gap-2">
                  Description
                  <Input
                    maxLength={500}
                    value={keyDescription}
                    onChange={(e) => setKeyDescription(e.target.value)}
                  />
                </label>
                <p className="text-xs text-fg-muted">
                  Sample grant: you cannot delegate workspace administration.
                </p>
                <PermissionGroupPicker
                  groups={[
                    { label: "Sessions", permissions: ["sessions:read", "sessions:create"] },
                    { label: "Workspace", permissions: ["workspace:read", "workspace:admin"] },
                  ]}
                  selected={permissions}
                  delegable={new Set(["sessions:read", "sessions:create", "workspace:read"])}
                  onToggle={(permission) =>
                    setPermissions((current) => {
                      const next = new Set(current);
                      if (next.has(permission)) next.delete(permission);
                      else next.add(permission);
                      return next;
                    })
                  }
                />
                <Button
                  disabled={
                    !keyName.trim() ||
                    !permissions.size ||
                    keys.some((k) => k.name === keyName.trim())
                  }
                  onClick={() => {
                    setKeys([
                      ...keys,
                      { name: keyName.trim(), description: keyDescription, revoked: false },
                    ]);
                    setIssued(true);
                    setKeyName("");
                    setKeyDescription("");
                    setPermissions(new Set());
                  }}
                >
                  Create preview key
                </Button>
              </div>
            ))}
          {dialog === "revoke" && (
            <div className="grid gap-4">
              <p>This disables the sample key in this preview only.</p>
              <Button
                variant="destructive"
                onClick={() => {
                  setKeys(keys.map((k, i) => (i === revoke ? { ...k, revoked: true } : k)));
                  setDialog(null);
                  setEditing(null);
                }}
              >
                Revoke preview key
              </Button>
            </div>
          )}
          {dialog === "organization" && (
            <p className="text-sm leading-6">
              The separate organization settings entry point is preserved here. Its destination is
              not redesigned in this study. Organization Knowledge and workspace Agent learning
              controls retain their current behavior; inheritance changes need a separate decision.
            </p>
          )}
          {dialog === "choices" && (
            <div className="grid gap-4">
              {pages.map((p) => (
                <div key={p.id} className="flex justify-between gap-4 text-sm">
                  <span>{p.label}</span>
                  <strong>
                    {designs.find((d) => d.id === favorites[p.id])?.name ?? "Not chosen"}
                  </strong>
                </div>
              ))}
              <label className="grid gap-2">
                Notes
                <textarea
                  className="rounded-lg border border-border p-3"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
              <Button onClick={download}>Download choices</Button>
              <textarea
                readOnly
                aria-label="Copyable choices"
                className="h-40 rounded-lg border border-border p-3 text-xs"
                value={exportText}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
