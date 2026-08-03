import {
  buildOpenGeniSlackBotManifest,
  OPENGENI_MANAGED_PUBLIC_BASE_URL,
} from "@opengeni/contracts";

const publicBaseUrl =
  process.env.OPENGENI_PUBLIC_BASE_URL?.trim() || OPENGENI_MANAGED_PUBLIC_BASE_URL;

process.stdout.write(`${JSON.stringify(buildOpenGeniSlackBotManifest(publicBaseUrl), null, 2)}\n`);
