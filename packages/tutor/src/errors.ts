import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type { TutorFailureReason } from "./contract.ts";

/**
 * Maps an SDK error to a failure reason by type (architecture §3.5), falling back to the HTTP
 * status for a plain APIError. Anything unexpected (a 400, a bug) is "api_unavailable": the
 * tutor is off for this request, the game goes on. The detail is the SDK's message, which
 * never contains the key.
 */
export function classifyError(err: unknown): { reason: TutorFailureReason; detail: string } {
  const detail = err instanceof Error ? err.message.slice(0, 200) : String(err);
  if (err instanceof APIUserAbortError) return { reason: "api_unavailable", detail: "aborted" };
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) return { reason: "auth", detail };
  if (err instanceof RateLimitError) return { reason: "rate_limited", detail };
  if (err instanceof APIConnectionError || err instanceof InternalServerError) return { reason: "api_unavailable", detail };
  if (err instanceof APIError) {
    if (err.status === 401 || err.status === 403) return { reason: "auth", detail };
    if (err.status === 429) return { reason: "rate_limited", detail };
  }
  return { reason: "api_unavailable", detail };
}
