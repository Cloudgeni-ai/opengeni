import { createHash } from "node:crypto";

export const OFFICE_MANIFEST_PATH = "/office/manifest.xml";

function xml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/** A stable add-in id per deployment origin, so two deployments never collide. */
export function officeAddinId(origin: string): string {
  const hex = createHash("sha256").update(`opengeni-office-addin:${origin}`).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The Excel add-in manifest for this deployment: a task pane served from
 * `<origin>/office/`, opened from a button on the Home tab.
 */
export function officeAddinManifest(origin: string): string {
  const at = (path: string) => xml(`${origin}${path}`);
  const host = new URL(origin).host;
  return `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
  xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"
  xsi:type="TaskPaneApp">
  <Id>${officeAddinId(origin)}</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>Opengeni</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="Opengeni" />
  <Description DefaultValue="Chat with your Opengeni agents and let them work in this workbook (${xml(host)})." />
  <IconUrl DefaultValue="${at("/office/icon-32.png")}" />
  <HighResolutionIconUrl DefaultValue="${at("/office/icon-64.png")}" />
  <SupportUrl DefaultValue="${at("/")}" />
  <AppDomains>
    <AppDomain>${xml(origin)}</AppDomain>
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
    <SourceLocation DefaultValue="${at("/office/")}" />
  </DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
      <Host xsi:type="Workbook">
        <DesktopFormFactor>
          <FunctionFile resid="Commands.Url" />
          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabHome">
              <Group id="Opengeni.Group">
                <Label resid="Group.Label" />
                <Icon>
                  <bt:Image size="16" resid="Icon.16" />
                  <bt:Image size="32" resid="Icon.32" />
                  <bt:Image size="80" resid="Icon.80" />
                </Icon>
                <Control xsi:type="Button" id="Opengeni.Open">
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
                    <TaskpaneId>Opengeni.Taskpane</TaskpaneId>
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
        <bt:Image id="Icon.16" DefaultValue="${at("/office/icon-16.png")}" />
        <bt:Image id="Icon.32" DefaultValue="${at("/office/icon-32.png")}" />
        <bt:Image id="Icon.80" DefaultValue="${at("/office/icon-80.png")}" />
      </bt:Images>
      <bt:Urls>
        <bt:Url id="Taskpane.Url" DefaultValue="${at("/office/")}" />
        <bt:Url id="Commands.Url" DefaultValue="${at("/office/commands.html")}" />
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="Group.Label" DefaultValue="Opengeni" />
        <bt:String id="Button.Label" DefaultValue="Opengeni" />
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="Button.Tooltip" DefaultValue="Open your Opengeni chats. Agents can work in this workbook while it is open." />
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>
`;
}
