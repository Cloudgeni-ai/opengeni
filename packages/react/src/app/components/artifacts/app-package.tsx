import {
  AppPackageFormatError,
  parseAppPackage,
  type AppPackageProblem,
  type AppPackageUpgradePlan,
  type AppPackageUpgradeRequest,
} from "@opengeni/contracts";
import type { AppPackageInstallResponse, AppPackageStatus } from "@opengeni/sdk";
import { UploadIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { useAppContext } from "../../app-context";
import { useNavigate } from "../../lib/navigation";
import { toast } from "../../lib/toast";
import { invalidateAppPackageStatus } from "../../lib/use-app-package-status";
import { invalidateArtifactCatalog } from "../../lib/use-artifact-catalog";
import { userErrorText } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import { FormDialog } from "../../../ui/form-dialog";
import { Notice } from "../../../ui/notice";
import { SettingRow } from "../../../ui/setting-row";
import { Switch } from "../../../ui/switch";

/** A package file read in the browser, before it is installed. */
export type ChosenAppPackage = {
  /** The file's JSON, sent as is: the server validates it again. */
  json: Record<string, unknown>;
  title: string;
  /** The app's page, for a preview. */
  html: string;
  hasDemoData: boolean;
  packageVersion: string | null;
  /** The Skills it turns on, each with its one line of what it lets agents do. */
  skills: Array<{ name: string; description: string }>;
  /** Automations it adds, switched off. */
  automations: Array<{ name: string }>;
};

/** A package's JSON as the install dialog shows it; throws when it isn't one. */
export function chosenAppPackage(json: unknown): ChosenAppPackage {
  const { package: pkg } = parseAppPackage(json);
  const demo = pkg.demoData;
  const hasDemoData = Boolean(
    demo &&
    (Object.values(demo.records).some((records) => records.length > 0) ||
      Object.values(demo.sqlRows).some((rows) => rows.length > 0) ||
      (demo.files?.length ?? 0) > 0),
  );
  return {
    json: json as Record<string, unknown>,
    title: pkg.app.title,
    html: pkg.app.html,
    hasDemoData,
    packageVersion: pkg.packageVersion ?? null,
    skills: (pkg.skills ?? []).map((skill) => ({
      name: skill.name,
      description: firstSentence(skill.description),
    })),
    automations: (pkg.automations ?? []).map((automation) => ({ name: automation.name })),
  };
}

/** A Skill's one-line "what it does": the first sentence of its description. */
export function firstSentence(text: string): string {
  const match = /^.+?[.!?](?=\s|$)/s.exec(text.trim());
  return (match?.[0] ?? text).trim();
}

function names(list: readonly string[]): string {
  return list.length <= 3
    ? list.join(", ")
    : `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`;
}

function changeLine(label: string, parts: Array<string | null>): string | null {
  const shown = parts.filter((part): part is string => Boolean(part));
  return shown.length > 0 ? `${label}: ${shown.join("; ")}` : null;
}

/**
 * The plan of an upgrade as short lines, one per kind of change, for the
 * Upgrade dialog. Empty when the app already matches the package.
 */
export function upgradePlanLines(plan: AppPackageUpgradePlan): string[] {
  const lines: Array<string | null> = [];
  const version = plan.packageVersion;
  if (version && version.current !== version.next && version.next)
    lines.push(`Version ${version.current ?? "without a number"} → ${version.next}`);
  else if (plan.version.changed) lines.push("New version of the app");
  lines.push(
    changeLine("Tools", [
      plan.tools.added.length > 0 ? `adds ${names(plan.tools.added.map((t) => t.toolName))}` : null,
      plan.tools.removed.length > 0
        ? `removes ${names(plan.tools.removed.map((t) => t.toolName))}`
        : null,
    ]),
    changeLine("Collections", [
      plan.collections.added.length > 0 ? `adds ${names(plan.collections.added)}` : null,
      plan.collections.changed.length > 0 ? `changes ${names(plan.collections.changed)}` : null,
    ]),
    plan.migrations.new.length > 0 ? `Database: runs ${names(plan.migrations.new)}` : null,
    changeLine("Queries", [
      plan.queries.added.length > 0 ? `adds ${names(plan.queries.added)}` : null,
      plan.queries.changed.length > 0 ? `changes ${names(plan.queries.changed)}` : null,
      plan.queries.removed.length > 0 ? `removes ${names(plan.queries.removed)}` : null,
    ]),
    changeLine("Syncs", [
      plan.syncs.added.length > 0 ? `adds ${names(plan.syncs.added)} (paused)` : null,
      plan.syncs.changed.length > 0 ? `changes ${names(plan.syncs.changed)}` : null,
    ]),
    changeLine("Skills", [
      plan.skills && plan.skills.added.length > 0 ? `adds ${names(plan.skills.added)}` : null,
      plan.skills && plan.skills.changed.length > 0
        ? `updates ${names(plan.skills.changed)}`
        : null,
    ]),
    plan.automations && plan.automations.added.length > 0
      ? `Automations: adds ${names(plan.automations.added)} (switched off)`
      : null,
  );
  const changes = lines.filter((line): line is string => Boolean(line));
  const kept = [...plan.collections.kept, ...plan.syncs.kept, ...(plan.skills?.kept ?? [])];
  if (changes.length > 0 && kept.length > 0)
    changes.push(`Keeps ${names(kept)}, which the package doesn't have`);
  return changes;
}

/** What the upgrade replaces that was changed here, as one sentence; null when nothing. */
export function localChangesText(plan: AppPackageUpgradePlan): string | null {
  const local = plan.localChanges;
  if (!local || (!local.app && local.skills.length === 0)) return null;
  const parts = [
    local.app ? "the app" : null,
    local.skills.length > 0
      ? `${local.skills.length === 1 ? "the Skill" : "the Skills"} ${names(local.skills)}`
      : null,
  ].filter(Boolean);
  return `Your changes to ${parts.join(" and ")} are replaced.`;
}

function problemText(problem: AppPackageProblem): string {
  return problem.name ? `${problem.name}: ${problem.reason}` : problem.reason;
}

/** Where an upgrade comes from: a chosen file, a ready-made update, or the previous version. */
export type UpgradeSource =
  | { kind: "file"; title: string; request: { package: Record<string, unknown> } }
  | { kind: "update"; title: string; version: string; request: { package: unknown } }
  | { kind: "previous"; title: string; version: string | null; request: { previous: string } };

export type UpgradeState =
  | { phase: "planning"; source: UpgradeSource }
  | { phase: "ready"; source: UpgradeSource; plan: AppPackageUpgradePlan; key: string }
  | { phase: "failed"; source: UpgradeSource; error: string };

const UPGRADE_COPY: Record<
  UpgradeSource["kind"],
  { title: string; submit: string; pending: string; done: string }
> = {
  file: {
    title: "Upgrade from package",
    submit: "Upgrade",
    pending: "Upgrading…",
    done: "App upgraded",
  },
  update: { title: "Update app", submit: "Update", pending: "Updating…", done: "App updated" },
  previous: {
    title: "Restore previous version",
    submit: "Restore",
    pending: "Restoring…",
    done: "Previous version restored",
  },
};

function upgradeDescription(source: UpgradeSource): string {
  if (source.kind === "file") return `From “${source.title}”. The app's data stays.`;
  if (source.kind === "update") return `To version ${source.version}. The app's data stays.`;
  return `${
    source.version ? `Back to version ${source.version}` : "Back to before the last update"
  }. The app's data stays, and so do Skills and automations added since.`;
}

/**
 * Plans and applies an upgrade of one app: from a package file, a ready-made
 * update, or back to the previous version, always showing the dry-run plan
 * first. Returns the dialog and a function to start one.
 */
export function useAppUpgrade(workspaceId: string) {
  const { client } = useAppContext();
  const [target, setTarget] = useState<{ appId: string; state: UpgradeState } | null>(null);
  // An embed's older client can't upgrade apps.
  if (typeof client.upgradeAppPackage !== "function") return null;
  const start = async (appId: string, source: UpgradeSource) => {
    setTarget({ appId, state: { phase: "planning", source } });
    try {
      const result = await client.upgradeAppPackage(workspaceId, appId, {
        ...source.request,
        dryRun: true,
      } as AppPackageUpgradeRequest);
      setTarget({
        appId,
        state: { phase: "ready", source, plan: result.plan, key: crypto.randomUUID() },
      });
    } catch (error) {
      setTarget({
        appId,
        state: {
          phase: "failed",
          source,
          error: userErrorText(error, "Couldn't read the upgrade."),
        },
      });
    }
  };
  const element = (
    <UpgradeAppDialog
      state={target?.state ?? null}
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
      onUpgrade={async (allowDestructive) => {
        if (!target || target.state.phase !== "ready") return;
        const { source, key } = target.state;
        const result = await client.upgradeAppPackage(workspaceId, target.appId, {
          ...source.request,
          allowDestructive,
          idempotencyKey: key,
        } as AppPackageUpgradeRequest);
        invalidateArtifactCatalog(client, workspaceId);
        invalidateAppPackageStatus();
        const left = notInstalledSummary(result.notUpgraded);
        const done = UPGRADE_COPY[source.kind].done;
        if (left) toast.warning(`${done}, with gaps`, { description: left });
        else toast(done);
      }}
    />
  );
  return { start, element };
}

/**
 * An installed app's update and restore: "Update to x" from its ready-made
 * app's latest package, and "Restore previous version" from its state before
 * the last upgrade. Both go through the upgrade's plan.
 */
export function useAppPackageActions(workspaceId: string) {
  const { client } = useAppContext();
  const upgrade = useAppUpgrade(workspaceId);
  if (!upgrade) return null;
  return {
    element: upgrade.element,
    update: async (status: AppPackageStatus) => {
      if (!status.update) return;
      const { templateKey, packageVersion } = status.update;
      try {
        const templates = await client.listAppTemplates(workspaceId);
        const template = templates.find((entry) => entry.key === templateKey);
        if (!template) throw new Error("This update is no longer offered.");
        await upgrade.start(status.appId, {
          kind: "update",
          title: status.title,
          version: packageVersion,
          request: { package: template.package },
        });
      } catch (error) {
        toast.error("Couldn't read the update", { description: userErrorText(error) });
      }
    },
    restore: (status: AppPackageStatus) => {
      if (!status.previous) return;
      void upgrade.start(status.appId, {
        kind: "previous",
        title: status.title,
        version: status.previous.packageVersion,
        // This saved state, so the plan and a retry apply the same one.
        request: { previous: status.previous.id },
      });
    },
  };
}

/**
 * The app's "Upgrade from package": choose a package file, see what the
 * upgrade changes (a dry run), and Upgrade. Changes that could hide or delete
 * existing data need an explicit confirm; conflicts can't be upgraded. The
 * app's data stays. Shown to the app's managers who can publish.
 */
export function useUpgradeApp(workspaceId: string, appId: string) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const upgrade = useAppUpgrade(workspaceId);
  if (!upgrade) return null;
  const element = (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        data-upgrade-app-file=""
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void readAppPackageFile(file).then((read) => {
            if (read.ok)
              void upgrade.start(appId, {
                kind: "file",
                title: read.chosen.title,
                request: { package: read.chosen.json },
              });
            else toast.error("Couldn't read the app package", { description: read.error });
          });
        }}
      />
      {upgrade.element}
    </>
  );
  return { open: () => fileInput.current?.click(), element };
}

/** The upgrade's plan and its one button. */
export function UpgradeAppDialog({
  state,
  onOpenChange,
  onUpgrade,
}: {
  state: UpgradeState | null;
  onOpenChange: (open: boolean) => void;
  onUpgrade: (allowDestructive: boolean) => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<UpgradeState | null>(null);
  if (state !== shown) {
    setShown(state);
    setConfirmed(false);
    setError(null);
  }
  const plan = state?.phase === "ready" ? state.plan : null;
  const lines = plan ? upgradePlanLines(plan) : [];
  const localChanges = plan ? localChangesText(plan) : null;
  const destructive = plan?.destructive ?? [];
  // Another app's package is confirmed with the same switch, under its own note.
  const otherApp = destructive.find((entry) => entry.part === "package");
  const risky = destructive.filter((entry) => entry.part !== "package");
  const conflicts = plan?.conflicts ?? [];
  const nothing = plan !== null && lines.length === 0;
  const copy = UPGRADE_COPY[state?.source.kind ?? "file"];
  let body: ReactNode = null;
  if (state?.phase === "planning") body = <p className="text-sm text-fg-muted">Comparing…</p>;
  else if (state?.phase === "failed") body = <Notice tone="failed">{state.error}</Notice>;
  else if (plan)
    body = (
      <div className="flex flex-col gap-4" data-upgrade-plan="">
        {nothing ? (
          <p className="text-sm text-fg-muted">This app already matches the package.</p>
        ) : (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {localChanges && !nothing ? (
          <Notice tone="waiting" title="Replaces your changes" data-upgrade-local-changes="">
            {state?.source.kind === "previous"
              ? localChanges
              : `${localChanges} You can go back with Restore previous version.`}
          </Notice>
        ) : null}
        {conflicts.length > 0 ? (
          <Notice tone="failed" title="Can't upgrade">
            <ul className="flex flex-col gap-1">
              {conflicts.map((entry) => (
                <li key={problemText(entry)}>{problemText(entry)}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {conflicts.length === 0 && destructive.length > 0 ? (
          <>
            {otherApp ? <Notice tone="waiting">{otherApp.reason}</Notice> : null}
            {risky.length > 0 ? (
              <Notice tone="waiting" title="Could hide or delete existing data">
                <ul className="flex flex-col gap-1">
                  {risky.map((entry) => (
                    <li key={problemText(entry)}>{problemText(entry)}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}
            <SettingRow
              label="Apply these changes"
              control={
                <Switch
                  checked={confirmed}
                  onCheckedChange={setConfirmed}
                  aria-label="Apply these changes"
                />
              }
            />
          </>
        ) : null}
        {plan.problems.length > 0 ? (
          <ul className="flex flex-col gap-1 text-xs text-fg-muted">
            {plan.problems.map((entry) => (
              <li key={problemText(entry)}>{problemText(entry)}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  return (
    <FormDialog
      open={state !== null}
      onOpenChange={onOpenChange}
      title={copy.title}
      description={state ? upgradeDescription(state.source) : undefined}
      submitLabel={copy.submit}
      pendingLabel={copy.pending}
      submitDisabled={
        !plan || nothing || conflicts.length > 0 || (destructive.length > 0 && !confirmed)
      }
      error={error}
      onSubmit={async () => {
        try {
          await onUpgrade(destructive.length > 0 && confirmed);
        } catch (cause) {
          setError(userErrorText(cause, "Couldn't upgrade the app."));
          return false;
        }
      }}
      onSubmitted={() => onOpenChange(false)}
    >
      {body}
    </FormDialog>
  );
}
/** Reads a chosen package file; a message for the person when it isn't one. */
export async function readAppPackageFile(
  file: Pick<File, "text">,
): Promise<{ ok: true; chosen: ChosenAppPackage } | { ok: false; error: string }> {
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    return { ok: false, error: "This file isn't an app package." };
  }
  try {
    return { ok: true, chosen: chosenAppPackage(json) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof AppPackageFormatError ? error.message : "This file isn't an app package.",
    };
  }
}

/** One line for what an install left out, or null when everything installed. */
export function notInstalledSummary(problems: readonly AppPackageProblem[]): string | null {
  if (problems.length === 0) return null;
  const first = problems[0]!;
  const lead = first.name ? `${first.name}: ${first.reason}` : first.reason;
  return problems.length === 1 ? lead : `${lead} (and ${problems.length - 1} more)`;
}

/**
 * The Apps page's "Install from file": choose a package file, then install it
 * as a new app here and open it. Shown to people who can publish.
 */
export function InstallAppButton({ workspaceId }: { workspaceId: string }) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [chosen, setChosen] = useState<ChosenAppPackage | null>(null);
  const onInstalled = useOpenInstalledApp(workspaceId);
  const { client } = useAppContext();
  // An embed's older client can't install packages.
  if (typeof client.installAppPackage !== "function") return null;
  return (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        data-install-app-file=""
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void readAppPackageFile(file).then((read) => {
            if (read.ok) setChosen(read.chosen);
            else toast.error("Couldn't read the app package", { description: read.error });
          });
        }}
      />
      <Button
        type="button"
        variant="outline"
        className="pointer-coarse:h-11"
        onClick={() => fileInput.current?.click()}
      >
        <UploadIcon aria-hidden="true" />
        Install from file
      </Button>
      <InstallAppDialog
        workspaceId={workspaceId}
        chosen={chosen}
        onOpenChange={(open) => {
          if (!open) setChosen(null);
        }}
        onInstalled={onInstalled}
      />
    </>
  );
}

/** After an install: refresh the lists, say what was left out, open the app. */
export function useOpenInstalledApp(workspaceId: string) {
  const { client } = useAppContext();
  const navigate = useNavigate();
  return (result: AppPackageInstallResponse) => {
    invalidateArtifactCatalog(client, workspaceId);
    invalidateAppPackageStatus();
    const left = notInstalledSummary(result.notInstalled);
    if (left) toast.warning(`Installed “${result.app.title}”, with gaps`, { description: left });
    else if (!result.replayed) toast(`Installed “${result.app.title}”`);
    void navigate({
      to: "/workspaces/$workspaceId/sites/$siteId",
      params: { workspaceId, siteId: result.app.id },
    });
  };
}

/**
 * Confirms a package before it's installed: the app, the Skills it turns on
 * (each with what it lets agents do), automations it adds switched off,
 * demo data if it has some, and one Install button.
 */
export function InstallAppDialog({
  workspaceId,
  chosen,
  onOpenChange,
  onInstalled,
  install,
  about,
  preview,
}: {
  workspaceId: string;
  chosen: ChosenAppPackage | null;
  onOpenChange: (open: boolean) => void;
  onInstalled: (result: AppPackageInstallResponse) => void;
  /** Installs it another way (a ready-made app's own key); a package file by default. */
  install?:
    | ((
        chosen: ChosenAppPackage,
        demoData: boolean | undefined,
      ) => Promise<AppPackageInstallResponse>)
    | undefined;
  /** What the app is, in a paragraph (a ready-made app's description). */
  about?: string | undefined;
  /** How the app looks, shown before anything is installed. */
  preview?: ReactNode | undefined;
}) {
  const { client } = useAppContext();
  const [demoData, setDemoData] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // One key per chosen file: a repeated submit opens the same app.
  const [key, setKey] = useState<{ for: ChosenAppPackage | null; value: string }>({
    for: null,
    value: "",
  });
  if (chosen && key.for !== chosen) {
    setKey({ for: chosen, value: crypto.randomUUID() });
    setDemoData(true);
    setError(null);
  }
  const adds = chosen
    ? chosen.skills.length > 0
      ? "Adds the app and its Skills for agents in this workspace."
      : "Adds the app to this workspace."
    : undefined;
  return (
    <FormDialog
      open={chosen !== null}
      onOpenChange={onOpenChange}
      size={preview ? "lg" : "md"}
      title={chosen ? (about ? chosen.title : `Install ${chosen.title}`) : "Install app"}
      description={about ?? adds}
      submitLabel="Install"
      pendingLabel="Installing…"
      error={error}
      onSubmit={async () => {
        if (!chosen) return false;
        try {
          const result = install
            ? await install(chosen, chosen.hasDemoData ? demoData : undefined)
            : await client.installAppPackage(workspaceId, {
                package: chosen.json,
                ...(chosen.hasDemoData ? { demoData } : {}),
                idempotencyKey: key.value,
              });
          onInstalled(result);
        } catch (cause) {
          setError(userErrorText(cause, "Couldn't install the app."));
          return false;
        }
      }}
      onSubmitted={() => onOpenChange(false)}
    >
      <div className="flex flex-col gap-4">
        {preview}
        {about ? <p className="text-sm text-fg-muted">{adds}</p> : null}
        {chosen && chosen.skills.length > 0 ? (
          <PackageContentsList
            label="Skills"
            entries={chosen.skills.map((skill) => ({
              name: skill.name,
              detail: skill.description,
            }))}
          />
        ) : null}
        {chosen && chosen.automations.length > 0 ? (
          <PackageContentsList
            label="Automations, added switched off"
            entries={chosen.automations.map((automation) => ({ name: automation.name }))}
          />
        ) : null}
        {chosen?.hasDemoData ? (
          <SettingRow
            label="Include demo data"
            control={
              <Switch
                checked={demoData}
                onCheckedChange={setDemoData}
                aria-label="Include demo data"
              />
            }
          />
        ) : null}
      </div>
    </FormDialog>
  );
}

function PackageContentsList({
  label,
  entries,
}: {
  label: string;
  entries: Array<{ name: string; detail?: string | undefined }>;
}) {
  return (
    <section className="flex flex-col gap-1.5" aria-label={label} data-package-contents="">
      <h3 className="text-xs font-medium text-fg-muted">{label}</h3>
      <ul className="flex flex-col gap-1.5 text-sm">
        {entries.map((entry) => (
          <li key={entry.name} className="min-w-0">
            <span className="font-medium">{entry.name}</span>
            {entry.detail ? <span className="text-fg-muted"> · {entry.detail}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * "Export app": downloads one package file of the app's current version
 * (no data). Its managers only; the server says why it refuses anyone else.
 */
export function useExportApp(workspaceId: string) {
  const { client } = useAppContext();
  const [busy, setBusy] = useState(false);
  if (typeof client.exportAppPackage !== "function") return null;
  return {
    busy,
    run: async (appId: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const exported = await client.exportAppPackage(workspaceId, appId);
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(exported.package, null, 2)], { type: "application/json" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = exported.filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
      } catch (error) {
        toast.error("Couldn't export the app", { description: userErrorText(error) });
      } finally {
        setBusy(false);
      }
    },
  };
}
