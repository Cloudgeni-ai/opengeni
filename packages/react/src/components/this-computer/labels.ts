import type {
  ThisComputerErrorCode,
  ThisComputerPermissionId,
  ThisComputerPlatform,
} from "@opengeni/sdk/this-computer";
import { createOpenGeniText, type OpenGeniText } from "../../messages/runtime";

/** Words for one permission step, as the person meets it. */
export interface ThisComputerPermissionLabels {
  /** The step's title, e.g. "Let Acme see the screen". */
  title: string;
  /** Why it is needed, in one plain sentence. */
  why: string;
  /** The list in System Settings where the app's switch is. */
  listName: string;
}

/**
 * Every word the "Use this computer" screens show. Pass your own to translate
 * them or to name your agent ("Ada can…"); start from
 * `defaultThisComputerLabels` and override what differs.
 */
export interface ThisComputerLabels {
  /** The offer's and the setup's title, e.g. "Use this computer". */
  title: string;
  /** One line under the offer. */
  offer(machineName: string): string;
  offerAction: string;
  notNow: string;
  /** The setup's opening line. */
  intro(machineName: string): string;
  /** What agents can do, one short line each. */
  abilities: readonly string[];
  /** Who can use it and how to stop it. */
  safety(platform: ThisComputerPlatform): string;
  turnOn: string;
  /** While the agent downloads and connects. */
  settingUp(machineName: string): string;
  settingUpDetail: string;
  /** The permissions part, before the first step. */
  permissionsTitle: string;
  permissionsIntro(productName: string): string;
  permission(id: ThisComputerPermissionId, productName: string): ThisComputerPermissionLabels;
  /** "Step 1 of 3". */
  stepOf(step: number, total: number): string;
  openSettings: string;
  openSettingsAgain: string;
  /**
   * While the person is in System Settings. `openSettings` is the button on
   * the system's own question, as the system names it.
   */
  waitingForSwitch(productName: string, openSettings: string): string;
  /** The switch was turned on. */
  allowed: string;
  /** Under the pictured row: what may follow the switch. */
  passwordHint: string;
  /**
   * macOS may offer to quit the app for the change; it needn't. `later` is the
   * offer's button that keeps it running, as the system names it.
   */
  quitHint(productName: string, later: string): string;
  /** The files step's button, before macOS asks. */
  askFolders: string;
  /** While macOS asks about each folder. `allow` is its button, as macOS names it. */
  waitingForFolders(allow: string): string;
  /** A folder was refused, so its switch in System Settings is the way. */
  foldersRefused(productName: string): string;
  doneTitle: string;
  done(machineName: string, platform: ThisComputerPlatform): string;
  /** A first thing to try, or "" for none. */
  tryThis: string;
  close: string;
  later: string;
  /** Status lines. */
  ready(machineName: string): string;
  /** Connected, while the app starts its agent again. */
  reconnecting(machineName: string): string;
  paused(machineName: string): string;
  resume: string;
  pause: string;
  turnOff: string;
  turningOff: string;
  /** Before turning off: what stops. */
  turnOffConfirm(machineName: string): string;
  cancel: string;
  /** Under the settings control while it's on. */
  pauseHint(platform: ThisComputerPlatform): string;
  /** In its place while it's paused. */
  resumeHint(platform: ThisComputerPlatform): string;
  finishSetup: string;
  finishSetupDetail: string;
  resuming: string;
  tryAgain: string;
  error(code: ThisComputerErrorCode | null, detail: string | null): string;
  /** Where the app's menu bar item lives, for "pause it from the …". */
  trayName(platform: ThisComputerPlatform): string;
  /** The conversation card's words. */
  card: {
    name: string;
    subtitle: string;
    typeLabel: string;
    /** The person's own computer can be used now. */
    canUse(machineName: string): string;
    /** Their computer is connected but not on or not running now. */
    offline(machineName: string, productName: string): string;
    /** No computer of theirs yet, and this isn't the desktop app. */
    getApp(productName: string): string;
    getAppAction(productName: string): string;
    note: string;
  };
}

/**
 * The words, from the message catalog (`thisComputer.*` keys), so a host
 * translates them with the rest of its text. `t` is the catalog's text
 * function (`useOpenGeniText()`); English without one.
 */
export function defaultThisComputerLabels(
  t: OpenGeniText = createOpenGeniText(),
): ThisComputerLabels {
  const tray = (platform: ThisComputerPlatform) =>
    platform === "macos" ? t("thisComputer.menuBar") : t("thisComputer.tray");
  const permission = (
    id: ThisComputerPermissionId,
    productName: string,
  ): ThisComputerPermissionLabels => {
    switch (id) {
      case "screenRecording":
        return {
          title: t("thisComputer.screenRecording.title", { productName }),
          why: t("thisComputer.screenRecording.why"),
          listName: t("thisComputer.screenRecording.listName"),
        };
      case "accessibility":
        return {
          title: t("thisComputer.accessibility.title", { productName }),
          why: t("thisComputer.accessibility.why"),
          listName: t("thisComputer.accessibility.listName"),
        };
      case "inputMonitoring":
        return {
          title: t("thisComputer.inputMonitoring.title", { productName }),
          why: t("thisComputer.inputMonitoring.why"),
          listName: t("thisComputer.inputMonitoring.listName"),
        };
      case "files":
        return {
          title: t("thisComputer.files.title", { productName }),
          why: t("thisComputer.files.why"),
          listName: t("thisComputer.files.listName"),
        };
    }
  };
  return {
    title: t("thisComputer.title"),
    offer: (machineName) => t("thisComputer.offer", { machineName }),
    offerAction: t("thisComputer.offerAction"),
    notNow: t("thisComputer.notNow"),
    intro: (machineName) => t("thisComputer.intro", { machineName }),
    abilities: [
      t("thisComputer.abilities.screen"),
      t("thisComputer.abilities.files"),
      t("thisComputer.abilities.background"),
    ],
    safety: (platform) => t("thisComputer.safety", { tray: tray(platform) }),
    turnOn: t("thisComputer.turnOn"),
    settingUp: (machineName) => t("thisComputer.settingUp", { machineName }),
    settingUpDetail: t("thisComputer.settingUpDetail"),
    permissionsTitle: t("thisComputer.permissionsTitle"),
    permissionsIntro: (productName) => t("thisComputer.permissionsIntro", { productName }),
    permission,
    stepOf: (step, total) => t("thisComputer.stepOf", { step, total }),
    openSettings: t("thisComputer.openSettings"),
    openSettingsAgain: t("thisComputer.openSettingsAgain"),
    waitingForSwitch: (productName, openSettings) =>
      t("thisComputer.waitingForSwitch", { productName, openSettings }),
    allowed: t("thisComputer.allowed"),
    passwordHint: t("thisComputer.passwordHint"),
    quitHint: (productName, later) => t("thisComputer.quitHint", { productName, later }),
    askFolders: t("thisComputer.askFolders"),
    waitingForFolders: (allow) => t("thisComputer.waitingForFolders", { allow }),
    foldersRefused: (productName) => t("thisComputer.foldersRefused", { productName }),
    doneTitle: t("thisComputer.doneTitle"),
    done: (machineName, platform) => t("thisComputer.done", { machineName, tray: tray(platform) }),
    tryThis: t("thisComputer.tryThis"),
    close: t("thisComputer.close"),
    later: t("thisComputer.later"),
    ready: (machineName) => t("thisComputer.ready", { machineName }),
    reconnecting: (machineName) => t("thisComputer.reconnecting", { machineName }),
    paused: (machineName) => t("thisComputer.paused", { machineName }),
    resume: t("thisComputer.resume"),
    pause: t("thisComputer.pause"),
    turnOff: t("thisComputer.turnOff"),
    turningOff: t("thisComputer.turningOff"),
    turnOffConfirm: (machineName) => t("thisComputer.turnOffConfirm", { machineName }),
    cancel: t("thisComputer.cancel"),
    pauseHint: (platform) => t("thisComputer.pauseHint", { tray: tray(platform) }),
    resumeHint: (platform) => t("thisComputer.resumeHint", { tray: tray(platform) }),
    finishSetup: t("thisComputer.finishSetup"),
    finishSetupDetail: t("thisComputer.finishSetupDetail"),
    resuming: t("thisComputer.resuming"),
    tryAgain: t("thisComputer.tryAgain"),
    error: (code, detail) => {
      switch (code) {
        case "offline":
          return t("thisComputer.error.offline");
        case "download_failed":
          return t("thisComputer.error.downloadFailed");
        case "unsupported":
          return t("thisComputer.error.unsupported");
        case "takeover_failed":
          return t("thisComputer.error.takeoverFailed");
        case "busy":
          return t("thisComputer.error.busy");
        case "connect_failed":
          return t("thisComputer.error.connectFailed");
        case "removed":
          return t("thisComputer.error.removed");
        case "signed_out":
          return t("thisComputer.error.signedOut");
        default:
          return detail ?? t("thisComputer.error.other");
      }
    },
    trayName: tray,
    card: {
      name: t("thisComputer.card.name"),
      subtitle: t("thisComputer.card.subtitle"),
      typeLabel: t("thisComputer.card.typeLabel"),
      canUse: (machineName) => t("thisComputer.card.canUse", { machineName }),
      offline: (machineName, productName) =>
        t("thisComputer.card.offline", { machineName, productName }),
      getApp: (productName) => t("thisComputer.card.getApp", { productName }),
      getAppAction: (productName) => t("thisComputer.card.getAppAction", { productName }),
      note: t("thisComputer.card.note"),
    },
  };
}
