// @opengeni/react/this-computer — "Use this computer": the screens a web app
// shows inside a desktop app that hosts the connected-machine agent (see
// `@opengeni/agent-host`), plus the conversation card for any client. Every
// word comes from the message catalog (`thisComputer.*`), so products
// translate them and name their agent with the rest of their text; the look
// comes from the og tokens and the `og-tc-*` classes in
// `@opengeni/react/this-computer.css`, which a host imports alongside them.
export type {
  ThisComputerConnectOptions,
  ThisComputerErrorCode,
  ThisComputerHost,
  ThisComputerPermission,
  ThisComputerPermissionId,
  ThisComputerPlatform,
  ThisComputerState,
  ThisComputerStatus,
  ThisComputerSystemNames,
  MacSystemNameCatalog,
} from "@opengeni/sdk/this-computer";
export {
  ENGLISH_MAC_SYSTEM_NAMES,
  macSystemNames,
  nextMissingPermission,
  thisComputerNeedsPermissions,
  thisComputerPermissionSteps,
  thisComputerReady,
  THIS_COMPUTER_PERMISSION_ORDER,
} from "@opengeni/sdk/this-computer";
export {
  defaultThisComputerLabels,
  type ThisComputerLabels,
  type ThisComputerPermissionLabels,
} from "./components/this-computer/labels";
export {
  hostErrorText,
  useThisComputer,
  type UseThisComputerResult,
} from "./components/this-computer/use-this-computer";
export {
  computerUseFix,
  computerUseNoticeText,
  computerUsePermissionText,
  computerUseProblemText,
  computerUseState,
  useComputerUse,
  type ComputerUseControl,
  type ComputerUseFix,
  type ComputerUseHandlers,
  type ComputerUseProblem,
  type ComputerUseState,
} from "./components/this-computer/computer-use";
export {
  ThisComputerSetup,
  useThisComputerSetupOpen,
  type ThisComputerSetupProps,
} from "./components/this-computer/this-computer-setup";
export {
  ThisComputerOffer,
  ThisComputerPanel,
  thisComputerView,
  useThisComputerOfferDismissed,
  type ThisComputerOfferProps,
  type ThisComputerPanelProps,
  type ThisComputerView,
} from "./components/this-computer/this-computer-status";
export {
  ThisComputerCard,
  type ThisComputerCardProps,
} from "./components/this-computer/this-computer-card";
export {
  AppIcon,
  ComputerIllustration,
  DoneIllustration,
  SettingsRowIllustration,
} from "./components/this-computer/illustrations";
