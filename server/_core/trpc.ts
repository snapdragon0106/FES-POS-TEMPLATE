import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const GENERIC_SERVER_ERROR =
  "サーバーでエラーが発生しました。少し待ってからもう一度お試しください。";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  // What the cashier sees when something fails. Two cases get rewritten:
  //
  //  - An unexpected exception (DB unreachable, a bug). tRPC wraps it as
  //    INTERNAL_SERVER_ERROR with the original error as `cause`, and by
  //    default forwards its message — for a DB failure that is the literal
  //    SQL query ("Failed query: select `id`, …"), shown in a toast at the
  //    register. Replaced with a plain instruction; the real cause is
  //    logged server-side (onError in _core/index.ts). Errors we throw on
  //    purpose carry no `cause` and keep their message.
  //  - Input validation. The default message is zod's JSON dump of every
  //    issue; the first issue's own message is the readable part.
  errorFormatter({ shape, error }) {
    if (error.code === "INTERNAL_SERVER_ERROR" && error.cause !== undefined) {
      return { ...shape, message: GENERIC_SERVER_ERROR };
    }
    const issues = (error.cause as { issues?: { message?: unknown }[] } | undefined)?.issues;
    if (error.code === "BAD_REQUEST" && Array.isArray(issues) && typeof issues[0]?.message === "string") {
      return { ...shape, message: issues[0].message };
    }
    return shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
