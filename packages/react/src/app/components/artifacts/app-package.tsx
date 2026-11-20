import {
  AppPackageFormatError,
  parseAppPackage,
  type AppPackageProblem,
} from "@opengeni/contracts";
import type { AppPackageInstallResponse } from "@opengeni/sdk";
import { UploadIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useAppContext } from "../../app-context";
import { useNavigate } from "../../lib/navigation";
import { toast } from "../../lib/toast";
import { invalidateArtifactCatalog } from "../../lib/use-artifact-catalog";
import { userErrorText } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import { FormDialog } from "../../../ui/form-dialog";
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
        Object.values(demo.sqlRows).some((rows) => rows.length > 0)),
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
