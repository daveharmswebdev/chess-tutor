import { z } from "zod";
import { TutorReply } from "./contract.ts";

/**
 * One evaluation the tutor quotes (#26): `side`'s point of view, positive = good for that side.
 * Exactly one of `cp` (centipawns) and `mate` (mate in N; positive = `side` mates) is a number.
 */
export const EvalEntry = z
  .object({
    side: z.enum(["white", "black"]),
    cp: z.number().int().nullable(),
    mate: z.number().int().nullable(),
  })
  .refine((e) => (e.cp === null) !== (e.mate === null), { message: "exactly one of cp and mate must be a number, the other null" });
export type EvalEntry = z.infer<typeof EvalEntry>;

/**
 * The reply as the MODEL writes it (#26): the public TutorReply plus `evals`, every evaluation
 * the text quotes. The claims check uses `evals`; session.ts strips it before the reply leaves
 * the package, so the public TutorReply (contract.ts, schemaVersion 1) is unchanged.
 */
export const TutorDraft = TutorReply.extend({ evals: z.array(EvalEntry) });
export type TutorDraft = z.infer<typeof TutorDraft>;

const nullableInteger = { anyOf: [{ type: "integer" }, { type: "null" }] } as const;

/**
 * TutorDraft as the JSON Schema sent in output_config.format, written by hand so its shape is
 * exactly what spike 003 requires: every object closed and every property required, nullable
 * fields as anyOf [T, null], and no unsupported constraints (arrows.max(3) and the evals
 * one-of-cp-or-mate rule are checked by zod after the reply arrives). schema.test.ts checks it
 * against the zod TutorDraft.
 */
export const TUTOR_REPLY_JSON_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    kind: { type: "string", enum: [...TutorReply.shape.kind.options] },
    message: { type: "string" },
    reveal: { anyOf: [{ type: "string" }, { type: "null" }] },
    revealMove: { anyOf: [{ type: "string" }, { type: "null" }] },
    arrows: {
      type: "array",
      items: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
    evals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          side: { type: "string", enum: [...EvalEntry.shape.side.options] },
          cp: nullableInteger,
          mate: nullableInteger,
        },
        required: ["side", "cp", "mate"],
        additionalProperties: false,
      },
    },
  },
  required: ["schemaVersion", "kind", "message", "reveal", "revealMove", "arrows", "evals"],
  additionalProperties: false,
} as const;

export type ParsedReply = { ok: true; reply: TutorDraft } | { ok: false; problem: string };

const SQUARE = /^[a-h][1-8]$/;

/**
 * Parses and validates the final text (NFR-8). Normalises the case of `kind` first (spike 003:
 * enum values may come back in a different case) and checks it matches the request.
 */
export function parseReply(text: string, expectedKind: TutorReply["kind"]): ParsedReply {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, problem: "Your reply was not valid JSON. Reply with only the JSON object, nothing else." };
  }
  if (raw && typeof raw === "object" && typeof (raw as { kind?: unknown }).kind === "string") {
    const r = raw as { kind: string };
    raw = { ...r, kind: r.kind.trim().toLowerCase().replace(/[\s-]+/g, "_") };
  }
  const parsed = TutorDraft.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, problem: `Your reply did not match the schema: ${issues}.` };
  }
  const reply = parsed.data;
  if (reply.kind !== expectedKind) {
    return { ok: false, problem: `kind must be "${expectedKind}" for this request, not "${reply.kind}".` };
  }
  return { ok: true, reply };
}

/**
 * FR-11: drops arrows that are not between two different real squares (h7->h7, e2->e9). They
 * cannot be drawn and are not worth a correction round; the rest of the reply stays as it is.
 */
export function dropMalformedArrows<T extends Pick<TutorReply, "arrows">>(reply: T): T {
  const arrows = reply.arrows.filter((a) => SQUARE.test(a.from) && SQUARE.test(a.to) && a.from !== a.to);
  return arrows.length === reply.arrows.length ? reply : { ...reply, arrows };
}

/** The public TutorReply: the draft without `evals` (#26). */
export function publicReply(draft: TutorDraft): TutorReply {
  const { evals: _evals, ...reply } = draft;
  return reply;
}
