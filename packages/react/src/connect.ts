// Optional, unstyled React adapter over the shared headless controller.
// The host owns controller lifetime; unmounting one observer does not cancel an
// attempt another observer is displaying or a durable backend operation.
export { useConnect } from "./hooks/use-connect";
export {
  CapabilityCatalogRow,
  CapabilityCatalogIndicator,
  type CapabilityCatalogRowProps,
  type CapabilityCatalogStatus,
} from "./capability-catalog-row";
export {
  SkillDiscovery,
  type SkillDiscoveryProps,
  type SkillDiscoveryClient,
  type SkillDiscoveryItem,
  type SkillDiscoveryPage,
} from "./skill-discovery";
export { ConnectSetup, type ConnectSetupProps } from "./connect-setup";
export { ConnectChooser, type ConnectChooserProps } from "./connect-chooser";
export { ConnectAccounts, type ConnectAccountsProps } from "./connect-accounts";
export { ConnectPanel, type ConnectPanelProps } from "./connect-panel";
export { ConnectionDiscovery, type ConnectionDiscoveryProps } from "./connection-discovery";
export {
  McpConnectionCard,
  type McpConnectionCardProps,
} from "./components/session-mcp-capability-card";
export { DeviceAuthorization, type DeviceAuthorizationProps } from "./device-authorization";
export {
  IdentityLinkConsent,
  type IdentityLinkClient,
  type IdentityLinkConsentProps,
} from "./identity-link-consent";
export { IdentityLinkAccounts, type IdentityLinkAccountsClient } from "./identity-link-accounts";

export type { ConnectSnapshot } from "@opengeni/connect";
export type {
  ConnectAccount,
  ConnectAdvance,
  ConnectAttempt,
  ConnectNextAction,
  ConnectOwnership,
  ConnectProvider,
  ConnectResource,
  ConnectTransport,
} from "@opengeni/connect";

export {
  ConnectionCatalog,
  ConnectionServiceRow,
  ConnectionOptionRow,
  type ConnectionCatalogProps,
  type ConnectionCatalogService,
  type ConnectionCatalogOption,
} from "./connection-catalog";
export { ConnectionInstalled, type ConnectionInstalledItem } from "./connection-installed";
export { ConnectionTypePicker, type ConnectionType } from "./connection-type-picker";
export { ConnectionLogo } from "./connection-logo";
export { capabilityLogoFallback } from "./capability-logo-fallback";
export { PluginDiscovery, type PluginDiscoveryProps } from "./plugin-discovery";
export { PluginDetails } from "./plugin-details";
