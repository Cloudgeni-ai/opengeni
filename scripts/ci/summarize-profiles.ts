#!/usr/bin/env bun
import { readFileSync } from "node:fs";

type Profile = {
  schemaVersion: 1;
  name: string;
  exitCode: number;
  wallSeconds: number;
  process: {
    userSeconds: number | null;
    systemSeconds: number | null;
    maxRssBytes: number | null;
    fileSystemInputs: number | null;
    fileSystemOutputs: number | null;
  };
  cgroup: {
    memoryPeakDeltaFromStartBytes: number | null;
    cpuUsageDeltaNanoseconds: number | null;
    readBytesDelta: number | null;
    writeBytesDelta: number | null;
  };
  runner: {
    os: string;
    arch: string;
    bunVersion: string;
    githubRunnerOs: string | null;
    githubRunnerArch: string | null;
  };
};

export type Distribution = {
  n: number;
  min: number | null;
  median: number | null;
  p95: number | null;
  max: number | null;
  mean: number | null;
  populationVariance: number | null;
  populationStddev: number | null;
  cv: number | null;
};

export function distribution(input: Array<number | null>): Distribution {
  const values = input.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (values.length === 0) {
    return {
      n: 0,
      min: null,
      median: null,
      p95: null,
      max: null,
      mean: null,
      populationVariance: null,
      populationStddev: null,
      cv: null,
    };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const populationVariance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const middle = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 0
      ? ((values[middle - 1] as number) + (values[middle] as number)) / 2
      : (values[middle] as number);
  return {
    n: values.length,
    min: values[0] as number,
    median,
    p95: values[Math.ceil(values.length * 0.95) - 1] as number,
    max: values.at(-1) as number,
    mean,
    populationVariance,
    populationStddev: Math.sqrt(populationVariance),
    cv: mean === 0 ? null : Math.sqrt(populationVariance) / mean,
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readProfile(path: string): Profile {
  const value = JSON.parse(readFileSync(path, "utf8")) as Profile;
  if (
    value.schemaVersion !== 1 ||
    typeof value.name !== "string" ||
    !Number.isSafeInteger(value.exitCode) ||
    finiteOrNull(value.wallSeconds) === null ||
    typeof value.runner?.os !== "string" ||
    typeof value.runner?.arch !== "string" ||
    typeof value.runner?.bunVersion !== "string"
  ) {
    throw new Error(`unsupported or malformed command profile: ${path}`);
  }
  return value;
}

export function summarize(paths: string[]): object {
  if (paths.length === 0) throw new Error("at least one profile JSON path is required");
  const profiles = paths.map((path) => ({ path, profile: readProfile(path) }));
  const runnerKeys = [
    ...new Set(
      profiles.map(({ profile }) =>
        JSON.stringify({
          os: profile.runner.os,
          arch: profile.runner.arch,
          bunVersion: profile.runner.bunVersion,
          githubRunnerOs: profile.runner.githubRunnerOs,
          githubRunnerArch: profile.runner.githubRunnerArch,
        }),
      ),
    ),
  ].sort();
  if (runnerKeys.length !== 1) {
    throw new Error(`profiles use mixed runner/toolchain identities: ${runnerKeys.join(", ")}`);
  }
  const successful = profiles.filter(({ profile }) => profile.exitCode === 0);
  const metric = (select: (profile: Profile) => number | null): Distribution =>
    distribution(successful.map(({ profile }) => finiteOrNull(select(profile))));
  return {
    schemaVersion: 1,
    sampleCount: profiles.length,
    successfulCount: successful.length,
    failed: profiles
      .filter(({ profile }) => profile.exitCode !== 0)
      .map(({ path, profile }) => ({ path, name: profile.name, exitCode: profile.exitCode })),
    runner: JSON.parse(runnerKeys[0] as string),
    metrics: {
      wallSeconds: metric((profile) => profile.wallSeconds),
      processCpuSeconds: metric((profile) =>
        profile.process.userSeconds === null || profile.process.systemSeconds === null
          ? null
          : profile.process.userSeconds + profile.process.systemSeconds,
      ),
      processMaxRssBytes: metric((profile) => profile.process.maxRssBytes),
      cgroupMemoryPeakDeltaBytes: metric((profile) => profile.cgroup.memoryPeakDeltaFromStartBytes),
      cgroupCpuSeconds: metric((profile) =>
        profile.cgroup.cpuUsageDeltaNanoseconds === null
          ? null
          : profile.cgroup.cpuUsageDeltaNanoseconds / 1e9,
      ),
      cgroupReadBytes: metric((profile) => profile.cgroup.readBytesDelta),
      cgroupWriteBytes: metric((profile) => profile.cgroup.writeBytesDelta),
      fileSystemInputs: metric((profile) => profile.process.fileSystemInputs),
      fileSystemOutputs: metric((profile) => profile.process.fileSystemOutputs),
    },
  };
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  process.stdout.write(`${JSON.stringify(summarize(paths), null, 2)}\n`);
}
