// Compatibility entry point. All supported recovery decisions use one command.
import { main } from "./sandbox-recovery";

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
