import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";

// The only identity in this app is the POS session (server/posAuth.ts),
// checked per procedure. The Manus OAuth user lookup that used to run here
// on every request is gone, together with its routes.
export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
};

export async function createContext(opts: CreateExpressContextOptions): Promise<TrpcContext> {
  return { req: opts.req, res: opts.res };
}
