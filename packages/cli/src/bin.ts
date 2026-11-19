import { runCli } from "./index";

process.exitCode = runCli(process.argv.slice(2));
