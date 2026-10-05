/**
 * Live voice runs long-lived client protocol code (owner proof, ledger sync,
 * provider transport). A tab opened before a deploy keeps the old code, so a
 * call started there can misbehave until the page is refreshed. Every voice
 * start (or same-tab recovery) first checks the deployment; when this bundle
 * is stale it reloads once onto the current build and resumes voice from the
 * `?realtime=` launch parameter instead of running old code.
 */

export type VoiceDeploymentFacts = {
  bundleRevision: string;
  serverRevision: string;
  bundleContract: string;
  serverContract: string;
};

export type VoiceDeploymentDecision = "current" | "reload" | "prompt";

const VOICE_RELOAD_STORAGE_PREFIX = "opengeni.voiceReloadForRevision:";

export const VOICE_RELOADING_MESSAGE = "Opengeni was updated. Reloading to start voice…";

export function voiceBundleIsStale(facts: VoiceDeploymentFacts): boolean {
  const revisionChanged =
    facts.bundleRevision !== "" &&
    facts.serverRevision !== "" &&
    facts.bundleRevision !== facts.serverRevision;
  const contractChanged =
    facts.serverContract !== "" && facts.serverContract !== facts.bundleContract;
  return revisionChanged || contractChanged;
}

/**
 * `reload` at most once per server revision per tab (a CDN still serving the
 * old bundle must not loop); `prompt` when reloading now would interrupt other
 * work; otherwise start on the current code.
 */
export function decideVoiceDeployment(
  facts: VoiceDeploymentFacts,
  input: {
    reloadBlocked: boolean;
    storage: Pick<Storage, "getItem" | "setItem"> | null;
  },
): VoiceDeploymentDecision {
  if (!voiceBundleIsStale(facts)) return "current";
  if (!input.storage) return "prompt";
  const key = `${VOICE_RELOAD_STORAGE_PREFIX}${facts.serverRevision || facts.serverContract}`;
  const bundle = facts.bundleRevision || facts.bundleContract;
  if (input.storage.getItem(key) === bundle) return "current";
  if (input.reloadBlocked) return "prompt";
  input.storage.setItem(key, bundle);
  return "reload";
}

/** The current URL with the voice launch parameter that autostarts after reload. */
export function voiceRelaunchUrl(href: string, model: string | undefined): string {
  const url = new URL(href);
  if (model) url.searchParams.set("realtime", model);
  return url.toString();
}

type RealtimeBeginClient = {
  beginSessionRealtime: (...args: never[]) => Promise<unknown>;
};

/**
 * Wrap the realtime client so a stale bundle reloads onto the current build
 * before voice begins. A failed check never blocks voice.
 */
export function withVoiceDeploymentGuard<C extends RealtimeBeginClient>(
  client: C,
  deps: {
    decide: () => Promise<VoiceDeploymentDecision>;
    relaunch: (model: string | undefined) => void;
    prompt: () => void;
  },
): C {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== "beginSessionRealtime" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: Parameters<C["beginSessionRealtime"]>) => {
        const decision = await deps.decide().catch((): VoiceDeploymentDecision => "current");
        if (decision === "reload") {
          deps.relaunch((args[2] as { model?: string } | undefined)?.model);
          throw new Error(VOICE_RELOADING_MESSAGE);
        }
        if (decision === "prompt") deps.prompt();
        return await (value as C["beginSessionRealtime"]).apply(target, args);
      };
    },
  });
}
