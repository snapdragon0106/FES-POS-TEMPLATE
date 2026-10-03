import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

vi.mock("./posAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./posAuth")>();
  return { ...actual, verifyPosSession: vi.fn(), readDevice: vi.fn().mockResolvedValue({ did: "0".repeat(32), ids: ["3501", "3509"] }) };
});

// The sales table as the handover queries see it, in memory.
const store = vi.hoisted(() => ({ rows: [] as any[], reads: 0, logs: [] as any[] }));
vi.mock("./db", () => ({
  listHandoverOrders: vi.fn(async () => {
    store.reads++;
    return store.rows.filter((r) => !r.voided && (r.handoverPending || r.handedAt)).map((r) => ({ ...r }));
  }),
  markHandedOver: vi.fn(async (id: number, by: string) => {
    const r = store.rows.find((x) => x.id === id && x.handoverPending && !x.voided);
    if (!r) return false;
    Object.assign(r, { handoverPending: false, handedAt: new Date(), handedBy: by });
    return true;
  }),
  undoHandedOver: vi.fn(async (id: number) => {
    const r = store.rows.find((x) => x.id === id && !x.handoverPending && x.handedAt && !x.voided);
    if (!r) return false;
    Object.assign(r, { handoverPending: true, handedAt: null, handedBy: null });
    return true;
  }),
  markAllHandedOver: vi.fn(async (by: string) => {
    const waiting = store.rows.filter((x) => x.handoverPending);
    waiting.forEach((r) => Object.assign(r, { handoverPending: false, handedAt: new Date(), handedBy: by }));
    return waiting.length;
  }),
  createActivityLog: vi.fn(async (row: any) => { store.logs.push(row); }),
}));

import { appRouter } from "./routers";
import { __resetHandoverCache, handoverChanged } from "./handover";

const ctx = () =>
  ({
    req: { protocol: "https", headers: { cookie: "pos_session=x" } },
    res: { cookie: vi.fn(), clearCookie: vi.fn() },
  }) as unknown as TrpcContext;

const sale = (id: number, orderNo: number, extra: Record<string, unknown> = {}) => ({
  id, orderNo, operator: "3509", voided: false, handoverPending: true, handedAt: null, handedBy: null,
  createdAt: new Date(), items: [{ product_id: 1, name: "コーラ", emoji: "🥤", price: 100, cost: 46, qty: 2 }], ...extra,
});

describe("handover counter (受け渡し)", () => {
  let caller: ReturnType<typeof appRouter.createCaller>;
  let posAuth: any;
  beforeEach(async () => {
    store.rows = [];
    store.reads = 0;
    store.logs = [];
    __resetHandoverCache();
    posAuth = await import("./posAuth");
    posAuth.verifyPosSession.mockResolvedValue({ operatorId: "3501", operatorName: "", exp: 0, pv: "x", jti: "j", auth: 0 });
    caller = appRouter.createCaller(ctx());
  });

  it("only for a logged-in session", async () => {
    posAuth.verifyPosSession.mockResolvedValue(null);
    await expect(caller.handover.queue()).rejects.toThrow("POSセッションが無効です");
    await expect(caller.handover.complete({ id: 1 })).rejects.toThrow("POSセッションが無効です");
  });

  it("lists today's waiting orders oldest first, with number and goods only (no prices)", async () => {
    const yesterday = new Date(Date.now() - 36 * 3600_000);
    store.rows = [sale(3, 2), sale(2, 1), sale(9, 7, { createdAt: yesterday }), sale(4, 3, { voided: true })];
    store.rows[0].createdAt = new Date(Date.now() - 1000);
    store.rows[1].createdAt = new Date(Date.now() - 2000);
    const q = await caller.handover.queue();
    // listHandoverOrders already returns them oldest first; the queue keeps that order.
    expect(q.pending.map((o) => o.orderNo)).toEqual([2, 1]);
    expect(q.pending[0].items).toEqual([{ name: "コーラ", emoji: "🥤", qty: 2 }]);
    expect(JSON.stringify(q)).not.toContain("price");
  });

  it("answers from memory until something changes: the counter's 2-second polling costs no database reads", async () => {
    store.rows = [sale(1, 1)];
    await caller.handover.queue();
    await caller.handover.queue();
    await caller.handover.queue();
    expect(store.reads).toBe(1);
    store.rows.push(sale(2, 2));
    handoverChanged(); // what transaction.create does after a sale
    expect((await caller.handover.queue()).pending).toHaveLength(2);
    expect(store.reads).toBe(2);
  });

  it("渡した moves an order to the recent list; a second tap is not an error; 戻す puts it back", async () => {
    store.rows = [sale(1, 1), sale(2, 2)];
    expect(await caller.handover.complete({ id: 1 })).toEqual({ success: true, already: false });
    let q = await caller.handover.queue();
    expect(q.pending.map((o) => o.id)).toEqual([2]);
    expect(q.recent.map((o) => o.id)).toEqual([1]);
    expect(q.recent[0].handedBy).toBe("3501");
    expect(await caller.handover.complete({ id: 1 })).toEqual({ success: true, already: true });
    await caller.handover.undo({ id: 1 });
    q = await caller.handover.queue();
    expect(q.pending.map((o) => o.id).sort()).toEqual([1, 2]);
    await expect(caller.handover.undo({ id: 2 })).rejects.toThrow("戻せる注文がありません");
  });

  it("すべて渡した clears the queue and is logged", async () => {
    store.rows = [sale(1, 1), sale(2, 2), sale(3, 3)];
    expect(await caller.handover.completeAll()).toEqual({ count: 3 });
    expect((await caller.handover.queue()).pending).toHaveLength(0);
    expect(store.logs.at(-1)).toMatchObject({ operator: "3501", action: "handover_all" });
  });
});
