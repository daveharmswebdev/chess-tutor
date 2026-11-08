import { TutorReply } from "./contract.ts";

/**
 * TutorReply as the JSON Schema sent in output_config.format, written by hand so its shape is
 * exactly what spike 003 requires: every object closed and every property required, nullable
 * fields as anyOf [T, null], and no unsupported constraints (arrows.max(3) is checked by zod
 * after the reply arrives). schema.test.ts checks it against the zod TutorReply.
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
  },
  required: ["schemaVersion", "kind", "message", "reveal", "revealMove", "arrows"],
  additionalProperties: false,
} as const;

export type ParsedReply = { ok: true; reply: TutorReply } | { ok: false; problem: string };

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
  const parsed = TutorReply.safeParse(raw);
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
export function dropMalformedArrows(reply: TutorReply): TutorReply {
  const arrows = reply.arrows.filter((a) => SQUARE.test(a.from) && SQUARE.test(a.to) && a.from !== a.to);
  return arrows.length === reply.arrows.length ? reply : { ...reply, arrows };
}
