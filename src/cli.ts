import { Command } from "commander";
import { createBridgeRunner } from "./bridge-runner.js";

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = new Command();
  let chromeArgs: string[] = [];

  program
    .name("wsl-chrome-bridge")
    .description("Bridge chrome-devtools-mcp from WSL2 to Windows Chrome")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument("[chromeArgs...]", "arguments forwarded to Chrome")
    .action((args: string[]) => {
      chromeArgs = args ?? [];
    });

  await program.parseAsync(argv);

  const runBridge = createBridgeRunner();
  return await runBridge(chromeArgs);
}
