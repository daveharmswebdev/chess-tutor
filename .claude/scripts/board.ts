/**
 * Put an issue on the Chess Tutor project board (github.com/users/daveharmswebdev/projects/5)
 * and set its Status and Kind. The board is the user's view of progress.
 *
 *   node .claude/scripts/board.ts 12 --kind Feature --status Todo
 *   node .claude/scripts/board.ts 12 --status "In Progress"
 *
 * Adds the issue to the project if it isn't there yet. Field and option IDs are looked
 * up by name each run, so renaming an option on the board only needs this file updated.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const OWNER = "daveharmswebdev";
const REPO = "chess-tutor";
const PROJECT = "5";
export const STATUSES = ["Todo", "In Progress", "In Review", "Done"] as const;
export const KINDS = ["Epic", "Feature", "Bug", "Engineering"] as const;

const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8" });

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { status: { type: "string" }, kind: { type: "string" } },
  });
  const issue = Number(positionals[0]);
  if (!Number.isInteger(issue)) throw new Error("usage: board.ts <issue> [--status S] [--kind K]");
  if (values.status && !STATUSES.includes(values.status as never)) throw new Error(`--status must be one of ${STATUSES.join(", ")}`);
  if (values.kind && !KINDS.includes(values.kind as never)) throw new Error(`--kind must be one of ${KINDS.join(", ")}`);

  const project = JSON.parse(gh(["project", "view", PROJECT, "--owner", OWNER, "--format", "json"])) as { id: string };
  const url = `https://github.com/${OWNER}/${REPO}/issues/${issue}`;
  const item = JSON.parse(gh(["project", "item-add", PROJECT, "--owner", OWNER, "--url", url, "--format", "json"])) as { id: string };
  const fields = JSON.parse(gh(["project", "field-list", PROJECT, "--owner", OWNER, "--format", "json"])) as {
    fields: { id: string; name: string; options?: { id: string; name: string }[] }[];
  };

  for (const [fieldName, option] of [["Status", values.status], ["Kind", values.kind]] as const) {
    if (!option) continue;
    const field = fields.fields.find((f) => f.name === fieldName);
    const opt = field?.options?.find((o) => o.name === option);
    if (!field || !opt) throw new Error(`board has no ${fieldName} option '${option}'`);
    gh(["project", "item-edit", "--id", item.id, "--project-id", project.id, "--field-id", field.id, "--single-select-option-id", opt.id]);
  }
  console.log(`#${issue} on board:${values.status ? ` Status=${values.status}` : ""}${values.kind ? ` Kind=${values.kind}` : ""}`);
}

main();
