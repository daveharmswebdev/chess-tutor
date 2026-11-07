/**
 * Put an issue on the Chess Tutor project board (github.com/users/daveharmswebdev/projects/5)
 * and set its Status, Kind and Priority. The board is the user's view of progress.
 *
 *   node .claude/scripts/board.ts 12 --kind Feature --status Todo
 *   node .claude/scripts/board.ts 12 --status "In Progress"
 *   node .claude/scripts/board.ts 12 --priority P2
 *
 * Adds the issue to the project if it isn't there yet. Field and option IDs are looked
 * up by name each run, so renaming an option on the board only needs this file updated.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const OWNER = "daveharmswebdev";
const REPO = "chess-tutor";
const PROJECT = "5";
export const STATUSES = ["Needs you", "Todo", "In Progress", "In Review", "Done"] as const;
export const KINDS = ["Epic", "Feature", "Bug", "Engineering"] as const;
export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
/** P0 and P1 are the user's call: setting one needs --user-approved. */
const USER_PRIORITIES = new Set(["P0", "P1"]);

const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8" });

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      status: { type: "string" },
      kind: { type: "string" },
      priority: { type: "string" },
      "user-approved": { type: "boolean" },
    },
  });
  const issue = Number(positionals[0]);
  if (!Number.isInteger(issue)) throw new Error("usage: board.ts <issue> [--status S] [--kind K]");
  if (values.status && !STATUSES.includes(values.status as never)) throw new Error(`--status must be one of ${STATUSES.join(", ")}`);
  if (values.kind && !KINDS.includes(values.kind as never)) throw new Error(`--kind must be one of ${KINDS.join(", ")}`);
  if (values.priority && !PRIORITIES.includes(values.priority as never)) throw new Error(`--priority must be one of ${PRIORITIES.join(", ")}`);
  if (values.priority && USER_PRIORITIES.has(values.priority) && !values["user-approved"]) {
    throw new Error(`${values.priority} is the user's call: propose it, and pass --user-approved only once they agree`);
  }

  const project = JSON.parse(gh(["project", "view", PROJECT, "--owner", OWNER, "--format", "json"])) as { id: string };
  const url = `https://github.com/${OWNER}/${REPO}/issues/${issue}`;
  const item = JSON.parse(gh(["project", "item-add", PROJECT, "--owner", OWNER, "--url", url, "--format", "json"])) as { id: string };
  const fields = JSON.parse(gh(["project", "field-list", PROJECT, "--owner", OWNER, "--format", "json"])) as {
    fields: { id: string; name: string; options?: { id: string; name: string }[] }[];
  };

  const wanted = [["Status", values.status], ["Kind", values.kind], ["Priority", values.priority]] as const;
  for (const [fieldName, option] of wanted) {
    if (!option) continue;
    const field = fields.fields.find((f) => f.name === fieldName);
    const opt = field?.options?.find((o) => o.name === option);
    if (!field || !opt) throw new Error(`board has no ${fieldName} option '${option}'`);
    gh(["project", "item-edit", "--id", item.id, "--project-id", project.id, "--field-id", field.id, "--single-select-option-id", opt.id]);
  }
  const set = wanted.filter(([, v]) => v).map(([f, v]) => `${f}=${v}`).join(" ");
  console.log(`#${issue} on board: ${set || "(added)"}`);
}

main();
