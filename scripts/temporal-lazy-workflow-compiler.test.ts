import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

test("prebuilt and activity-only workers never load the source workflow compiler", async () => {
  const program = `
    const {createRequire} = await import('node:module');
    const require = createRequire(${JSON.stringify(join(root, "apps/worker/package.json"))});
    const {Worker} = require('@temporalio/worker');
    const loadedCompiler = () => Object.keys(require.cache).some(path => path.endsWith('/workflow/bundler.js') || path.includes('/webpack/'));
    if (loadedCompiler()) throw new Error('compiler loaded during import');
    const logger = {warn:()=>{},debug:()=>{},info:()=>{},error:()=>{},trace:()=>{}};
    await Worker.getOrCreateBundle({interceptors:{workflowModules:[]}},logger);
    if (loadedCompiler()) throw new Error('activity-only worker loaded compiler');
    const code = 'var workflowBundle = {}' + '\\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify({version:3,file:'workflow-bundle.js',sources:[],names:[],mappings:''})).toString('base64');
    const bundle = await Worker.getOrCreateBundle({workflowBundle:{code},interceptors:{workflowModules:[]}},logger);
    if (!bundle.code || loadedCompiler()) throw new Error('prebuilt worker loaded compiler');
    const {bundleWorkflowCode} = require('@temporalio/worker');
    if (typeof bundleWorkflowCode !== 'function' || loadedCompiler()) throw new Error('compiler export eagerly loaded');
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", program], {
    cwd: root,
    env: { PATH: process.env.PATH },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
});

test("the public compiler and source-workflow worker path still compile on demand", async () => {
  const fixture = await mkdtemp(join(root, "apps/worker/.lazy-compiler-"));
  try {
    const workflow = join(fixture, "workflow.ts");
    await writeFile(workflow, "export async function emptyWorkflow() {}\n");
    const program = `
      const {createRequire} = await import('node:module');
      const {Worker,bundleWorkflowCode} = createRequire(${JSON.stringify(join(root, "apps/worker/package.json"))})('@temporalio/worker');
      const logger = {warn:()=>{},debug:()=>{},info:()=>{},error:()=>{},trace:()=>{}};
      const compiled = await bundleWorkflowCode({workflowsPath:${JSON.stringify(workflow)},logger});
      if (!compiled.code.includes('emptyWorkflow')) throw new Error('public compiler failed');
      const bundle = await Worker.getOrCreateBundle({workflowsPath:${JSON.stringify(workflow)},interceptors:{workflowModules:[]}},logger);
      if (!bundle.code.includes('emptyWorkflow')) throw new Error('worker compiler failed');
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", program], {
      cwd: root,
      env: { PATH: process.env.PATH },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 30_000);
