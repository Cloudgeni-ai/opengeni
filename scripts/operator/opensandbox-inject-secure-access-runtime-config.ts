#!/usr/bin/env bun
/**
 * Inject an initContainer that materializes [ingress.secure_access] from
 * OPENSANDBOX_SECURE_ACCESS_* into a writable runtime TOML for official
 * server v0.2.2 (which ignores those env vars). Keys stay in the Secret.
 *
 * Only the opensandbox-server Deployment document is rewritten. Other Helm
 * documents pass through byte-stable.
 */

const SCRIPT_MOUNT = "/opt/opengeni/materialize-secure-access-config.py";
const RUNTIME_CONFIG_PATH = "/runtime-config/config.toml";
const INIT_NAME = "materialize-secure-access-config";
const SCRIPT_VOLUME = "secure-access-runtime-script";
const RUNTIME_VOLUME = "runtime-config";
const SCRIPT_CONFIG_MAP = "opensandbox-secure-access-runtime-config";

type EnvVar = {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: { name: string; key: string };
  };
};

type VolumeMount = {
  name: string;
  mountPath: string;
  subPath?: string;
  readOnly?: boolean;
};

type Container = {
  name: string;
  image?: string;
  args?: string[];
  command?: string[];
  env?: EnvVar[];
  volumeMounts?: VolumeMount[];
  [key: string]: unknown;
};

type PodSpec = {
  initContainers?: Container[];
  containers?: Container[];
  volumes?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type DeploymentDoc = {
  kind?: string;
  metadata?: { name?: string };
  spec?: {
    template?: {
      spec?: PodSpec;
    };
  };
  [key: string]: unknown;
};

function isServerDeploymentRaw(document: string): boolean {
  return /^\s*kind:\s*Deployment\s*$/mu.test(document) && /^\s*name:\s*opensandbox-server\s*$/mu.test(document);
}

function secretEnv(container: Container, name: string): EnvVar {
  const found = container.env?.find((entry) => entry.name === name);
  if (!found?.valueFrom?.secretKeyRef) {
    throw new Error(`opensandbox-server is missing secret env ${name}`);
  }
  return { name: found.name, valueFrom: { secretKeyRef: { ...found.valueFrom.secretKeyRef } } };
}

function upsertVolume(volumes: Array<Record<string, unknown>>, volume: Record<string, unknown>): Array<Record<string, unknown>> {
  const name = volume.name;
  return [...volumes.filter((entry) => entry.name !== name), volume];
}

function upsertMount(mounts: VolumeMount[], mount: VolumeMount): VolumeMount[] {
  return [...mounts.filter((entry) => entry.name !== mount.name), mount];
}

export function injectSecureAccessRuntimeConfig(doc: DeploymentDoc): DeploymentDoc {
  const spec = doc.spec?.template?.spec;
  const main = spec?.containers?.find((container) => container.name === "main");
  if (!spec || !main?.image) {
    throw new Error("opensandbox-server Deployment is missing spec.template.spec.containers[name=main]");
  }

  const hasSecureAccessEnv = (main.env ?? []).some(
    (entry) => entry.name === "OPENSANDBOX_SECURE_ACCESS_KEYS",
  );
  if (!hasSecureAccessEnv) {
    return doc;
  }

  const keysEnv = secretEnv(main, "OPENSANDBOX_SECURE_ACCESS_KEYS");
  const activeEnv = secretEnv(main, "OPENSANDBOX_SECURE_ACCESS_ACTIVE_KEY");

  const initContainer: Container = {
    name: INIT_NAME,
    image: main.image,
    ...(typeof main.imagePullPolicy === "string" ? { imagePullPolicy: main.imagePullPolicy } : {}),
    command: ["python3", SCRIPT_MOUNT],
    env: [
      { name: "SANDBOX_CONFIG_PATH", value: "/etc/opensandbox/config.toml" },
      { name: "OPENSANDBOX_RUNTIME_CONFIG_PATH", value: RUNTIME_CONFIG_PATH },
      keysEnv,
      activeEnv,
    ],
    volumeMounts: [
      {
        name: "config",
        mountPath: "/etc/opensandbox/config.toml",
        subPath: "config.toml",
        readOnly: true,
      },
      { name: RUNTIME_VOLUME, mountPath: "/runtime-config" },
      { name: SCRIPT_VOLUME, mountPath: "/opt/opengeni", readOnly: true },
    ],
  };

  const otherInits = (spec.initContainers ?? []).filter((container) => container.name !== INIT_NAME);
  spec.initContainers = [...otherInits, initContainer];

  main.args = ["--config", RUNTIME_CONFIG_PATH];
  main.env = (main.env ?? []).map((entry) =>
    entry.name === "SANDBOX_CONFIG_PATH" ? { name: "SANDBOX_CONFIG_PATH", value: RUNTIME_CONFIG_PATH } : entry,
  );
  main.volumeMounts = upsertMount(main.volumeMounts ?? [], {
    name: RUNTIME_VOLUME,
    mountPath: "/runtime-config",
    readOnly: true,
  });

  spec.volumes = upsertVolume(
    upsertVolume(spec.volumes ?? [], { name: RUNTIME_VOLUME, emptyDir: {} }),
    { name: SCRIPT_VOLUME, configMap: { name: SCRIPT_CONFIG_MAP } },
  );
  return doc;
}

export function rewriteOpenSandboxManifests(raw: string): string {
  const trimmed = raw.replace(/^\uFEFF/u, "");
  if (trimmed.trim().length === 0) return raw;
  const chunks = trimmed.split(/^(?=---\s*$)/mu);
  const rewritten = chunks.map((chunk) => {
    const body = chunk.replace(/^---\s*\n?/u, "");
    if (!isServerDeploymentRaw(body) && !isServerDeploymentRaw(chunk)) {
      return chunk;
    }
    const parsed = Bun.YAML.parse(body.startsWith("kind:") || body.startsWith("apiVersion:") ? body : chunk) as DeploymentDoc | DeploymentDoc[];
    const doc = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!doc || doc.kind !== "Deployment" || doc.metadata?.name !== "opensandbox-server") {
      return chunk;
    }
    const next = injectSecureAccessRuntimeConfig(doc);
    const dumped = Bun.YAML.stringify(next).replace(/\n$/u, "");
    return chunk.startsWith("---") ? `---\n${dumped}\n` : `${dumped}\n`;
  });
  return rewritten.join("");
}

if (import.meta.main) {
  const input = await Bun.stdin.text();
  process.stdout.write(rewriteOpenSandboxManifests(input));
}
