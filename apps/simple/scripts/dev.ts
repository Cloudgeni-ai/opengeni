// Runs the companion server and the Vite app together; stops both on exit.
const root = new URL("..", import.meta.url).pathname;
const children = [
  Bun.spawn(["bun", "--watch", "server/index.ts"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn(["bunx", "--bun", "vite", "--host", "0.0.0.0", "--port", "5190"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  }),
];
const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(children.map((child) => child.exited));
stop();
