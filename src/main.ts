#!/usr/bin/env node
import { main } from "./cli.js";

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[wsl-chrome-bridge] unexpected error: ${message}\n`);
    process.exitCode = 1;
  });
