import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

test("tsrs checks Vue scripts, templates and imported component props", async () => {
  const root = resolve(import.meta.dir, "..");
  await mkdir(join(root, ".opengeni"), { recursive: true });
  const directory = await mkdtemp(join(root, ".opengeni", "vue-types-"));
  const config = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8"));
  const valid = `<script setup lang="ts">
defineProps<{ count: number }>();
const amount: number = 1;
</script>
<template><p>{{ count.toFixed(2) }} {{ amount.toFixed(1) }}</p></template>
`;
  const check = async () => {
    const child = Bun.spawn(
      [
        "node",
        join(root, "node_modules/tsrs/bin/tsrs"),
        "--runExternalCode",
        "--noEmit",
        "--pretty",
        "false",
        "-p",
        directory,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output: stdout + stderr };
  };
  try {
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({ ...config, include: ["*.vue"] }),
    );
    await writeFile(join(directory, "Child.vue"), valid);
    await writeFile(join(directory, "Probe.vue"), valid);
    expect(await check()).toEqual({ code: 0, output: "" });

    await writeFile(
      join(directory, "Probe.vue"),
      valid.replace("amount: number = 1", 'amount: number = "wrong"'),
    );
    const script = await check();
    expect(script.code).not.toBe(0);
    expect(script.output).toContain("Probe.vue");
    expect(script.output).toContain("TS2322");

    await writeFile(
      join(directory, "Probe.vue"),
      valid.replace("count.toFixed(2)", "count.missingMethod()"),
    );
    const template = await check();
    expect(template.code).not.toBe(0);
    expect(template.output).toContain("Probe.vue");
    expect(template.output).toContain("TS2339");

    await writeFile(
      join(directory, "Probe.vue"),
      `<script setup lang="ts">import Child from "./Child.vue";</script><template><Child :count="'wrong'" /></template>`,
    );
    const props = await check();
    expect(props.code).not.toBe(0);
    expect(props.output).toContain("Probe.vue");
    expect(props.output).toContain("TS2322");

    await writeFile(join(directory, "Probe.vue"), valid);
    expect(await check()).toEqual({ code: 0, output: "" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
