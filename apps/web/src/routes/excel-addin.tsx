// "Opengeni in Excel": how to add the Excel add-in from this deployment, for
// Excel on the web, Mac, Windows or a whole Microsoft 365 organization.
//
// PUBLIC like `/reset-password`: an agent or a colleague can send the link to
// someone who isn't signed in, so `RootRouteComponent` renders this route ahead
// of the auth gate and WITHOUT the app context. Nothing here may call
// `useAppContext`.
import { DownloadIcon, SheetIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  MAC_EXCEL_DOCUMENTS,
  excelManifestUrl,
  excelPlatformFor,
  macInstallCommand,
  windowsInstallCommand,
  type ExcelPlatform,
} from "@/lib/excel-addin";
import { Button } from "@opengeni/react/ui/button";
import { CopyField } from "@opengeni/react/ui/copy-field";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";

const PLATFORMS: readonly { value: ExcelPlatform; label: string }[] = [
  { value: "web", label: "Web" },
  { value: "mac", label: "Mac" },
  { value: "windows", label: "Windows" },
  { value: "organization", label: "Admin" },
];

function Steps(props: { children: ReactNode }) {
  return <ol className="flex flex-col gap-4">{props.children}</ol>;
}

function Step(props: { n: number; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 text-xs font-medium text-fg-muted tabular-nums"
        aria-hidden="true"
      >
        {props.n}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-sm text-fg">{props.title}</p>
        {props.children ? <div className="mt-2">{props.children}</div> : null}
      </div>
    </li>
  );
}

function Menu(props: { children: ReactNode }) {
  return <span className="font-medium text-fg">{props.children}</span>;
}

/** The same install as one command, for people who would rather paste it. */
function CommandAlternative(props: {
  label: string;
  shell: string;
  value: string;
  replaces: string;
  note?: string;
}) {
  return (
    <li className="list-none">
      <details className="group rounded-lg border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm text-fg-subtle select-none group-open:mb-2">
          Prefer {props.shell}? One command instead of {props.replaces}.
        </summary>
        <CopyField variant="field" wrap label={props.label} value={props.value} />
        {props.note ? <p className="mt-2 text-xs text-fg-subtle">{props.note}</p> : null}
      </details>
    </li>
  );
}

function SignInStep(props: { n: number }) {
  return (
    <Step n={props.n} title="Sign in to Opengeni in the pane. It stays signed in after that." />
  );
}

export function ExcelAddinRoute() {
  const origin = window.location.origin;
  const manifestUrl = excelManifestUrl(origin);
  const [platform, setPlatform] = useState<ExcelPlatform>(() =>
    excelPlatformFor(navigator.userAgent),
  );
  const download = (
    <Button asChild variant="outline" size="sm">
      <a href={manifestUrl} download="opengeni-excel.xml">
        <DownloadIcon />
        Download opengeni-excel.xml
      </a>
    </Button>
  );

  return (
    <section className="og-page-glow flex flex-1 justify-center overflow-y-auto px-4 py-10 sm:py-16">
      <div className="w-full max-w-xl">
        <div className="mb-6 flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <SheetIcon className="size-5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold">Opengeni in Excel</h1>
            <p className="mt-1 text-sm text-fg-subtle">
              Chat with your agents beside your spreadsheet. They read and change the open workbook
              as you watch, and any Opengeni chat can work in it while the pane is open.
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-surface p-5 sm:p-6">
          <SegmentedControl
            aria-label="Where you use Excel"
            options={PLATFORMS}
            value={platform}
            onValueChange={setPlatform}
            fullWidth
            className="mb-5"
          />

          {platform === "web" ? (
            <Steps>
              <Step n={1} title="Download the add-in file.">
                {download}
              </Step>
              <Step
                n={2}
                title={
                  <>
                    In Excel on the web, open a workbook and choose <Menu>Home › Add-ins</Menu>,
                    then <Menu>Advanced</Menu> (<Menu>More Add-ins</Menu> in some versions).
                  </>
                }
              />
              <Step
                n={3}
                title={
                  <>
                    Choose <Menu>Upload My Add-in</Menu>, pick the file and select{" "}
                    <Menu>Upload</Menu>. The Opengeni pane opens.
                  </>
                }
              />
              <SignInStep n={4} />
            </Steps>
          ) : platform === "mac" ? (
            <Steps>
              <Step n={1} title="Download the add-in file.">
                {download}
              </Step>
              <Step
                n={2}
                title={
                  <>
                    In Finder, choose <Menu>Go › Go to Folder</Menu>, paste this and press Return.
                  </>
                }
              >
                <CopyField variant="field" label="Excel folder" value={MAC_EXCEL_DOCUMENTS} />
              </Step>
              <Step
                n={3}
                title={
                  <>
                    Open the <Menu>wef</Menu> folder there (make a new folder named <Menu>wef</Menu>{" "}
                    if there isn't one) and drag the downloaded file into it.
                  </>
                }
              />
              <Step n={4} title="Quit Excel and open it again." />
              <Step
                n={5}
                title={
                  <>
                    Choose <Menu>Home › Add-ins</Menu> and pick <Menu>Opengeni</Menu> under
                    Developer Add-ins. After that it has its own button on the Home tab.
                  </>
                }
              />
              <SignInStep n={6} />
              <CommandAlternative
                label="Mac install command"
                shell="Terminal"
                value={macInstallCommand(manifestUrl)}
                replaces="steps 1 to 3"
              />
            </Steps>
          ) : platform === "windows" ? (
            <Steps>
              <Step n={1} title="Download the add-in file.">
                {download}
              </Step>
              <Step
                n={2}
                title={
                  <>
                    Make a folder for it, for example <Menu>Excel add-ins</Menu> in Documents, and
                    move the file there.
                  </>
                }
              />
              <Step
                n={3}
                title={
                  <>
                    Right-click the folder and choose <Menu>Properties › Sharing › Share</Menu>,
                    then <Menu>Share</Menu> with just yourself. Copy the network path it shows, like{" "}
                    <Menu>\\YOUR-PC\Excel add-ins</Menu>.
                  </>
                }
              />
              <Step
                n={4}
                title={
                  <>
                    In Excel, choose{" "}
                    <Menu>
                      File › Options › Trust Center › Trust Center Settings › Trusted Add-in
                      Catalogs
                    </Menu>
                    , paste the path as the Catalog Url, choose <Menu>Add catalog</Menu>, tick{" "}
                    <Menu>Show in Menu</Menu> and select <Menu>OK</Menu>.
                  </>
                }
              />
              <Step n={5} title="Close every Excel window and open Excel again." />
              <Step
                n={6}
                title={
                  <>
                    Choose <Menu>Home › Add-ins › Advanced</Menu> (<Menu>More Add-ins</Menu> in some
                    versions), then <Menu>Shared Folder</Menu>, pick <Menu>Opengeni</Menu> and
                    select <Menu>Add</Menu>.
                  </>
                }
              />
              <SignInStep n={7} />
              <CommandAlternative
                label="Windows install command"
                shell="PowerShell"
                value={windowsInstallCommand(manifestUrl)}
                replaces="steps 1 to 4"
                note="Opengeni then shows under Developer Add-ins in Home › Add-ins, not Shared Folder."
              />
            </Steps>
          ) : (
            <>
              <p className="mb-4 text-sm text-fg-subtle">
                A Microsoft 365 admin can add Opengeni for everyone at once, in Excel on the web,
                Windows and Mac, with nothing to install per person.
              </p>
              <Steps>
                <Step
                  n={1}
                  title={
                    <>
                      In the Microsoft 365 admin center, open{" "}
                      <Menu>Settings › Integrated apps</Menu> and choose{" "}
                      <Menu>Upload custom apps</Menu>.
                    </>
                  }
                />
                <Step
                  n={2}
                  title={
                    <>
                      Choose <Menu>Office Add-in</Menu>, then{" "}
                      <Menu>Provide link to the manifest file</Menu>, and paste this link.
                    </>
                  }
                >
                  <CopyField variant="field" label="manifest link" value={manifestUrl} />
                </Step>
                <Step
                  n={3}
                  title="Pick who gets it and deploy. Opengeni appears on Excel's Home tab, usually within a few hours."
                />
              </Steps>
            </>
          )}
        </div>

        <p className="mt-4 px-1 text-xs text-fg-subtle">
          No computer needs to be connected to Opengeni: the pane signs in to your account, and your
          agents work in the workbook while it is open.
        </p>
      </div>
    </section>
  );
}
