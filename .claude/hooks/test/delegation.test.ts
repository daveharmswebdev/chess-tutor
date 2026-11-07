import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preAgent, postAgent, preHandback, renderBrief, subagentStop, validateBrief } from "../delegation.ts";
import { guardEditScope } from "../guard-edit-scope.ts";
import { CLAUDE_DIR, REPO_ROOT, extractJsonBlock, git, globMatch, loadOwnership, readLog, scopeWithin, validateReturn } from "../lib.ts";

const ownership = loadOwnership();
const example = (name: string) => JSON.parse(readFileSync(join(CLAUDE_DIR, "schemas", "examples", name), "utf8"));
const fence = (obj: unknown) => "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
const HEAD = git(["rev-parse", "--short", "HEAD"]);

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hooks-test-"));
  process.env.HOOK_LOG_PATH = join(tmp, "log.jsonl");
  process.env.HOOK_BRIEFS_DIR = tmp;
  process.env.HOOK_STATE_PATH = join(tmp, "retries.json");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("glob ownership", () => {
  it("matches dir/** and segment globs", () => {
    expect(globMatch("packages/engine/**", "packages/engine/src/a.ts")).toBe(true);
    expect(globMatch("packages/engine/**", "packages/engine2/a.ts")).toBe(false);
    expect(globMatch("packages/*/test/**", "packages/engine/test/x.test.ts")).toBe(true);
    expect(scopeWithin(["packages/chess-core/**"], "packages/chess-core/src/**")).toBe(true);
    expect(scopeWithin(["packages/chess-core/**"], "packages/engine/**")).toBe(false);
  });
});

describe("return format", () => {
  it("accepts exactly one fenced json block and nothing else", () => {
    expect(extractJsonBlock(fence({ a: 1 })).data).toEqual({ a: 1 });
    expect(extractJsonBlock("Here it is:\n" + fence({ a: 1 })).errors[0]).toMatch(/outside the fence/);
    expect(extractJsonBlock(fence({}) + "\n" + fence({})).errors[0]).toMatch(/2 fenced/);
    expect(extractJsonBlock("{}").errors[0]).toMatch(/no fenced/);
    expect(extractJsonBlock("```json\n{oops}\n```").errors[0]).toMatch(/not valid JSON/);
  });
});

describe("validateReturn", () => {
  const ok = () => example("return.core-agent.success.json");

  it("accepts the examples", () => {
    expect(validateReturn(ok(), "core-agent", ownership)).toEqual([]);
    expect(validateReturn(example("return.reviewer.failure.json"), "reviewer", ownership)).toEqual([]);
  });

  it("rejects a return claiming to be another agent", () => {
    expect(validateReturn(ok(), "engine-agent", ownership).join()).toMatch(/came from 'engine-agent'/);
  });

  it("rejects files outside ownership, a missing commit, and a missing or failed gate", () => {
    const r = { ...ok(), files_changed: ["packages/engine/src/types.ts"], head_sha: null, tests_run: [] };
    const errors = validateReturn(r, "core-agent", ownership).join("\n");
    expect(errors).toMatch(/outside core-agent's ownership/);
    expect(errors).toMatch(/must commit/);
    expect(errors).toMatch(/at least one phase 'gate'/);
    const failed = { ...ok(), tests_run: [{ command: "pnpm test", phase: "gate", result: "fail", summary: "1 failed" }] };
    expect(validateReturn(failed, "core-agent", ownership).join()).toMatch(/gate' check failed/);
  });

  it("rejects success fields mixed with failure fields, and unknown fields", () => {
    expect(validateReturn({ ...ok(), retryable: true }, "core-agent", ownership).length).toBeGreaterThan(0);
    expect(validateReturn({ ...ok(), extra: 1 }, "core-agent", ownership).join()).toMatch(/extra/);
  });

  it("rejects a read-only agent that changed files", () => {
    const r = { ...ok(), agent: "reviewer", head_sha: null };
    expect(validateReturn(r, "reviewer", ownership).join()).toMatch(/read-only agent must not change files/);
  });
});

function writeBrief(overrides: Record<string, unknown> = {}) {
  const brief = { ...example("brief.core-agent.json"), base_sha: HEAD, ...overrides };
  const file = join(tmp, `${brief.brief_id}.json`);
  const text = JSON.stringify(brief, null, 2);
  writeFileSync(file, text);
  return { brief, file, text, prompt: renderBrief(brief, createHash("sha256").update(text).digest("hex")) };
}

describe("briefs and the dispatch gate", () => {
  it("validates scope against ownership and base_sha against git", () => {
    const { brief, file } = writeBrief();
    expect(validateBrief(brief, file, ownership)).toEqual([]);
    const bad = { ...brief, scope: ["packages/engine/**"], base_sha: "deadbeef" };
    const errors = validateBrief(bad, file, ownership).join("\n");
    expect(errors).toMatch(/outside core-agent's ownership/);
    expect(errors).toMatch(/not a commit/);
  });

  it("lets a rendered, unchanged brief through with worktree isolation", () => {
    const { prompt } = writeBrief();
    const input = { tool_input: { subagent_type: "core-agent", prompt, isolation: "worktree" } };
    expect(preAgent(input, ownership)).toBeNull();
    expect(readLog().at(-1)).toMatchObject({ event: "dispatch", brief_id: "001-key-moment-detector-r1" });
  });

  it("denies an unrendered prompt, an edited brief, a wrong agent, and a missing worktree", () => {
    const { prompt, file, text } = writeBrief();
    const deny = (ti: Record<string, unknown>) => JSON.stringify(preAgent({ tool_input: ti }, ownership));
    expect(deny({ subagent_type: "core-agent", prompt: "just do it", isolation: "worktree" })).toMatch(/needs a rendered brief/);
    expect(deny({ subagent_type: "engine-agent", prompt, isolation: "worktree" })).toMatch(/is for core-agent/);
    expect(deny({ subagent_type: "core-agent", prompt })).toMatch(/isolation/);
    writeFileSync(file, text.replace("FR-7", "FR-6"));
    expect(deny({ subagent_type: "core-agent", prompt, isolation: "worktree" })).toMatch(/changed after it was rendered/);
  });

  it("ignores agents that are not spokes", () => {
    expect(preAgent({ tool_input: { subagent_type: "Explore", prompt: "find x" } }, ownership)).toBeNull();
  });
});

describe("return gates", () => {
  const valid = () => fence(example("return.core-agent.success.json"));

  it("pre-handback denies an invalid report with the errors, then gives up after the retry limit", () => {
    const input = { agent_id: "a1", agent_type: "core-agent", tool_input: { message: "done!" } };
    expect(JSON.stringify(preHandback(input, ownership))).toMatch(/attempt 1 of 2/);
    expect(JSON.stringify(preHandback(input, ownership))).toMatch(/attempt 2 of 2/);
    expect(preHandback(input, ownership)).toBeNull(); // gives up: lets it through...
    expect(readLog().at(-1)).toMatchObject({ event: "contract_failed", agent_id: "a1" }); // ...and records the failure
  });

  it("pre-handback passes a valid report and subagent-stop then skips the closing text", () => {
    expect(preHandback({ agent_id: "a2", agent_type: "core-agent", tool_input: { message: valid() } }, ownership)).toBeNull();
    expect(subagentStop({ agent_id: "a2", agent_type: "core-agent", last_assistant_message: "bye" }, ownership)).toBeNull();
  });

  it("subagent-stop blocks an invalid final message so the spoke fixes it", () => {
    const out = subagentStop({ agent_id: "a3", agent_type: "core-agent", last_assistant_message: "All done." }, ownership);
    expect(out).toMatchObject({ decision: "block" });
    expect(subagentStop({ agent_id: "a3", agent_type: "core-agent", last_assistant_message: valid() }, ownership)).toBeNull();
  });

  it("post-agent tells the coordinator the contract verdict", () => {
    preHandback({ agent_id: "a4", agent_type: "core-agent", tool_input: { message: valid() } }, ownership);
    const ok = postAgent({ tool_input: { subagent_type: "core-agent", prompt: "" }, tool_response: { agentId: "a4" } }, ownership);
    expect(JSON.stringify(ok)).toMatch(/passed schema validation/);
    const unchecked = postAgent({ tool_input: { subagent_type: "core-agent", prompt: "" }, tool_response: { agentId: "zz" } }, ownership);
    expect(JSON.stringify(unchecked)).toMatch(/UNCHECKED/);
    const launched = postAgent(
      { tool_input: { subagent_type: "core-agent", prompt: "" }, tool_response: { agentId: "bg1", status: "async_launched" } },
      ownership,
    );
    expect(JSON.stringify(launched)).toMatch(/launched in the background/);
    expect(JSON.stringify(launched)).not.toMatch(/UNCHECKED|round as failed/);
  });
});

describe("edit scope guard", () => {
  const edit = (agent_type: string | undefined, path: string) =>
    guardEditScope({ agent_type, tool_input: { file_path: join(REPO_ROOT, path) } }, ownership);

  it("allows owned paths and the coordinator, denies the rest", () => {
    expect(edit("core-agent", "packages/chess-core/src/detector.ts")).toBeNull();
    expect(edit(undefined, "CLAUDE.md")).toBeNull();
    expect(JSON.stringify(edit("core-agent", "packages/engine/src/types.ts"))).toMatch(/deny/);
    expect(JSON.stringify(edit("reviewer", "packages/engine/src/types.ts"))).toMatch(/read-only/);
  });

  it("lets editing spokes write scratch files under a temp root, but not read-only agents or other outside paths (#21)", () => {
    const at = (agent_type: string, file_path: string) => guardEditScope({ agent_type, tool_input: { file_path } }, ownership);
    const scratch = join(tmpdir(), "chess-tutor-scratch", "015-r1", "notes.py");
    expect(at("core-agent", scratch)).toBeNull();
    expect(at("core-agent", "/private/tmp/claude-501/x/scratchpad/015/edit_tests.py")).toBeNull();
    expect(JSON.stringify(at("reviewer", scratch))).toMatch(/deny/);
    expect(JSON.stringify(at("core-agent", "/Users/someone/.bashrc"))).toMatch(/deny/);
    expect(JSON.stringify(at("core-agent", "/tmpfoo/x.ts"))).toMatch(/deny/);
  });
});
