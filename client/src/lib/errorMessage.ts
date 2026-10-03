import { TRPCClientError } from "@trpc/client";

/**
 * True when no proper answer came back from the server at all: the phone
 * is offline, the request timed out, the server is down (Render answers
 * with an HTML error page, which isn't a tRPC response), and so on.
 *
 * Every response the server actually produces — including its own errors
 * like 在庫不足 or a wrong PIN — carries `data`; only a failure to get a
 * response leaves it empty. That makes this the question the cashier
 * needs answered: "did the server say no, or did the server not answer?"
 */
export function isConnectionError(err: unknown): boolean {
  if (err instanceof TRPCClientError) return !err.data;
  if (err instanceof TypeError) return true; // fetch's "Failed to fetch"
  return err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
}

export const CONNECTION_ERROR_MESSAGE =
  "サーバーに接続できませんでした。電波を確認して、もう一度お試しください。";

/**
 * tRPC's TRPCClientError extends Error and carries the server's TRPCError
 * message (e.g. "たこ焼きの在庫が不足しています") as `.message` when the
 * server threw a known error. Falling back to a generic string only for
 * errors with no message (non-Error throws) means the cashier actually sees
 * why an action failed instead of always getting the same unhelpful toast.
 *
 * Connection failures are the exception: their raw message is whatever the
 * browser says ("Failed to fetch", "Load failed", "signal is aborted…",
 * "Unexpected token '<'"), which means nothing to a cashier, so they get
 * one consistent Japanese message instead.
 */
export function getErrorMessage(err: unknown, fallback: string): string {
  if (isConnectionError(err)) return CONNECTION_ERROR_MESSAGE;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
