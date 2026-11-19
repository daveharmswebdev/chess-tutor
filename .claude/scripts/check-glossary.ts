// NFR-18 (#83): docs/glossary.json holds client wording for every FR and NFR in
// docs/requirements.md, and for every dashboard event code in config/ops-events.json.
// Each requirement entry has a group and a label, or an `excluded` reason. IRs are exempt.
// Fails on a missing entry, a stale one (an ID or code that no longer exists), a duplicate,
// or a malformed entry. No network: the dashboard mirrors this file on merge (IR-10).
//
//   node --no-warnings .claude/scripts/check-glossary.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** FR and NFR IDs from the requirement tables: rows that start with `| FR-n` or `| NFR-n`. */
export function requirementIds(requirementsMd: string): string[] {
  const ids: string[] = [];
  for (const line of requirementsMd.split("\n")) {
    const m = /^\|\s*((?:FR|NFR)-\d+)\b/.exec(line);
    if (m?.[1]) ids.push(m[1]);
  }
  return ids;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function describe(v: unknown): string {
  return JSON.stringify(v)?.slice(0, 80) ?? String(v);
}

export function checkGlossary(input: {
  requirementsMd: string;
  glossary: unknown;
  eventCodes: unknown;
}): string[] {
  const problems: string[] = [];
  const g = input.glossary as { requirements?: unknown; events?: unknown } | null;
  if (!g || typeof g !== "object") return ["docs/glossary.json is not a JSON object"];
  if (!Array.isArray(g.requirements)) problems.push("docs/glossary.json has no `requirements` array");
  if (!Array.isArray(g.events)) problems.push("docs/glossary.json has no `events` array");
  if (!Array.isArray(input.eventCodes) || !input.eventCodes.every(nonEmpty)) {
    problems.push("config/ops-events.json `codes` must be an array of non-empty strings");
  }
  if (problems.length) return problems;

  // Requirements.
  const required = requirementIds(input.requirementsMd);
  const requiredSet = new Set(required);
  for (const id of new Set(required.filter((id, i) => required.indexOf(id) !== i))) {
    problems.push(`${id} appears more than once in docs/requirements.md`);
  }
  const seen = new Set<string>();
  for (const e of g.requirements as unknown[]) {
    const entry = e as { id?: unknown; group?: unknown; label?: unknown; excluded?: unknown };
    if (!entry || typeof entry !== "object" || !nonEmpty(entry.id)) {
      problems.push(`requirements entry without an id: ${describe(e)}`);
      continue;
    }
    const id = entry.id;
    if (seen.has(id)) problems.push(`${id}: duplicate entry`);
    seen.add(id);
    if (!requiredSet.has(id)) {
      problems.push(`${id}: stale entry, no such FR or NFR in docs/requirements.md`);
    }
    const worded = entry.label !== undefined || entry.group !== undefined;
    if (entry.excluded !== undefined) {
      if (!nonEmpty(entry.excluded)) problems.push(`${id}: \`excluded\` needs a reason`);
      if (worded) problems.push(`${id}: has both wording and \`excluded\`; pick one`);
    } else if (!nonEmpty(entry.label) || !nonEmpty(entry.group)) {
      problems.push(`${id}: needs a \`label\` and a \`group\`, or an \`excluded\` reason`);
    }
  }
  for (const id of requiredSet) {
    if (!seen.has(id)) problems.push(`${id}: missing, add a label and group or an \`excluded\` reason`);
  }

  // Event codes.
  const codes = new Set(input.eventCodes as string[]);
  const seenCodes = new Set<string>();
  for (const e of g.events as unknown[]) {
    const entry = e as { code?: unknown; label?: unknown };
    if (!entry || typeof entry !== "object" || !nonEmpty(entry.code)) {
      problems.push(`events entry without a code: ${describe(e)}`);
      continue;
    }
    const code = entry.code;
    if (seenCodes.has(code)) problems.push(`event ${code}: duplicate entry`);
    seenCodes.add(code);
    if (!codes.has(code)) problems.push(`event ${code}: stale entry, not in config/ops-events.json`);
    if (!nonEmpty(entry.label)) problems.push(`event ${code}: needs a \`label\``);
  }
  for (const code of codes) {
    if (!seenCodes.has(code)) problems.push(`event ${code}: missing, add a \`label\``);
  }
  return problems;
}

function main(): void {
  const root = resolve(import.meta.dirname, "../..");
  const read = (p: string) => readFileSync(resolve(root, p), "utf8");
  const problems = checkGlossary({
    requirementsMd: read("docs/requirements.md"),
    glossary: JSON.parse(read("docs/glossary.json")),
    eventCodes: (JSON.parse(read("config/ops-events.json")) as { codes?: unknown }).codes,
  });
  if (problems.length) {
    for (const p of problems) console.error(`::error file=docs/glossary.json::${p}`);
    console.error(`\ndocs/glossary.json is out of step (NFR-18): ${problems.length} problem(s).`);
    process.exit(1);
  }
  console.log("docs/glossary.json covers every FR, NFR and event code (NFR-18).");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
