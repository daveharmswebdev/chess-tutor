/**
 * Shared helpers for the delegation hooks. Hooks always run from the MAIN checkout
 * (the settings.json command cd's there first), so a spoke in a worktree can't
 * change the code that checks it.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

export const CLAUDE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(CLAUDE_DIR, "..");
// Overridable so tests never write to the tracked log or brief folder.
export const logPath = () => process.env.HOOK_LOG_PATH ?? join(CLAUDE_DIR, "orchestration", "log.jsonl");
export const briefsDir = () => process.env.HOOK_BRIEFS_DIR ?? join(CLAUDE_DIR, "orchestration", "briefs");
const statePath = () => process.env.HOOK_STATE_PATH ?? join(REPO_ROOT, ".git", "claude-hooks", "return-retries.json");
export const MAX_RETURN_RETRIES = 2;

// ---------- ownership ----------

export interface AgentOwnership {
  kind: "implementation" | "read-only";
  owns: string[];
}
export interface Ownership {
  edit_scope_mode: "block" | "warn";
  agents: Record<string, AgentOwnership>;
}

export function loadOwnership(): Ownership {
  return JSON.parse(readFileSync(join(CLAUDE_DIR, "ownership.json"), "utf8")) as Ownership;
}

/** `dir/**` matches everything under dir; otherwise segment-by-segment with `*` and `**`. */
export function globMatch(pattern: string, path: string): boolean {
  const p = pattern.split("/");
  const s = path.split("/");
  const seg = (glob: string, part: string) =>
    new RegExp("^" + glob.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$").test(part);
  const match = (i: number, j: number): boolean => {
    if (i === p.length) return j === s.length;
    if (p[i] === "**") {
      for (let k = j; k <= s.length; k++) if (match(i + 1, k)) return true;
      return false;
    }
    return j < s.length && seg(p[i]!, s[j]!) && match(i + 1, j + 1);
  };
  return match(0, 0);
}

export function ownsPath(owns: string[], path: string): boolean {
  return owns.some((g) => globMatch(g, path));
}

/** A scope entry (path or glob) sits inside ownership if some owned glob covers it. */
export function scopeWithin(owns: string[], scope: string): boolean {
  const probe = scope.replace(/\/\*\*$/, "/__any__").replace(/\*/g, "__any__");
  return ownsPath(owns, probe) || owns.includes(scope);
}

// ---------- schemas ----------

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

function validator(name: string) {
  let v = validators.get(name);
  if (!v) {
    v = ajv.compile(JSON.parse(readFileSync(join(CLAUDE_DIR, "schemas", name), "utf8")));
    validators.set(name, v);
  }
  return v;
}

function describe(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) return [];
  // For oneOf, report the branch the data was aiming at (by its status), not both.
  const seen = new Set<string>();
  return errors
    .filter((e) => e.keyword !== "oneOf" && !(e.keyword === "const" && e.instancePath === "/status"))
    .map((e) => {
      const where = e.instancePath || "(root)";
      const extra =
        e.keyword === "additionalProperties"
          ? ` '${(e.params as { additionalProperty: string }).additionalProperty}'`
          : e.keyword === "enum"
            ? ` ${JSON.stringify((e.params as { allowedValues: unknown[] }).allowedValues)}`
            : "";
      return `${where}: ${e.message}${extra}`;
    })
    .filter((m) => (seen.has(m) ? false : (seen.add(m), true)));
}

export function schemaErrors(name: "brief.schema.json" | "return.schema.json", data: unknown): string[] {
  const v = validator(name);
  return v(data) ? [] : describe(v.errors);
}

// ---------- returns ----------

const FENCE = /```json[ \t]*\n([\s\S]*?)\n[ \t]*```/g;

/** The final message must be exactly one fenced ```json block with nothing outside it. */
export function extractJsonBlock(message: string): { data?: unknown; errors: string[] } {
  const matches = [...message.matchAll(FENCE)];
  if (matches.length === 0) {
    return { errors: ["no fenced ```json block found: the final message must be exactly one fenced ```json block"] };
  }
  if (matches.length > 1) {
    return { errors: [`found ${matches.length} fenced \`\`\`json blocks: the final message must contain exactly one`] };
  }
  const m = matches[0]!;
  const outside = (message.slice(0, m.index) + message.slice(m.index! + m[0].length)).trim();
  if (outside) {
    const snippet = outside.length > 80 ? outside.slice(0, 77) + "..." : outside;
    return { errors: [`text outside the fence (${JSON.stringify(snippet)}): put nothing outside the \`\`\`json block`] };
  }
  try {
    return { data: JSON.parse(m[1]!), errors: [] };
  } catch (err) {
    return { errors: [`the fenced block is not valid JSON: ${(err as Error).message}`] };
  }
}

/** Schema plus the rules a schema can't express. */
export function validateReturn(data: unknown, agentType: string | null, ownership: Ownership): string[] {
  const errors = schemaErrors("return.schema.json", data);
  if (errors.length || typeof data !== "object" || data === null) return errors;
  const r = data as Record<string, unknown> & {
    status: string;
    agent: string;
    files_changed?: string[];
    head_sha?: string | null;
    tests_run?: { phase: string; result: string }[];
    findings: { owner: string }[];
  };

  if (agentType && r.agent !== agentType) errors.push(`/agent: the return says '${r.agent}' but it came from '${agentType}'`);
  const known = new Set([...Object.keys(ownership.agents), "coordinator"]);
  r.findings.forEach((f, i) => {
    if (!known.has(f.owner)) errors.push(`/findings/${i}/owner: '${f.owner}' is not an agent in ownership.json or 'coordinator'`);
  });

  const def = ownership.agents[r.agent];
  if (def && r.status === "success") {
    if (def.kind === "read-only") {
      if (r.files_changed?.length) errors.push("/files_changed: a read-only agent must not change files");
      if (r.head_sha) errors.push("/head_sha: a read-only agent has no commit; use null");
    } else {
      if (!r.head_sha) errors.push("/head_sha: an implementation success must commit its work and give the commit sha");
      if (!r.files_changed?.length) errors.push("/files_changed: an implementation success with no changed files is not a deliverable");
      (r.files_changed ?? []).forEach((f, i) => {
        if (!ownsPath(def.owns, f)) errors.push(`/files_changed/${i}: '${f}' is outside ${r.agent}'s ownership`);
      });
      const gate = (r.tests_run ?? []).filter((t) => t.phase === "gate");
      if (!gate.length) errors.push("/tests_run: an implementation success needs at least one phase 'gate' check");
      if (gate.some((t) => t.result === "fail")) errors.push("/tests_run: a 'gate' check failed, so this is not a success");
    }
  }
  return errors;
}

// ---------- state, log, git ----------

export function log(event: string, fields: Record<string, unknown>): void {
  mkdirSync(dirname(logPath()), { recursive: true });
  appendFileSync(logPath(), JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n");
}

export function readLog(): Record<string, unknown>[] {
  if (!existsSync(logPath())) return [];
  return readFileSync(logPath(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Per-agent retry counters, kept outside the tracked tree (in .git/claude-hooks/). */
export function bumpRetries(agentId: string): number {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  const state: Record<string, number> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  state[agentId] = (state[agentId] ?? 0) + 1;
  writeFileSync(path, JSON.stringify(state));
  return state[agentId];
}

export function git(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** Repo-relative path for an absolute file path, resolved against its own worktree root. */
export function repoRelative(absPath: string): string | null {
  let dir = dirname(absPath);
  while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir);
  try {
    const top = git(["rev-parse", "--show-toplevel"], dir);
    const rel = relative(top, absPath);
    return rel.startsWith("..") ? null : rel;
  } catch {
    return null;
  }
}

export async function readStdinJson(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj));
}
