#!/usr/bin/env bun
/*
 * Connected Machines for the design preview.
 *
 * `seedMachines` enrolls a few machines the way an approved device enrollment
 * does (an enrollment plus its selfhosted sandbox), then backfills an hour of
 * metrics so the cards and charts have something to show. It needs Connected
 * Machines enabled on the stack (OPENGENI_SANDBOX_SELFHOSTED_ENABLED=true) and
 * skips otherwise. No agent runs, so a machine reads offline 30 seconds after
 * its last heartbeat. Keep the online ones online with:
 *
 *   bun scripts/dev-seed-design-preview/machines.ts --heartbeat
 *
 * which writes a heartbeat and a fresh sample every 10 seconds until stopped.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDb,
  finalizeEnrollmentByToken,
  ingestMachineMetricsSample,
  listEnrollments,
  touchEnrollmentLastSeen,
  type MachineMetricsSample,
} from "@opengeni/db";

const GIB = 1024 ** 3;

interface MachineSeed {
  name: string;
  os: "linux" | "macos" | "windows";
  arch: string;
  hasDisplay: boolean;
  allowScreenControl: boolean;
  /** Heartbeats keep it online; otherwise it was last seen when seeded. */
  online: boolean;
  memTotal: number;
  diskTotal: number;
  /** Typical CPU load in percent; samples wander around it. */
  cpu: number;
  gpuMemTotal?: number;
}

export const MACHINES: Record<string, MachineSeed[]> = {
  "Platform engineering": [
    {
      name: "bendik-mbp",
      os: "macos",
      arch: "arm64",
      hasDisplay: true,
      allowScreenControl: true,
      online: true,
      memTotal: 36 * GIB,
      diskTotal: 994 * GIB,
      cpu: 18,
    },
    {
      name: "build-01",
      os: "linux",
      arch: "x86_64",
      hasDisplay: false,
      allowScreenControl: false,
      online: true,
      memTotal: 64 * GIB,
      diskTotal: 1_900 * GIB,
      cpu: 62,
    },
    {
      name: "gpu-lab",
      os: "linux",
      arch: "x86_64",
      hasDisplay: false,
      allowScreenControl: false,
      online: true,
      memTotal: 128 * GIB,
      diskTotal: 3_800 * GIB,
      cpu: 35,
      gpuMemTotal: 24 * GIB,
    },
    {
      name: "old-thinkpad",
      os: "linux",
      arch: "x86_64",
      hasDisplay: true,
      allowScreenControl: false,
      online: false,
      memTotal: 16 * GIB,
      diskTotal: 476 * GIB,
      cpu: 6,
    },
  ],
};

export interface SeededMachine {
  accountId: string;
  workspaceId: string;
  enrollmentId: string;
  name: string;
  online: boolean;
}

/** A stable fake ed25519 public key per machine name, so re-runs find it again. */
function pubkeyFor(name: string): string {
  return createHash("sha256").update(`design-preview-machine:${name}`).digest("base64");
}

/** A plausible sample at `at`: smooth wander around the machine's usual load. */
function sampleFor(seed: MachineSeed, at: Date): MachineMetricsSample {
  const t = at.getTime() / 60_000;
  const wave = Math.sin(t / 7 + seed.name.length) * 0.5 + Math.sin(t / 2.3) * 0.25;
  const cpu = Math.min(97, Math.max(1, seed.cpu * (1 + wave * 0.6)));
  const cores = seed.memTotal >= 64 * GIB ? 16 : 10;
  const load = (cpu / 100) * cores;
  return {
    cpuPercent: Math.round(cpu * 10) / 10,
    load1: Math.round(load * 100) / 100,
    load5: Math.round(load * 0.9 * 100) / 100,
    load15: Math.round(load * 0.8 * 100) / 100,
    memUsedBytes: Math.round(seed.memTotal * (0.38 + cpu / 400)),
    memTotalBytes: seed.memTotal,
    diskUsedBytes: Math.round(seed.diskTotal * 0.46),
    diskTotalBytes: seed.diskTotal,
    gpuUtilPercent: seed.gpuMemTotal ? Math.round(Math.min(99, cpu * 1.3)) : null,
    gpuMemUsedBytes: seed.gpuMemTotal ? Math.round(seed.gpuMemTotal * 0.55) : null,
    gpuMemTotalBytes: seed.gpuMemTotal ?? null,
    contention: Math.max(0, Math.round((load - cores * 0.7) * 10) / 10),
    sampledAt: at,
  };
}

/**
 * Enrolls the seed machines in each named workspace (idempotent: a machine
 * whose key is already enrolled is reused) and backfills an hour of metrics.
 */
export async function seedMachines(input: {
  databaseUrl: string;
  workspaces: { name: string; workspaceId: string; accountId: string }[];
  statePath: string;
  log: (message: string) => void;
}): Promise<SeededMachine[]> {
  const client = createDb(input.databaseUrl, { max: 2 });
  const seeded: SeededMachine[] = [];
  try {
    for (const workspace of input.workspaces) {
      const machines = MACHINES[workspace.name];
      if (!machines) continue;
      const existing = await listEnrollments(client.db, workspace.workspaceId, {
        status: "active",
      });
      for (const machine of machines) {
        const pubkey = pubkeyFor(machine.name);
        let enrollmentId = existing.find((entry) => entry.pubkey === pubkey)?.id;
        let created = false;
        if (!enrollmentId) {
          const { enrollment } = await finalizeEnrollmentByToken(client.db, {
            accountId: workspace.accountId,
            workspaceId: workspace.workspaceId,
            pubkey,
            hasDisplay: machine.hasDisplay,
            allowScreenControl: machine.allowScreenControl,
            os: machine.os,
            arch: machine.arch,
            sandboxName: machine.name,
          });
          enrollmentId = enrollment.id;
          created = true;
        }
        const ids = {
          accountId: workspace.accountId,
          workspaceId: workspace.workspaceId,
          enrollmentId,
        };
        // An hour of one-per-minute history on first seed, then the latest sample.
        const now = Date.now();
        if (created) {
          for (let minutes = 60; minutes >= 1; minutes--) {
            const at = new Date(now - minutes * 60_000);
            await ingestMachineMetricsSample(client.db, { ...ids, sample: sampleFor(machine, at) });
          }
        }
        await ingestMachineMetricsSample(client.db, {
          ...ids,
          sample: sampleFor(machine, new Date(now)),
        });
        await touchEnrollmentLastSeen(client.db, ids);
        seeded.push({ ...ids, name: machine.name, online: machine.online });
        if (created) input.log(`  machine ${machine.name} enrolled in ${workspace.name}`);
      }
    }
  } finally {
    await client.close();
  }
  writeFileSync(input.statePath, JSON.stringify(seeded, null, 2), { mode: 0o600 });
  return seeded;
}

/** Heartbeats the seeded online machines every 10 seconds until stopped. */
async function heartbeat(databaseUrl: string, statePath: string): Promise<never> {
  if (!existsSync(statePath)) {
    throw new Error(`${statePath} is missing; run the design-preview seed first.`);
  }
  const machines = (JSON.parse(readFileSync(statePath, "utf8")) as SeededMachine[]).filter(
    (machine) => machine.online,
  );
  const seeds = new Map(
    Object.values(MACHINES)
      .flat()
      .map((seed) => [seed.name, seed]),
  );
  const client = createDb(databaseUrl, { max: 2 });
  console.log(`Heartbeating ${machines.length} machines every 10 seconds (Ctrl-C to stop).`);
  for (;;) {
    for (const machine of machines) {
      const seed = seeds.get(machine.name);
      if (!seed) continue;
      const ids = {
        accountId: machine.accountId,
        workspaceId: machine.workspaceId,
        enrollmentId: machine.enrollmentId,
      };
      try {
        await ingestMachineMetricsSample(client.db, {
          ...ids,
          sample: sampleFor(seed, new Date()),
        });
        await touchEnrollmentLastSeen(client.db, ids);
      } catch (error) {
        console.error(`heartbeat ${machine.name}: ${(error as Error).message.slice(0, 200)}`);
      }
    }
    await Bun.sleep(10_000);
  }
}

if (import.meta.main && process.argv.includes("--heartbeat")) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const runtime: Record<string, string> = {};
  for (const line of readFileSync(resolve(root, ".env.runtime"), "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) runtime[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
  }
  const databaseUrl = runtime.OPENGENI_MIGRATIONS_DATABASE_URL;
  if (!databaseUrl) throw new Error(".env.runtime has no OPENGENI_MIGRATIONS_DATABASE_URL");
  const statePath =
    process.argv[process.argv.indexOf("--state") + 1] && process.argv.includes("--state")
      ? process.argv[process.argv.indexOf("--state") + 1]!
      : resolve(process.env.HOME ?? "~", ".config/opengeni-design-preview/machines.json");
  await heartbeat(databaseUrl, statePath);
}
