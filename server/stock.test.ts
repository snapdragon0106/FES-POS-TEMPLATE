import { describe, expect, it } from "vitest";
import type { Payment, Product, Restock, Transaction } from "../drizzle/schema";
import {
  RESERVATION_TTL_MS,
  computeStock,
  findInsufficientStock,
  isReservationActive,
  paymentLines,
  reservedQuantities,
  sameCart,
} from "./stock";

/**
 * Stock arithmetic, tested without a database.
 *
 * The reservation rules are the part worth pinning down: they decide
 * whether two registers can sell the same last item while one customer's
 * card is still being read.
 */

const NOW = new Date("2026-08-15T10:00:00Z").getTime();

function product(id: number, name: string, initialStock: number): Product {
  return {
    id,
    name,
    emoji: "🐙",
    price: 400,
    cost: 150,
    initialStock,
    threshold: 10,
    displayOrder: id,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
}

function transaction(items: { product_id: number; qty: number }[], voided = false): Transaction {
  return {
    id: 1,
    operator: "3509",
    items,
    total: 0,
    received: 0,
    changeAmount: 0,
    voided,
    paymentMethod: "cash",
    paymentStatus: "completed",
    paymentId: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  } as Transaction;
}

function restock(productId: number, amount: number): Restock {
  return {
    id: 1,
    productId,
    amount,
    operator: "3509",
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
}

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 1,
    provider: "mock",
    providerPaymentId: "mock_1",
    providerRef: null,
    method: "paypay",
    status: "pending",
    amount: 400,
    items: [{ product_id: 1, qty: 1 }],
    orderRef: "order-1",
    operator: "3509",
    transactionId: null,
    rawPayload: null,
    errorMessage: null,
    expiresAt: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  } as Payment;
}

describe("stock", () => {
  describe("computeStock", () => {
    it("derives stock as initial − sold + restocked", () => {
      const { available } = computeStock({
        products: [product(1, "たこ焼き", 50)],
        transactions: [transaction([{ product_id: 1, qty: 8 }])],
        restocks: [restock(1, 5)],
        now: NOW,
      });

      expect(available[1]).toBe(47);
    });

    it("counts a restock scheduled for a later day only from 0:00 that day (Japan time)", () => {
      const product50 = product(1, "たこ焼き", 50);
      const day2: Restock = { ...restock(1, 80), availableOn: "2026-10-04" };
      const at = (iso: string) =>
        computeStock({ products: [product50], transactions: [transaction([{ product_id: 1, qty: 30 }])], restocks: [day2], now: new Date(iso).getTime() }).available[1];
      expect(at("2026-10-03T23:59:59+09:00")).toBe(20); // day 1: only today's stock
      expect(at("2026-10-04T00:00:00+09:00")).toBe(100); // day 2: leftovers + day 2's share
      // Unscheduled restocks count at once, as before.
      expect(computeStock({ products: [product50], transactions: [], restocks: [{ ...restock(1, 5), availableOn: null }], now: NOW }).available[1]).toBe(55);
    });

    it("ignores voided sales", () => {
      const { available } = computeStock({
        products: [product(1, "たこ焼き", 50)],
        transactions: [transaction([{ product_id: 1, qty: 8 }], true)],
        restocks: [],
        now: NOW,
      });

      expect(available[1]).toBe(50);
    });

    it("subtracts stock held by an in-flight payment", () => {
      const { available, reserved } = computeStock({
        products: [product(1, "たこ焼き", 3)],
        transactions: [],
        restocks: [],
        openPayments: [payment({ items: [{ product_id: 1, qty: 2 }] })],
        now: NOW,
      });

      expect(reserved[1]).toBe(2);
      expect(available[1]).toBe(1);
    });

    // The checkout consuming a payment must not be blocked by that
    // payment's own reservation — it reserved those very items.
    it("excludes the payment being consumed", () => {
      const { available } = computeStock({
        products: [product(1, "たこ焼き", 2)],
        transactions: [],
        restocks: [],
        openPayments: [payment({ id: 7, items: [{ product_id: 1, qty: 2 }] })],
        now: NOW,
        excludePaymentId: 7,
      });

      expect(available[1]).toBe(2);
    });

    // Otherwise the same goods would be subtracted twice: once as a
    // reservation and once as the sale it turned into.
    it("stops reserving once the payment became a sale", () => {
      const { available } = computeStock({
        products: [product(1, "たこ焼き", 3)],
        transactions: [transaction([{ product_id: 1, qty: 2 }])],
        restocks: [],
        openPayments: [payment({ items: [{ product_id: 1, qty: 2 }], transactionId: 1 })],
        now: NOW,
      });

      expect(available[1]).toBe(1);
    });
  });

  describe("isReservationActive", () => {
    it("holds stock for a pending payment", () => {
      expect(isReservationActive(payment(), NOW)).toBe(true);
    });

    it("holds stock for an authorized payment", () => {
      expect(isReservationActive(payment({ status: "authorized" }), NOW)).toBe(true);
    });

    it.each(["completed", "failed", "canceled", "expired", "refunded"])(
      "releases stock once the payment is %s",
      (status) => {
        expect(isReservationActive(payment({ status }), NOW)).toBe(false);
      }
    );

    // A cashier who walks away mid-payment must not strand inventory for
    // the rest of the festival.
    it("ages out after the TTL", () => {
      const stale = payment({ createdAt: new Date(NOW - RESERVATION_TTL_MS - 1000) });
      expect(isReservationActive(stale, NOW)).toBe(false);
    });

    it("honours a provider expiry that is shorter than the TTL", () => {
      const shortLived = payment({ expiresAt: new Date(NOW - 1000) });
      expect(isReservationActive(shortLived, NOW)).toBe(false);
    });

    // A provider handing out a 30-minute QR must not hold a festival's
    // stock for 30 minutes.
    it("does not let a long provider expiry outlast the TTL", () => {
      const longLived = payment({
        createdAt: new Date(NOW - RESERVATION_TTL_MS - 1000),
        expiresAt: new Date(NOW + 60 * 60 * 1000),
      });
      expect(isReservationActive(longLived, NOW)).toBe(false);
    });
  });

  describe("reservedQuantities", () => {
    it("sums across payments and products", () => {
      const reserved = reservedQuantities(
        [
          payment({ id: 1, items: [{ product_id: 1, qty: 2 }, { product_id: 2, qty: 1 }] }),
          payment({ id: 2, items: [{ product_id: 1, qty: 3 }] }),
        ],
        NOW
      );

      expect(reserved).toEqual({ 1: 5, 2: 1 });
    });

    it("ignores payments with no stored cart", () => {
      expect(reservedQuantities([payment({ items: null })], NOW)).toEqual({});
    });
  });

  describe("paymentLines", () => {
    it("drops malformed entries rather than trusting stored JSON", () => {
      const lines = paymentLines(
        payment({ items: [{ product_id: 1, qty: 2 }, { nope: true }, null, "x"] as any })
      );
      expect(lines).toEqual([{ product_id: 1, qty: 2 }]);
    });
  });

  describe("findInsufficientStock", () => {
    const snapshot = { available: { 1: 3 }, reserved: {}, names: { 1: "たこ焼き" } };

    it("accepts a cart that fits", () => {
      expect(findInsufficientStock([{ product_id: 1, qty: 3 }], snapshot)).toBeNull();
    });

    it("names the product that does not fit", () => {
      expect(findInsufficientStock([{ product_id: 1, qty: 4 }], snapshot)).toBe("たこ焼き");
    });

    // Two lines for one product must be checked against the running
    // balance, not each against the same starting figure.
    it("checks duplicate lines against a running balance", () => {
      expect(
        findInsufficientStock(
          [{ product_id: 1, qty: 2 }, { product_id: 1, qty: 2 }],
          snapshot
        )
      ).toBe("たこ焼き");
    });
  });

  describe("sameCart", () => {
    it("ignores ordering and line splitting", () => {
      expect(
        sameCart(
          [{ product_id: 1, qty: 2 }, { product_id: 2, qty: 1 }],
          [{ product_id: 2, qty: 1 }, { product_id: 1, qty: 1 }, { product_id: 1, qty: 1 }]
        )
      ).toBe(true);
    });

    it("rejects a different quantity", () => {
      expect(sameCart([{ product_id: 1, qty: 2 }], [{ product_id: 1, qty: 3 }])).toBe(false);
    });

    // Same money, different goods — which is exactly the swap that a
    // total-only check would wave through.
    it("rejects a swap between equally priced products", () => {
      expect(sameCart([{ product_id: 1, qty: 1 }], [{ product_id: 2, qty: 1 }])).toBe(false);
    });

    it("rejects an extra product", () => {
      expect(
        sameCart([{ product_id: 1, qty: 1 }], [{ product_id: 1, qty: 1 }, { product_id: 2, qty: 1 }])
      ).toBe(false);
    });
  });
});
