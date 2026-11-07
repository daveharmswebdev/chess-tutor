export interface ShutdownResource {
  name: string;
  close(): void | Promise<void>;
}

export interface ShutdownOptions {
  /** Closed first: its preClose hook abandons and saves games still playing (FR-5). */
  app: { close(): Promise<unknown> };
  /** Closed in order after the app, each independently of the others. */
  resources: ShutdownResource[];
  log: { info(obj: object, msg: string): void; error(obj: object, msg: string): void };
  exit: (code: number) => void;
}

/**
 * The SIGINT/SIGTERM handler. Every step runs even if an earlier one fails (failures
 * are logged), and it always exits: 0 if everything closed cleanly, else 1. Never
 * rejects, so `void shutdown(signal)` cannot become an unhandled rejection.
 */
export function createShutdown(opts: ShutdownOptions): (signal: string) => Promise<void> {
  let running: Promise<void> | null = null;

  async function run(signal: string): Promise<void> {
    let failed = false;
    opts.log.info({ signal }, "shutting down: abandoning live games");
    const steps: ShutdownResource[] = [{ name: "server", close: () => opts.app.close() as Promise<void> }, ...opts.resources];
    for (const step of steps) {
      try {
        await step.close();
      } catch (err) {
        failed = true;
        opts.log.error({ err }, `shutdown: could not close the ${step.name}`);
      }
    }
    opts.exit(failed ? 1 : 0);
  }

  return (signal) => {
    running ??= run(signal);
    return running;
  };
}
