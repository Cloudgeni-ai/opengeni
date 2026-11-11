// The Excel add-in manifest (Office's XML format): a task pane served from the
// product's own origin, opened from a button on the Home tab. Serve it from a
// URL people can download, such as `/office/manifest.xml`.

export type OfficeAddinManifestOptions = {
  /** A GUID that stays the same for this add-in forever; `officeAddinId` derives one. */
  id: string;
  /** The add-in's name in Excel: the Home tab button, its group and the add-in list. */
  name: string;
  /** One sentence for Excel's add-in list. */
  description: string;
  /** The Home tab button's tooltip. Defaults to the description. */
  tooltip?: string;
  /** Defaults to the name. */
  providerName?: string;
  /** Four-part version, such as "1.0.0.0". Raise it when the manifest changes. */
  version?: string;
  /** The origin that serves the pane, its pages and icons, such as "https://app.example.com". */
  origin: string;
  /** The pane's page. Defaults to "/office/". */
  taskpanePath?: string;
  /** A page that loads office.js and nothing else. Defaults to "/office/commands.html". */
  commandsPath?: string;
  /** PNG icon paths by size. Default to "/office/icon-<size>.png". */
  icons?: Partial<Record<16 | 32 | 64 | 80, string>>;
  /** Defaults to the origin's root. */
  supportUrl?: string;
  /** Other origins the pane may navigate to, such as a sign-in provider. */
  appDomains?: readonly string[];
};

export const OFFICE_MANIFEST_PATH = "/office/manifest.xml";

function xml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/** A stable version-5-style GUID derived from `seed`, such as the serving origin. */
export async function officeAddinId(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The manifest XML for an Excel task-pane add-in. */
export function officeAddinManifest(options: OfficeAddinManifestOptions): string {
  const origin = options.origin.replace(/\/+$/u, "");
  const at = (path: string) => xml(new URL(path, `${origin}/`).toString());
  const icon = (size: 16 | 32 | 64 | 80) => at(options.icons?.[size] ?? `/office/icon-${size}.png`);
  const taskpane = at(options.taskpanePath ?? "/office/");
  const name = xml(options.name);
  const domains = [origin, ...(options.appDomains ?? [])]
    .map((domain) => `    <AppDomain>${xml(domain)}</AppDomain>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
  xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"
  xsi:type="TaskPaneApp">
  <Id>${xml(options.id)}</Id>
  <Version>${xml(options.version ?? "1.0.0.0")}</Version>
  <ProviderName>${xml(options.providerName ?? options.name)}</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="${name}" />
  <Description DefaultValue="${xml(options.description)}" />
  <IconUrl DefaultValue="${icon(32)}" />
  <HighResolutionIconUrl DefaultValue="${icon(64)}" />
  <SupportUrl DefaultValue="${options.supportUrl ? xml(options.supportUrl) : at("/")}" />
  <AppDomains>
${domains}
  </AppDomains>
  <Hosts>
    <Host Name="Workbook" />
  </Hosts>
  <Requirements>
    <Sets DefaultMinVersion="1.1">
      <Set Name="ExcelApi" MinVersion="1.7" />
    </Sets>
  </Requirements>
  <DefaultSettings>
    <SourceLocation DefaultValue="${taskpane}" />
  </DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
      <Host xsi:type="Workbook">
        <DesktopFormFactor>
          <FunctionFile resid="Commands.Url" />
          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabHome">
              <Group id="Addin.Group">
                <Label resid="Group.Label" />
                <Icon>
                  <bt:Image size="16" resid="Icon.16" />
                  <bt:Image size="32" resid="Icon.32" />
                  <bt:Image size="80" resid="Icon.80" />
                </Icon>
                <Control xsi:type="Button" id="Addin.Open">
                  <Label resid="Button.Label" />
                  <Supertip>
                    <Title resid="Button.Label" />
                    <Description resid="Button.Tooltip" />
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Icon.16" />
                    <bt:Image size="32" resid="Icon.32" />
                    <bt:Image size="80" resid="Icon.80" />
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <TaskpaneId>Addin.Taskpane</TaskpaneId>
                    <SourceLocation resid="Taskpane.Url" />
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>
        <bt:Image id="Icon.16" DefaultValue="${icon(16)}" />
        <bt:Image id="Icon.32" DefaultValue="${icon(32)}" />
        <bt:Image id="Icon.80" DefaultValue="${icon(80)}" />
      </bt:Images>
      <bt:Urls>
        <bt:Url id="Taskpane.Url" DefaultValue="${taskpane}" />
        <bt:Url id="Commands.Url" DefaultValue="${at(options.commandsPath ?? "/office/commands.html")}" />
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="Group.Label" DefaultValue="${name}" />
        <bt:String id="Button.Label" DefaultValue="${name}" />
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="Button.Tooltip" DefaultValue="${xml(options.tooltip ?? options.description)}" />
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>
`;
}
