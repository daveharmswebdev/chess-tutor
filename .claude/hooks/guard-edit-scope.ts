/**
 * PreToolUse (Edit|Write|NotebookEdit): a spoke may only edit files its agent owns
 * (.claude/ownership.json). The coordinator (no agent_type) is not restricted here.
 * Per-brief scope is narrower than ownership; the coordinator checks that afterwards
 * against `git diff`.
 *
 * A spoke that edits anything may also write scratch files outside every git repo
 * under a temp root (the brief's scratch_dir, #21). Read-only agents stay denied.
 */
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { emit, loadOwnership, log, ownsPath, readStdinJson, repoRelative, type Ownership } from "./lib.ts";

const TEMP_ROOTS = [...new Set(["/tmp", "/private/tmp", tmpdir()].map((r) => resolve(r)))];

export function isScratchPath(abs: string): boolean {
  const p = resolve(abs);
  return TEMP_ROOTS.some((root) => p.startsWith(root + sep));
}

export function guardEditScope(input: Record<string, unknown>, ownership: Ownership): object | null {
  const agentType = typeof input.agent_type === "string" ? input.agent_type : "";
  if (!agentType) return null; // the coordinator
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  const abs = String(ti.file_path ?? ti.notebook_path ?? "");
  const def = ownership.agents[agentType];
  if (!def) return null; // a built-in agent (Explore etc.), not one of our spokes

  const rel = abs ? repoRelative(abs) : null;
  if (rel !== null && ownsPath(def.owns, rel)) return null;
  if (rel === null && abs && def.owns.length > 0 && isScratchPath(abs)) return null;

  const reason = `${agentType} may only edit ${def.owns.length ? def.owns.join(", ") : "nothing (read-only)"}; '${rel ?? abs}' is outside that. Report it as a finding with owner set to the right agent or 'coordinator' instead.`;
  log(ownership.edit_scope_mode === "block" ? "edit_denied" : "edit_scope_warning", {
    agent_type: agentType,
    agent_id: input.agent_id,
    path: rel ?? abs,
  });
  if (ownership.edit_scope_mode === "warn") {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `Scope warning: ${reason}` } };
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  readStdinJson()
    .then((input) => {
      const out = guardEditScope(input, loadOwnership());
      if (out) emit(out);
    })
    .catch((err: unknown) => {
      console.error(`guard-edit-scope.ts failed: ${(err as Error).stack ?? err}`);
      process.exit(2); // fail closed
    });
}
