import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** A line-based connection to a UCI engine. Native and WASM Stockfish both speak it over stdin/stdout. */
export interface Transport {
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  close(): void;
}

export function spawnTransport(command: string, args: string[] = []): Transport {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  const rl = createInterface({ input: child.stdout });
  const exitListeners: ((code: number | null) => void)[] = [];
  child.on("exit", (code) => exitListeners.forEach((l) => l(code)));
  child.on("error", () => exitListeners.forEach((l) => l(null)));

  return {
    send: (line) => {
      child.stdin.write(line + "\n");
    },
    onLine: (listener) => {
      rl.on("line", listener);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
    close: () => {
      rl.close();
      child.kill();
    },
  };
}
