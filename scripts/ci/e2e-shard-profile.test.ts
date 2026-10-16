import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  deterministicShards,
  e2eShardWeights,
  E2E_SHARD_PROFILE,
  integrationShardWeights,
} from "./workspace";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const runner = resolve("scripts/ci/run-test-shard.ts");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "e2e-profile-"));
  const files = ["test/e2e/a.e2e.ts", "test/e2e/b.e2e.ts", "test/e2e/c.e2e.ts"];
  const write = (path: string, value: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  for (const path of files) write(path, path);
  write(".bun-version", Bun.version);
  write("bun.lock", "lock");
  write("scripts/run-browser-e2e.ts", "runner");
  const profile = {
    schemaVersion: 1,
    tier: "e2e",
    units: "milliseconds",
    environment: {
      platform: process.platform as string,
      architecture: process.arch as string,
      bunVersion: Bun.version,
      bunVersionFileSha256: hash(Bun.version),
      dependencyLockSha256: hash("lock"),
      browserRunnerSha256: hash("runner"),
    },
    entries: Object.fromEntries(
      files.map((path, index) => [
        path,
        { sha256: hash(path), planningWeight: [400, 100, 100][index]! },
      ]),
    ),
  };
  const save = () => write(E2E_SHARD_PROFILE, JSON.stringify(profile));
  save();
  return {
    root,
    files,
    profile,
    write,
    save,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("content-fenced E2E planning", () => {
  test("integration keeps its independent exact file set and service-image fence", () => {
    const f = fixture();
    try {
      const path = "test/integration/a.integration.ts";
      f.write(path, "integration");
      f.write("service-images", "images");
      const profilePath = join(f.root, "integration-profile.json");
      f.write(
        "integration-profile.json",
        JSON.stringify({
          schemaVersion: 1,
          tier: "integration",
          units: "milliseconds",
          environment: {
            platform: process.platform,
            architecture: process.arch,
            bunVersion: Bun.version,
            bunVersionFileSha256: hash(Bun.version),
            serviceImagesPath: "service-images",
            serviceImagesSha256: hash("images"),
          },
          entries: { [path]: { sha256: hash("integration"), planningWeight: 25 } },
        }),
      );
      expect(integrationShardWeights(f.root, profilePath).weights?.get(path)).toBe(25);
      f.write("service-images", "changed");
      expect(integrationShardWeights(f.root, profilePath).mode).toBe("source-bytes");
      expect(e2eShardWeights(f.root).mode).toBe("profile");
    } finally {
      f.close();
    }
  });

  test("uses elapsed weights without changing selection, serial order, or shard count", () => {
    const f = fixture();
    try {
      const result = e2eShardWeights(f.root);
      expect(result.mode).toBe("profile");
      expect(result.profileSha256).toBe(hash(JSON.stringify(f.profile)));
      const shards = deterministicShards(f.root, f.files, 2, result.weights!);
      expect(shards).toEqual([[f.files[0]!], [f.files[1]!, f.files[2]!]]);
      expect(shards.flat().sort()).toEqual(f.files);
      expect(deterministicShards(f.root, [...f.files].reverse(), 2, result.weights!)).toEqual(
        shards,
      );
      expect(deterministicShards(f.root, [f.files[2]!], 2, result.weights!).flat()).toEqual([
        f.files[2]!,
      ]);
      expect(deterministicShards(f.root, f.files, 1, result.weights!)).toEqual([f.files]);
      expect(deterministicShards(f.root, [], 2, result.weights!)).toEqual([[], []]);
    } finally {
      f.close();
    }
  });

  test("the actual E2E runner uses the same profile for planning", () => {
    const f = fixture();
    try {
      f.write("plan.json", JSON.stringify({ schemaVersion: 1, e2eTests: f.files }));
      const child = spawnSync(
        process.execPath,
        [
          runner,
          "--plan",
          "plan.json",
          "--tier",
          "e2e",
          "--shard",
          "0",
          "--shards",
          "2",
          "--list-json",
        ],
        { cwd: f.root, encoding: "utf8" },
      );
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.files).toEqual([f.files[0]]);
      expect(result.planning.mode).toBe("profile");
      expect(result.planning.profileSha256).toBe(hash(JSON.stringify(f.profile)));
    } finally {
      f.close();
    }
  });

  const changes: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    [
      "schema",
      (f) => {
        f.profile.schemaVersion = 2;
        f.save();
      },
    ],
    [
      "tier",
      (f) => {
        f.profile.tier = "integration";
        f.save();
      },
    ],
    [
      "units",
      (f) => {
        f.profile.units = "bytes";
        f.save();
      },
    ],
    [
      "platform",
      (f) => {
        f.profile.environment.platform = "other";
        f.save();
      },
    ],
    [
      "architecture",
      (f) => {
        f.profile.environment.architecture = "other";
        f.save();
      },
    ],
    [
      "Bun runtime",
      (f) => {
        f.profile.environment.bunVersion = "other";
        f.save();
      },
    ],
    [
      "Bun pin",
      (f) => {
        f.write(".bun-version", "other");
      },
    ],
    [
      "dependency lock",
      (f) => {
        f.write("bun.lock", "other");
      },
    ],
    [
      "browser runner",
      (f) => {
        f.write("scripts/run-browser-e2e.ts", "other");
      },
    ],
    [
      "test content",
      (f) => {
        f.write(f.files[0]!, "changed");
      },
    ],
    [
      "new file",
      (f) => {
        f.write("test/e2e/new.e2e.ts", "new");
      },
    ],
    [
      "removed file",
      (f) => {
        rmSync(join(f.root, f.files[0]!));
      },
    ],
    [
      "missing entry",
      (f) => {
        delete f.profile.entries[f.files[0]!];
        f.save();
      },
    ],
    [
      "invalid hash",
      (f) => {
        f.profile.entries[f.files[0]!]!.sha256 = "invalid";
        f.save();
      },
    ],
    [
      "zero weight",
      (f) => {
        f.profile.entries[f.files[0]!]!.planningWeight = 0;
        f.save();
      },
    ],
    [
      "fractional weight",
      (f) => {
        f.profile.entries[f.files[0]!]!.planningWeight = 1.5;
        f.save();
      },
    ],
    [
      "malformed JSON",
      (f) => {
        f.write(E2E_SHARD_PROFILE, "{");
      },
    ],
    [
      "missing profile",
      (f) => {
        rmSync(join(f.root, E2E_SHARD_PROFILE));
      },
    ],
  ];
  for (const [name, change] of changes) {
    test(`${name} falls back without changing the selected test set`, () => {
      const f = fixture();
      try {
        change(f);
        const result = e2eShardWeights(f.root);
        expect(result.mode).toBe("source-bytes");
        expect(result.weights).toBeNull();
        expect(result.profileSha256).toBeNull();
        expect(result.reason.length).toBeGreaterThan(0);
        expect(
          deterministicShards(f.root, f.files, 2, result.weights ?? undefined)
            .flat()
            .sort(),
        ).toEqual(f.files);
      } finally {
        f.close();
      }
    });
  }
});
