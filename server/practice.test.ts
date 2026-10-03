import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

vi.mock("./posAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./posAuth")>();
  return { ...actual, verifyPosSession: vi.fn(), readDevice: vi.fn().mockResolvedValue({ did: "0".repeat(32), ids: ["3501", "3509"] }) };
});

const store = vi.hoisted(() => ({ logs: [] as any[], seeded: [] as any[], cleanupArgs: [] as any[] }));
vi.mock("./db", () => ({
  practiceSummary: vi.fn(async () => ({ products: [], sales: [], cashEvents: [] })),
  seedPracticeProducts: vi.fn(async (defs: any[]) => {
    store.seeded = defs;
    return { adopted: 0, created: defs.length };
  }),
  cleanupPractice: vi.fn(async (ids: number[]) => {
    store.cleanupArgs.push(ids);
    return { products: 3, sales: 5, restocks: 0, cashEvents: ids.length, orderNo: 2 };
  }),
  createActivityLog: vi.fn(async (row: any) => {
    store.logs.push(row);
  }),
}));

import { appRouter } from "./routers";
import * as handover from "./handover";

const ctx = () =>
  ({
    req: { protocol: "https", headers: { cookie: "pos_session=x" } },
    res: { cookie: vi.fn(), clearCookie: vi.fn() },
  }) as unknown as TrpcContext;

describe("practice products (練習)", () => {
  let posAuth: any;
  const as = async (operatorId: string) => {
    posAuth.verifyPosSession.mockResolvedValue({ operatorId, operatorName: "", exp: 0, pv: "x", jti: "j", auth: 0 });
    return appRouter.createCaller(ctx());
  };
  beforeEach(async () => {
    store.logs = [];
    store.seeded = [];
    store.cleanupArgs = [];
    posAuth = await import("./posAuth");
  });

  it("is admin only: a member can't add practice products or delete sales with cleanup", async () => {
    const member = await as("3501");
    await expect(member.practice.status()).rejects.toThrow();
    await expect(member.practice.seed()).rejects.toThrow();
    await expect(member.practice.cleanup({ cashEventIds: [] })).rejects.toThrow();
    expect(store.cleanupArgs).toHaveLength(0);
  });

  it("seed adds ¥100 practice products (one with little stock) and logs it", async () => {
    const admin = await as("3509");
    expect(await admin.practice.seed()).toEqual({ adopted: 0, created: 3 });
    expect(store.seeded.every((p) => p.price === 100 && p.name.startsWith("【練習】"))).toBe(true);
    expect(store.seeded.some((p) => p.initialStock <= 3)).toBe(true);
    expect(store.logs.at(-1)).toMatchObject({ operator: "3509", action: "practice_seed" });
  });

  it("cleanup passes the chosen cash records, refreshes the handover queue and logs what was removed", async () => {
    const spy = vi.spyOn(handover, "handoverChanged");
    const admin = await as("3509");
    const r = await admin.practice.cleanup({ cashEventIds: [4, 7] });
    expect(store.cleanupArgs).toEqual([[4, 7]]);
    expect(r).toMatchObject({ sales: 5, cashEvents: 2 });
    expect(spy).toHaveBeenCalled();
    expect(store.logs.at(-1)).toMatchObject({ action: "practice_cleanup" });
    expect(store.logs.at(-1).detail).toContain("会計5件");
    expect(store.logs.at(-1).detail).toContain("3番から");
  });
});
