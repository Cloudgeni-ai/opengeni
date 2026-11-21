import {
  AppPackageFormatError,
  parseAppPackage,
  type AppPackageProblem,
  type AppPackageUpgradePlan,
} from "@opengeni/contracts";
import type { AppPackageInstallResponse } from "@opengeni/sdk";
import { UploadIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { useAppContext } from "../../app-context";
import { useNavigate } from "../../lib/navigation";
import { toast } from "../../lib/toast";
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
  hasDemoData: boolean;
};

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
    const { package: pkg } = parseAppPackage(json);
    const demo = pkg.demoData;
    const hasDemoData = Boolean(
      demo &&
      (Object.values(demo.records).some((records) => records.length > 0) ||
        Object.values(demo.sqlRows).some((rows) => rows.length > 0) ||
        (demo.files?.length ?? 0) > 0),
    );
    return {
      ok: true,
      chosen: { json: json as Record<string, unknown>, title: pkg.app.title, hasDemoData },
    };
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
 * The Apps list's "Install app": choose a package file, then install it as a
 * new app here and open it. Shown to people who can publish.
 */
export function InstallAppButton({ workspaceId }: { workspaceId: string }) {
  const { client } = useAppContext();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [chosen, setChosen] = useState<ChosenAppPackage | null>(null);
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
        Install app
      </Button>
      <InstallAppDialog
        workspaceId={workspaceId}
        chosen={chosen}
        onOpenChange={(open) => {
          if (!open) setChosen(null);
        }}
        onInstalled={(result) => {
          invalidateArtifactCatalog(client, workspaceId);
          const left = notInstalledSummary(result.notInstalled);
          if (left)
            toast.warning(`Installed “${result.app.title}”, with gaps`, { description: left });
          else toast(`Installed “${result.app.title}”`);
          void navigate({
            to: "/workspaces/$workspaceId/sites/$siteId",
            params: { workspaceId, siteId: result.app.id },
          });
        }}
      />
    </>
  );
}

/** Confirms a chosen package: its title, demo data if it has some, and Install. */
export function InstallAppDialog({
  workspaceId,
  chosen,
  onOpenChange,
  onInstalled,
}: {
  workspaceId: string;
  chosen: ChosenAppPackage | null;
  onOpenChange: (open: boolean) => void;
  onInstalled: (result: AppPackageInstallResponse) => void;
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
  return (
    <FormDialog
      open={chosen !== null}
      onOpenChange={onOpenChange}
      title="Install app"
      description={
        chosen
          ? `“${chosen.title}” is added to this workspace${
              chosen.hasDemoData && demoData ? " with its demo data" : " with empty data"
            }.`
          : undefined
      }
      submitLabel="Install"
      pendingLabel="Installing…"
      error={error}
      onSubmit={async () => {
        if (!chosen) return false;
        try {
          const result = await client.installAppPackage(workspaceId, {
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
    </FormDialog>
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

function names(list: readonly string[]): string {
  return list.length <= 3
    ? list.join(", ")
    : `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`;
}

/**
 * The plan of an upgrade as short lines, one per kind of change, for the
 * Upgrade dialog. Empty when the app already matches the package.
 */
export function upgradePlanLines(plan: AppPackageUpgradePlan): string[] {
  const lines: string[] = [];
  if (plan.version.changed) lines.push("New version of the app");
  const tools = [
    plan.tools.added.length > 0 ? `adds ${names(plan.tools.added.map((t) => t.toolName))}` : null,
    plan.tools.removed.length > 0
      ? `removes ${names(plan.tools.removed.map((t) => t.toolName))}`
      : null,
  ].filter(Boolean);
  if (tools.length > 0) lines.push(`Tools: ${tools.join("; ")}`);
  const collections = [
    plan.collections.added.length > 0 ? `adds ${names(plan.collections.added)}` : null,
    plan.collections.changed.length > 0 ? `changes ${names(plan.collections.changed)}` : null,
  ].filter(Boolean);
  if (collections.length > 0) lines.push(`Collections: ${collections.join("; ")}`);
  if (plan.migrations.new.length > 0) lines.push(`Database: runs ${names(plan.migrations.new)}`);
  const queries = [
    plan.queries.added.length > 0 ? `adds ${names(plan.queries.added)}` : null,
    plan.queries.changed.length > 0 ? `changes ${names(plan.queries.changed)}` : null,
    plan.queries.removed.length > 0 ? `removes ${names(plan.queries.removed)}` : null,
  ].filter(Boolean);
  if (queries.length > 0) lines.push(`Queries: ${queries.join("; ")}`);
  const syncs = [
    plan.syncs.added.length > 0 ? `adds ${names(plan.syncs.added)} (paused)` : null,
    plan.syncs.changed.length > 0 ? `changes ${names(plan.syncs.changed)}` : null,
  ].filter(Boolean);
  if (syncs.length > 0) lines.push(`Syncs: ${syncs.join("; ")}`);
  const kept = [...plan.collections.kept, ...plan.syncs.kept];
  if (lines.length > 0 && kept.length > 0)
    lines.push(`Keeps ${names(kept)}, which the package doesn't have`);
  return lines;
}

function problemText(problem: AppPackageProblem): string {
  return problem.name ? `${problem.name}: ${problem.reason}` : problem.reason;
}

type UpgradeState =
  | { phase: "planning"; chosen: ChosenAppPackage }
  | { phase: "ready"; chosen: ChosenAppPackage; plan: AppPackageUpgradePlan; key: string }
  | { phase: "failed"; chosen: ChosenAppPackage; error: string };

/**
 * The app's "Upgrade from package": choose a package file, see what the
 * upgrade changes (a dry run), and Upgrade. Changes that could hide or delete
 * existing data need an explicit confirm; conflicts can't be upgraded. The
 * app's data stays. Shown to the app's managers who can publish.
 */
export function useUpgradeApp(workspaceId: string, appId: string) {
  const { client } = useAppContext();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<UpgradeState | null>(null);
  // An embed's older client can't upgrade apps.
  if (typeof client.upgradeAppPackage !== "function") return null;
  const plan = async (chosen: ChosenAppPackage) => {
    setState({ phase: "planning", chosen });
    try {
      const result = await client.upgradeAppPackage(workspaceId, appId, {
        package: chosen.json,
        dryRun: true,
      });
      setState({ phase: "ready", chosen, plan: result.plan, key: crypto.randomUUID() });
    } catch (error) {
      setState({
        phase: "failed",
        chosen,
        error: userErrorText(error, "Couldn't read the upgrade."),
      });
    }
  };
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
            if (read.ok) void plan(read.chosen);
            else toast.error("Couldn't read the app package", { description: read.error });
          });
        }}
      />
      <UpgradeAppDialog
        state={state}
        onOpenChange={(open) => {
          if (!open) setState(null);
        }}
        onUpgrade={async (allowDestructive) => {
          if (state?.phase !== "ready") return;
          const result = await client.upgradeAppPackage(workspaceId, appId, {
            package: state.chosen.json,
            allowDestructive,
            idempotencyKey: state.key,
          });
          invalidateArtifactCatalog(client, workspaceId);
          const left = notInstalledSummary(result.notUpgraded);
          if (left) toast.warning("Upgraded, with gaps", { description: left });
          else toast("App upgraded");
        }}
      />
    </>
  );
  return { open: () => fileInput.current?.click(), element };
}

/** The upgrade's plan and its one Upgrade button. */
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
  const destructive = plan?.destructive ?? [];
  const conflicts = plan?.conflicts ?? [];
  const nothing = plan !== null && lines.length === 0;
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
            <Notice tone="waiting" title="Could hide or delete existing data">
              <ul className="flex flex-col gap-1">
                {destructive.map((entry) => (
                  <li key={problemText(entry)}>{problemText(entry)}</li>
                ))}
              </ul>
            </Notice>
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
      title="Upgrade from package"
      description={state ? `From “${state.chosen.title}”. The app's data stays.` : undefined}
      submitLabel="Upgrade"
      pendingLabel="Upgrading…"
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
