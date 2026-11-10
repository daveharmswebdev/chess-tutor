/**
 * Tutor eval runner (#10, NFR-6, NFR-7, NFR-10). Live calls to the Claude API through the real
 * tutor session, with real Stockfish. Every run has a spending cap.
 *
 *   pnpm eval -- --model <id> --effort <level> [--cases <kind|glob|list>] [--max-usd N]
 *                [--concurrency N] [--repeat N] [--out <dir>] [--prompt <file>] [--live-explorer] [--gate]
 *   pnpm eval -- compare <dir> <dir> ... [--out <dir>]
 *   pnpm eval -- regrade <dir> ...      (offline: re-grades recorded cases, no API call)
 *
 * --model defaults to config/models.json "eval".tutor, --effort to config/tutor.json.
 * --gate: after the report is written, exit 1 and print one "gate: ..." line per missed threshold
 * when NFR-6 move legality < 100%, NFR-6 eval match < 100% or NFR-7 no give-away < 90% (a metric
 * with no graded replies is a miss), or when fewer than 90% of the cases (not-started ones
 * included) were graded. Without --gate the exit code does not depend on the metrics.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { TutorConfig, TutorExplorer } from "@chess-tutor/tutor";
import { loadCases, selectCases } from "./cases.ts";
import { CASES_DIR, DEFAULT_PROMPT, loadRepertoire, loadSettings, RESULTS_DIR } from "./config.ts";
import { regradeDir } from "./regrade.ts";
import { compareRuns, gateDecision } from "./report.ts";
import { runEval } from "./runner.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const DEFAULT_MAX_USD = 2;

/** Explorer for evals: always unavailable, so runs are deterministic and need no network. */
const OFFLINE_EXPLORER: TutorExplorer = {
  async lookup() {
    return { moves: [], totalGames: 0, opening: null, unavailable: "network" };
  },
};

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

function fail(message: string): never {
  console.error(`evals: ${message}`);
  process.exit(2);
}

async function compare(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { out: { type: "string" } } });
  if (positionals.length < 1) fail("compare needs at least one run directory");
  const { json, markdown } = compareRuns(positionals.map((p) => resolve(p)));
  const out = resolve(values.out ?? join(RESULTS_DIR, `compare-${stamp()}`));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "compare.json"), JSON.stringify(json, null, 2) + "\n");
  writeFileSync(join(out, "compare.md"), markdown);
  console.log(markdown);
  console.log(`Wrote ${join(out, "compare.md")}`);
}

async function regrade(args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length < 1) fail("regrade needs at least one run directory");
  const tol = loadSettings().toleranceCp;
  for (const dir of positionals.map((p) => resolve(p))) {
    const s = regradeDir(dir, { toleranceCp: tol });
    const m = s.metrics;
    const p = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
    console.log(
      `${dir}: ${s.model} ${s.effort} | moves legal ${p(m.moveLegalPct)} | evals matched ${p(m.evalMatchPct)} | no give-away ${p(m.noGiveAwayPct)} | points at answer ${p(m.pointsAtAnswerPct)}`,
    );
  }
}

async function run(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      model: { type: "string" },
      effort: { type: "string" },
      cases: { type: "string" },
      "max-usd": { type: "string" },
      concurrency: { type: "string" },
      repeat: { type: "string" },
      out: { type: "string" },
      prompt: { type: "string" },
      "live-explorer": { type: "boolean" },
      gate: { type: "boolean" },
    },
  });
  const settings = loadSettings();
  const model = values.model ?? settings.tutor.model;
  const effort = (values.effort ?? settings.tutor.effort) as TutorConfig["effort"];
  if (!EFFORTS.includes(effort)) fail(`--effort must be one of ${EFFORTS.join(", ")}`);
  const price = settings.pricing[model];
  if (!price) fail(`no pricingPerMTok for ${model} in config/models.json: the spending cap cannot be enforced`);
  const maxUsd = Number(values["max-usd"] ?? DEFAULT_MAX_USD);
  const concurrency = Number(values.concurrency ?? 2);
  const repeat = Number(values.repeat ?? 1);
  if (!(maxUsd > 0) || !(concurrency >= 1) || !(repeat >= 1)) fail("--max-usd must be > 0, --concurrency and --repeat >= 1");
  if (!process.env["ANTHROPIC_API_KEY"]) fail("ANTHROPIC_API_KEY is not set (put it in .env); evals make live API calls");

  const cases = selectCases(loadCases(CASES_DIR), values.cases);
  if (cases.length === 0) fail(`no cases match --cases ${values.cases ?? ""}`);
  const promptPath = resolve(values.prompt ?? DEFAULT_PROMPT);
  const systemPrompt = readFileSync(promptPath, "utf8");
  const outDir = resolve(values.out ?? join(RESULTS_DIR, `${stamp()}-${model}-${effort}`));

  const [{ default: Anthropic }, { createEngineFromEnv }] = await Promise.all([import("@anthropic-ai/sdk"), import("@chess-tutor/engine")]);
  const engine = createEngineFromEnv(settings.engineThreads !== undefined ? { threads: settings.engineThreads } : {});
  let explorer = OFFLINE_EXPLORER;
  let closeExplorer = () => {};
  if (values["live-explorer"]) {
    const token = process.env["LICHESS_TOKEN"];
    if (!token) fail("--live-explorer needs LICHESS_TOKEN");
    const { createExplorerClient, createSqliteExplorerCache } = await import("@chess-tutor/explorer");
    const cache = createSqliteExplorerCache(":memory:");
    explorer = createExplorerClient({ token, cache });
    closeExplorer = () => cache.close();
  }

  console.log(`${cases.length} cases x ${repeat} on ${model} (${effort}), cap $${maxUsd}, concurrency ${concurrency}, prompt ${basename(promptPath)}`);
  try {
    const summary = await runEval({
      cases,
      config: { ...settings.tutor, model, effort },
      client: new Anthropic(),
      engine,
      explorer,
      repertoire: loadRepertoire(),
      systemPrompt,
      promptFile: basename(promptPath),
      price,
      toleranceCp: settings.toleranceCp,
      maxUsd,
      concurrency,
      repeat,
      outDir,
    });
    const m = summary.metrics;
    const p = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
    console.log(
      `\nok ${p(m.okRate)} | moves legal ${p(m.moveLegalPct)} | evals matched ${p(m.evalMatchPct)} | no give-away ${p(m.noGiveAwayPct)} | spent $${summary.spentUsd.toFixed(3)}${summary.stoppedByBudget ? ` (budget reached, ${summary.skipped.length} not started)` : ""}`,
    );
    console.log(`Wrote ${join(outDir, "report.md")}`);
    const gate = gateDecision(m, values.gate === true, summary.skipped.length);
    for (const line of gate.lines) console.error(line);
    if (gate.exitCode !== 0) process.exitCode = gate.exitCode;
  } finally {
    await engine.quit();
    closeExplorer();
  }
}

const argv = process.argv.slice(2).filter((a, i) => !(i === 0 && a === "--"));
const main = argv[0] === "compare" ? compare(argv.slice(1)) : argv[0] === "regrade" ? regrade(argv.slice(1)) : run(argv);
main.catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
