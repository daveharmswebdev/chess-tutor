/**
 * Start a delegation brief: writes .claude/orchestration/briefs/<NNN>-<slug>-r<round>.json
 * with the mechanical fields filled in and TODO placeholders for the rest.
 * validate-brief / render-brief refuse a brief that still contains TODO, so a half-written
 * brief can't be dispatched.
 *
 *   node .claude/scripts/new-brief.ts server-agent bot-retry --issue 23 --scratch <dir> \
 *     --contract-file packages/chess-core/src/api.ts
 *   node .claude/scripts/new-brief.ts web-agent bot-retry --issue 23 --round 2 --base f15ed41 --scratch <dir>
 *
 * --base defaults to HEAD (worktree spokes branch from the coordinator's HEAD). For round 2 on
 * a spoke's own branch, pass the spoke's last commit. --scratch is required (the session's
 * scratchpad; the brief id is appended). --contract-file may repeat.
 * Then fill in the fields and run: node .claude/hooks/delegation.ts render-brief <file> --out <prompt.md>
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "..", "..");
const BRIEFS = join(ROOT, ".claude", "orchestration", "briefs");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    issue: { type: "string" },
    round: { type: "string", default: "1" },
    base: { type: "string" },
    scratch: { type: "string" },
    "contract-file": { type: "string", multiple: true, default: [] },
  },
});

const [agent, slug] = positionals;
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
if (!agent || !slug) fail("usage: new-brief.ts <agent> <slug> --scratch <dir> [--issue n] [--round n] [--base sha] [--contract-file path]...");
if (!/^[a-z0-9-]+$/.test(slug!)) fail(`slug '${slug}' must be lowercase letters, digits and dashes`);
if (!values.scratch) fail("--scratch <dir> is required: the session's scratchpad (the brief id is appended)");

const ownership = JSON.parse(readFileSync(join(ROOT, ".claude", "ownership.json"), "utf8")) as {
  agents: Record<string, { kind: string; owns: string[] }>;
};
const def = ownership.agents[agent!];
if (!def) fail(`'${agent}' is not an agent in .claude/ownership.json (${Object.keys(ownership.agents).join(", ")})`);

const seqs = readdirSync(BRIEFS).map((f) => Number(/^(\d{3})-/.exec(f)?.[1] ?? 0));
const seq = String(Math.max(0, ...seqs) + 1).padStart(3, "0");
const round = Number(values.round);
const briefId = `${seq}-${slug}-r${round}`;
const file = join(BRIEFS, `${briefId}.json`);
if (existsSync(file)) fail(`${file} already exists`);

const base = values.base ?? execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const readOnly = def!.kind === "read-only";
const brief = {
  brief_id: briefId,
  agent,
  issue: values.issue ? Number(values.issue) : null,
  base_sha: base,
  scratch_dir: join(values.scratch!, briefId),
  objective: "TODO: what to produce, specific enough that success or failure is unambiguous",
  requirements: [],
  contract: "TODO: facts, excerpts and measured numbers; whole files go in contract_files",
  ...(values["contract-file"]!.length ? { contract_files: values["contract-file"] } : {}),
  scope: readOnly ? [] : def!.owns,
  negative: readOnly
    ? ["Read-only: do not edit, commit, or run anything that writes to the repo."]
    : ["Do not edit files outside scope, docs, config, .github, root files or the lockfile.", "No new dependencies."],
  rubric: [
    "TODO: tests first (red then green) for each case the requirement IDs name",
    "pnpm test and pnpm typecheck clean from the repo root.",
    `files_changed lists every file changed in ${base}..your head. Commit message references the requirement IDs${values.issue ? ` and #${values.issue}` : ""}.`,
  ],
  concurrency: null,
  round,
};
writeFileSync(file, JSON.stringify(brief, null, 2) + "\n");
console.log(file);
