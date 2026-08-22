import {
  buildOpenGeniSlackBotManifest,
  OPENGENI_MANAGED_PUBLIC_BASE_URL,
} from "@opengeni/contracts";

const publicBaseUrl =
  process.env.OPENGENI_PUBLIC_BASE_URL?.trim() || OPENGENI_MANAGED_PUBLIC_BASE_URL;

process.stdout.write(
  `${JSON.stringify(
    buildOpenGeniSlackBotManifest(publicBaseUrl, {
      appName: process.env.OPENGENI_SLACK_APP_NAME,
      botDisplayName: process.env.OPENGENI_SLACK_BOT_DISPLAY_NAME,
      slashCommand: process.env.OPENGENI_SLACK_COMMAND,
      shortcutName: process.env.OPENGENI_SLACK_SHORTCUT_NAME,
    }),
    null,
    2,
  )}\n`,
);
