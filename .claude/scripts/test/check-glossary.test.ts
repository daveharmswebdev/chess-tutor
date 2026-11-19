import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkGlossary, requirementIds } from "../check-glossary.ts";

const md = `
| ID | Requirement | Source |
|---|---|---|
| FR-1 | Play a game. | BR-1 |
| FR-2 | Opening book. | BR-1 |
| NFR-1 **Responsiveness** | Fast. | BR-1 |
| IR-1 | Node. | NFR-13 |
| BR-6 Client transparency | FR-26–31 | NFR-15, 16 | IR-10 |
`;

const ok = () => ({
  requirements: [
    { id: "FR-1", group: "Playing games", label: "Start a game" },
    { id: "FR-2", group: "Playing games", label: "Human-like openings" },
    { id: "NFR-1", excluded: "Internal." },
  ],
  events: [{ code: "tutor.reply", label: "The tutor answered" }],
});

const run = (glossary: unknown, eventCodes: unknown = ["tutor.reply"]) =>
  checkGlossary({ requirementsMd: md, glossary, eventCodes });

describe("check-glossary (NFR-18)", () => {
  it("reads FR and NFR rows only, not IRs or the traceability matrix", () => {
    expect(requirementIds(md)).toEqual(["FR-1", "FR-2", "NFR-1"]);
  });

  it("passes when every requirement and event code is covered", () => {
    expect(run(ok())).toEqual([]);
  });

  it("names a missing requirement", () => {
    const g = ok();
    g.requirements = g.requirements.filter((e) => e.id !== "FR-2");
    expect(run(g)).toEqual(["FR-2: missing, add a label and group or an `excluded` reason"]);
  });

  it("names a stale requirement", () => {
    const g = ok();
    g.requirements.push({ id: "FR-99", group: "X", label: "Gone" });
    expect(run(g)).toEqual(["FR-99: stale entry, no such FR or NFR in docs/requirements.md"]);
  });

  it("names a duplicate requirement", () => {
    const g = ok();
    g.requirements.push({ id: "FR-1", group: "X", label: "Again" });
    expect(run(g)).toEqual(["FR-1: duplicate entry"]);
  });

  it("rejects an entry with neither wording nor a reason, or with both", () => {
    const g = ok();
    g.requirements[0] = { id: "FR-1", group: "Playing games" } as never;
    g.requirements[2] = { id: "NFR-1", excluded: "Internal.", label: "Fast" } as never;
    expect(run(g)).toEqual([
      "FR-1: needs a `label` and a `group`, or an `excluded` reason",
      "NFR-1: has both wording and `excluded`; pick one",
    ]);
  });

  it("rejects an empty exclusion reason", () => {
    const g = ok();
    g.requirements[2] = { id: "NFR-1", excluded: " " };
    expect(run(g)).toEqual(["NFR-1: `excluded` needs a reason"]);
  });

  it("names missing, stale and duplicate event codes", () => {
    expect(run(ok(), ["tutor.reply", "explorer.down"])).toEqual(["event explorer.down: missing, add a `label`"]);
    expect(run(ok(), [])).toEqual(["event tutor.reply: stale entry, not in config/ops-events.json"]);
    const g = ok();
    g.events.push({ code: "tutor.reply", label: "Again" });
    expect(run(g)).toEqual(["event tutor.reply: duplicate entry"]);
  });

  it("fails on a missing events section or a malformed code list", () => {
    const { events: _, ...noEvents } = ok();
    expect(run(noEvents)).toEqual(["docs/glossary.json has no `events` array"]);
    expect(run(ok(), "tutor.reply")).toEqual(["config/ops-events.json `codes` must be an array of non-empty strings"]);
  });

  it("the repo's own glossary is in step with requirements.md", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const read = (p: string) => readFileSync(resolve(root, p), "utf8");
    expect(
      checkGlossary({
        requirementsMd: read("docs/requirements.md"),
        glossary: JSON.parse(read("docs/glossary.json")),
        eventCodes: JSON.parse(read("config/ops-events.json")).codes,
      }),
    ).toEqual([]);
  });
});
