/**
 * The delegation contract, enforced by code.
 *
 *   node .claude/hooks/delegation.ts render-brief <brief.json> [--out <prompt.md>]
 *   node .claude/hooks/delegation.ts validate-brief <brief.json>
 *   node .claude/hooks/delegation.ts validate-return --agent <name> <file>
 *
 * Hook modes (JSON on stdin, wired in .claude/settings.json):
 *   pre-agent      PreToolUse  Agent             gate: a spoke dispatch must carry a rendered, valid, unchanged brief
 *   post-agent     PostToolUse Agent             log the result; tell the coordinator the contract status
 *   pre-handback   PreToolUse  SubagentHandback  validate a spoke's handed-back report; deny an invalid one
 *   subagent-stop  SubagentStop                  validate a report written as closing text; block an invalid one
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  briefsDir,
  CLAUDE_DIR,
  MAX_RETURN_RETRIES,
  bumpRetries,
  emit,
  extractJsonBlock,
  git,
  loadOwnership,
  log,
  readLog,
  readStdinJson,
  schemaErrors,
  scopeWithin,
  validateReturn,
  type Ownership,
} from "./lib.ts";

interface Brief {
  brief_id: string;
  agent: string;
  issue: number | null;
  base_sha: string;
  scratch_dir: string;
  objective: string;
  requirements: string[];
  contract: string;
  scope: string[];
  negative: string[];
  rubric: string[];
  concurrency: string | null;
  round?: number;
  /** Repo paths inlined verbatim from git at base_sha when the brief is rendered. */
  contract_files?: string[];
}

/** Placeholder text left by .claude/scripts/new-brief.ts; a brief carrying it is not finished. */
const PLACEHOLDER = /\bTODO\b/;

const MARKER = /<!-- brief_id: (\S+) sha256: ([0-9a-f]{64}) -->/;

// ---------- briefs ----------

export function validateBrief(data: unknown, fileName: string | null, ownership: Ownership): string[] {
  const errors = schemaErrors("brief.schema.json", data);
  if (errors.length) return errors;
  const b = data as Brief;
  if (fileName && basename(fileName, ".json") !== b.brief_id) {
    errors.push(`/brief_id: '${b.brief_id}' does not match the file name '${basename(fileName)}'`);
  }
  const def = ownership.agents[b.agent];
  if (!def) return [...errors, `/agent: '${b.agent}' is not an agent in .claude/ownership.json`];
  if (def.kind === "read-only" && b.scope.length) errors.push(`/scope: ${b.agent} is read-only; scope must be []`);
  b.scope.forEach((s, i) => {
    if (!scopeWithin(def.owns, s)) errors.push(`/scope/${i}: '${s}' is outside ${b.agent}'s ownership (${def.owns.join(", ")})`);
  });
  let baseOk = true;
  try {
    git(["cat-file", "-e", `${b.base_sha}^{commit}`]);
  } catch {
    baseOk = false;
    errors.push(`/base_sha: '${b.base_sha}' is not a commit in this repository`);
  }
  if (baseOk) {
    (b.contract_files ?? []).forEach((f, i) => {
      try {
        git(["cat-file", "-e", `${b.base_sha}:${f}`]);
      } catch {
        errors.push(`/contract_files/${i}: '${f}' does not exist at ${b.base_sha}`);
      }
    });
  }
  const texts: [string, string][] = [
    ["objective", b.objective],
    ["contract", b.contract],
    ...b.rubric.map((r, i): [string, string] => [`rubric/${i}`, r]),
    ...b.negative.map((n, i): [string, string] => [`negative/${i}`, n]),
  ];
  for (const [where, text] of texts) if (PLACEHOLDER.test(text)) errors.push(`/${where}: still contains a TODO placeholder`);
  return errors;
}

/** The contract files, verbatim at base_sha (fixed content, so the brief hash still pins them). */
function renderContractFiles(b: Brief): string {
  const files = b.contract_files ?? [];
  if (!files.length) return "";
  const blocks = files.map((f) => {
    const ext = f.split(".").pop() ?? "";
    return `### \`${f}\` at \`${b.base_sha}\`\n\n\`\`\`\`${ext}\n${git(["show", `${b.base_sha}:${f}`]).replace(/\n$/, "")}\n\`\`\`\``;
  });
  return `\n\n### Contract files (verbatim)\n\n${blocks.join("\n\n")}`;
}

type JsonSchema = { properties: Record<string, { enum?: string[] } & Record<string, unknown>>; $defs: { finding: { properties: Record<string, { enum?: string[] }> } } };

/**
 * A filled-in return for this agent, with every allowed value taken from the schema and
 * ownership.json, so the spoke does not have to guess enum spellings or owner names.
 */
export function renderReturnTemplate(b: Brief, ownership: Ownership): string {
  const schema = JSON.parse(readFileSync(join(CLAUDE_DIR, "schemas", "return.schema.json"), "utf8")) as JsonSchema;
  const readOnly = ownership.agents[b.agent]?.kind === "read-only";
  const testsRun = schema.properties.tests_run as { items: { properties: Record<string, { enum?: string[] }> } };
  const enumOf = (xs: string[] | undefined) => (xs ?? []).map((x) => `"${x}"`).join(" | ");
  const owners = [...Object.entries(ownership.agents).filter(([, d]) => d.kind === "implementation").map(([n]) => n), "coordinator"];
  const example = {
    status: "success",
    agent: b.agent,
    brief_id: b.brief_id,
    base_sha: "<git rev-parse HEAD before you changed anything>",
    head_sha: readOnly ? null : "<the commit holding your work>",
    summary: "<one paragraph: what was actually produced>",
    files_changed: readOnly ? [] : ["<every file you changed>"],
    tests_run: [
      ...(readOnly ? [] : [{ command: "<test command>", phase: "red", result: "fail", summary: "<the failing assertion>" }]),
      { command: "pnpm test && pnpm typecheck", phase: "gate", result: "pass", summary: "<N passed; exit 0>" },
    ],
    contract_gaps: [],
    brief_defects: [],
    findings: [{ severity: "minor", owner: owners[0], file: "<path>", line: 1, summary: "<the defect>", evidence: "<command output or code quote>" }],
  };
  return `Exactly one fenced \`\`\`json block matching \`.claude/schemas/return.schema.json\`, with \`"brief_id": "${b.brief_id}"\` and \`"base_sha"\` set to the commit you started from. Nothing outside the block. A hook validates it and will send back errors to fix.

Shape of a success (replace every <...>; use [] for empty lists, never omit a field):

\`\`\`json
${JSON.stringify(example, null, 2)}
\`\`\`

Allowed values (exact spelling):
- tests_run[].phase: ${enumOf(testsRun.items.properties.phase?.enum)}; tests_run[].result: ${enumOf(testsRun.items.properties.result?.enum)}. Each entry has exactly command, phase, result, summary.
- findings[].severity: ${enumOf(schema.$defs.finding.properties.severity?.enum)}; findings[].owner: ${enumOf(owners)}. Each finding needs severity, owner, summary, evidence; file and line are optional.
- On failure instead: status "failure", failure_type ${enumOf(schema.properties.failure_type?.enum)}, plus retryable, attempted, alternatives, findings (and no head_sha/files_changed/tests_run requirement).`;
}

export function renderBrief(b: Brief, sha256: string, ownership: Ownership = loadOwnership()): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  return `<!-- brief_id: ${b.brief_id} sha256: ${sha256} -->
# Brief ${b.brief_id}${b.round ? ` (round ${b.round})` : ""} for ${b.agent}

Follow your preloaded spoke-protocol skill. You have no memory of earlier work: everything you need is below or in the repository.

**Issue:** ${b.issue ? `#${b.issue}` : "none"}  ·  **Base commit:** \`${b.base_sha}\`  ·  **Scratch dir:** \`${b.scratch_dir}\`  ·  **Requirements:** ${b.requirements.join(", ") || "none"}

## Objective
${b.objective}

## Contract (interfaces and facts you can rely on)
${b.contract}${renderContractFiles(b)}

## Scope (the only paths you may change)
${b.scope.length ? list(b.scope) : "- none: you are read-only"}

## Out of scope
${list(b.negative)}

## Rubric (how your work is judged)
${list(b.rubric)}

## Concurrency
${b.concurrency ?? "Nothing else is running."}

## Your final message
${renderReturnTemplate(b, ownership)}
`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------- hook handlers ----------

type HookInput = Record<string, unknown> & {
  agent_id?: string;
  agent_type?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  last_assistant_message?: string;
};

export function preAgent(input: HookInput, ownership: Ownership): object | null {
  const ti = input.tool_input ?? {};
  const type = String(ti.subagent_type ?? "");
  const def = ownership.agents[type];
  const deny = (reason: string) => {
    log("dispatch_denied", { subagent_type: type, reason });
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    };
  };
  if (!def) {
    log("dispatch", { subagent_type: type || "general-purpose", description: ti.description, spoke: false });
    return null; // not one of our spokes: no contract applies
  }
  const prompt = String(ti.prompt ?? "");
  const m = MARKER.exec(prompt);
  if (!m) return deny(`Dispatch to ${type} needs a rendered brief. Write .claude/orchestration/briefs/<id>.json and run: node .claude/hooks/delegation.ts render-brief <file>`);
  const [, briefId, hash] = m;
  const file = join(briefsDir(), `${briefId}.json`);
  if (!existsSync(file)) return deny(`Brief file ${file} does not exist.`);
  const text = readFileSync(file, "utf8");
  if (sha256(text) !== hash) return deny(`Brief ${briefId} changed after it was rendered. Re-render it.`);
  const brief = JSON.parse(text) as Brief;
  const errors = validateBrief(brief, file, ownership);
  if (errors.length) return deny(`Brief ${briefId} is invalid:\n- ${errors.join("\n- ")}`);
  if (brief.agent !== type) return deny(`Brief ${briefId} is for ${brief.agent}, but subagent_type is ${type}.`);
  if (def.kind === "implementation" && ti.isolation !== "worktree") {
    return deny(`Implementation spoke ${type} must run with isolation: "worktree".`);
  }
  log("dispatch", { subagent_type: type, brief_id: briefId, base_sha: brief.base_sha, spoke: true });
  return null;
}

export function postAgent(input: HookInput, ownership: Ownership): object | null {
  const ti = input.tool_input ?? {};
  const tr = input.tool_response ?? {};
  const type = String(ti.subagent_type ?? "");
  const agentId = typeof tr.agentId === "string" ? tr.agentId : undefined;
  const briefId = MARKER.exec(String(ti.prompt ?? ""))?.[1];
  const entry = {
    subagent_type: type || "general-purpose",
    brief_id: briefId,
    agent_id: agentId,
    status: tr.status,
    total_tokens: tr.totalTokens,
    duration_ms: tr.totalDurationMs,
    tool_uses: tr.totalToolUseCount,
  };
  if (!ownership.agents[type]) {
    log("agent_complete", entry);
    return null;
  }
  // A background launch returns before the spoke has reported anything: there is no verdict yet.
  if (tr.status === "async_launched") {
    log("agent_complete", { ...entry, contract: "pending" });
    const note = `Contract: ${type} (brief ${briefId}) was launched in the background, so there is no return to check yet. When it hands back, pre-handback or subagent-stop logs the verdict (return_valid / return_invalid / contract_failed) for agent ${agentId} in .claude/orchestration/log.jsonl; read it there before using the return.`;
    return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } };
  }
  // The return was checked by pre-handback or subagent-stop; report the latest verdict.
  const verdict = [...readLog()].reverse().find(
    (e) => e.agent_id === agentId && ["return_valid", "return_invalid", "contract_failed"].includes(String(e.event)),
  );
  const contract = verdict ? String(verdict.event) : "unchecked";
  log("agent_complete", { ...entry, contract });
  const note =
    contract === "return_valid"
      ? `Contract: the return of ${type} (brief ${briefId}) passed schema validation. Still verify claims: re-run the gate checks and compare git diff with files_changed.`
      : `Contract: the return of ${type} (brief ${briefId}) is ${contract.toUpperCase()}. Treat this round as failed (malformed-return); do not use any part of it.`;
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } };
}

/** Shared by both return gates: returns the errors, or [] if valid. */
function checkReturn(message: string, agentType: string, ownership: Ownership): string[] {
  const { data, errors } = extractJsonBlock(message);
  return errors.length ? errors : validateReturn(data, agentType, ownership);
}

function retryOrGiveUp(agentId: string, agentType: string, errors: string[]): { retry: boolean; text: string } {
  const n = bumpRetries(agentId);
  if (n > MAX_RETURN_RETRIES) {
    log("contract_failed", { agent_id: agentId, agent_type: agentType, attempts: n, errors });
    return { retry: false, text: "" };
  }
  log("return_invalid", { agent_id: agentId, agent_type: agentType, attempt: n, errors });
  return {
    retry: true,
    text: `Your return does not satisfy .claude/schemas/return.schema.json (attempt ${n} of ${MAX_RETURN_RETRIES}). Fix these and send it again, as exactly one fenced \`\`\`json block:\n- ${errors.join("\n- ")}`,
  };
}

export function preHandback(input: HookInput, ownership: Ownership): object | null {
  const type = input.agent_type ?? "";
  if (!ownership.agents[type]) return null;
  const agentId = input.agent_id ?? "unknown";
  const message = String(input.tool_input?.message ?? "");
  const errors = checkReturn(message, type, ownership);
  if (!errors.length) {
    log("return_valid", { agent_id: agentId, agent_type: type, via: "handback" });
    return null;
  }
  const { retry, text } = retryOrGiveUp(agentId, type, errors);
  if (!retry) return null; // let it through; post-agent tells the coordinator it failed
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: text } };
}

export function subagentStop(input: HookInput, ownership: Ownership): object | null {
  const type = input.agent_type ?? "";
  if (!ownership.agents[type]) return null;
  const agentId = input.agent_id ?? "unknown";
  // Already validated through the handback tool? Then the closing text is not the report.
  const handedBack = readLog().some((e) => e.agent_id === agentId && e.event === "return_valid" && e.via === "handback");
  if (handedBack) return null;
  const errors = checkReturn(String(input.last_assistant_message ?? ""), type, ownership);
  if (!errors.length) {
    log("return_valid", { agent_id: agentId, agent_type: type, via: "final_message" });
    return null;
  }
  const { retry, text } = retryOrGiveUp(agentId, type, errors);
  return retry ? { decision: "block", reason: text } : null;
}

// ---------- CLI ----------

async function main(argv: string[]): Promise<number> {
  const [mode, ...rest] = argv;
  const ownership = loadOwnership();
  const hooks: Record<string, (i: HookInput, o: Ownership) => object | null> = {
    "pre-agent": preAgent,
    "post-agent": postAgent,
    "pre-handback": preHandback,
    "subagent-stop": subagentStop,
  };
  const hook = mode ? hooks[mode] : undefined;
  if (hook) {
    const out = hook((await readStdinJson()) as HookInput, ownership);
    if (out) emit(out);
    return 0;
  }

  if (mode === "render-brief" || mode === "validate-brief") {
    const file = resolve(rest[0] ?? "");
    const text = readFileSync(file, "utf8");
    const errors = validateBrief(JSON.parse(text), file, ownership);
    if (errors.length) {
      console.error(`Invalid brief ${file}:\n- ${errors.join("\n- ")}`);
      return 1;
    }
    if (mode === "validate-brief") {
      console.log("brief OK");
      return 0;
    }
    const prompt = renderBrief(JSON.parse(text) as Brief, sha256(text), ownership);
    const outIdx = rest.indexOf("--out");
    if (outIdx >= 0 && rest[outIdx + 1]) {
      writeFileSync(rest[outIdx + 1]!, prompt);
      console.log(`rendered to ${rest[outIdx + 1]}`);
    } else {
      process.stdout.write(prompt);
    }
    return 0;
  }

  if (mode === "validate-return") {
    const agent = rest[rest.indexOf("--agent") + 1] ?? null;
    const file = rest.filter((a, i) => a !== "--agent" && rest[i - 1] !== "--agent")[0] ?? "";
    const text = readFileSync(file, "utf8");
    // Accept a bare JSON file (examples) or a full final message with the fenced block.
    const errors = text.trim().startsWith("{")
      ? validateReturn(JSON.parse(text), agent, ownership)
      : checkReturn(text, agent ?? "", ownership);
    if (errors.length) {
      console.error(`Invalid return:\n- ${errors.join("\n- ")}`);
      return 1;
    }
    console.log("return OK");
    return 0;
  }

  console.error("usage: delegation.ts render-brief|validate-brief|validate-return|pre-agent|post-agent|pre-handback|subagent-stop");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      // Fail closed: a crashing gate must not wave a spoke through. Exit 2 blocks the
      // action in hook modes and shows this message; CLI modes just fail.
      console.error(`delegation.ts failed: ${(err as Error).stack ?? err}`);
      process.exit(process.argv[2] && !process.argv[2].includes("-brief") && !process.argv[2].includes("-return") ? 2 : 1);
    },
  );
}
