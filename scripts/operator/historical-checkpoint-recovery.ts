// Compatibility entry point. All supported recovery decisions use one command.
import { main } from "./sandbox-recovery";
import { errorMessage } from "@opengeni/contracts/values";

if (import.meta.main)
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
