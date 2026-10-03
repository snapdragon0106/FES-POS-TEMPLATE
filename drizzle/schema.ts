import { mysqlTable, int, varchar, timestamp, boolean, json, text, mediumtext, bigint, index } from "drizzle-orm/mysql-core";

/**
 * Products table
 */
export const products = mysqlTable("products", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  emoji: varchar("emoji", { length: 10 }).notNull(),
  price: int("price").notNull(),
  cost: int("cost").notNull(),
  initialStock: int("initialStock").notNull(),
  threshold: int("threshold").notNull(),
  displayOrder: int("displayOrder").notNull().default(0),
  // Content hash of the product's photo in product_images, or null when it
  // has none (the emoji is shown instead). Only this short hash travels
  // with the product list — which every register polls every 8 seconds —
  // and doubles as the cache key in the image URL, so a phone downloads
  // each photo once and a changed photo is a new URL.
  imageHash: varchar("imageHash", { length: 64 }),
  // A practice product (練習用), added by practice.seed for rehearsing at
  // the register. practice.cleanup removes these with every sale that
  // contains one, so the rehearsal leaves nothing in the day's takings.
  practice: boolean("practice").notNull().default(false),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;

/**
 * Product photos, one per product, kept out of `products` so that the
 * polled product list and the checkout's SELECT ... FOR UPDATE never read
 * image bytes. Served by GET /api/product-images/:id (server/productImage.ts).
 * `data` is base64 of an already-downscaled image (~10–30 KB); the size
 * cap is enforced server-side in parseImageDataUrl.
 */
export const productImages = mysqlTable("product_images", {
  productId: int("productId").primaryKey(),
  mime: varchar("mime", { length: 32 }).notNull(),
  data: mediumtext("data").notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ProductImage = typeof productImages.$inferSelect;

/**
 * The cash drawer's own ledger (shared/cash.ts has the arithmetic):
 *   float   — 釣り銭 put in the box at opening; starts a business day
 *   collect — money moved from the box to the 本部 safe
 *   count   — the closing count; `expected` is what the box should have
 *             held at that moment, frozen server-side, so the difference
 *             recorded stays what it was even if a sale is voided later
 * `breakdown` is the count per denomination where one was entered.
 * Append-only apart from admin deletion of a mistaken entry.
 */
export const cashEvents = mysqlTable("cash_events", {
  id: int("id").autoincrement().primaryKey(),
  kind: varchar("kind", { length: 16 }).notNull(),
  amount: int("amount").notNull(),
  breakdown: json("breakdown"),
  expected: int("expected"),
  note: varchar("note", { length: 255 }),
  // Who provided the float (float) / who it was given back to (return),
  // so "was the float paid back in full?" has an answer at the end.
  party: varchar("party", { length: 50 }),
  operator: varchar("operator", { length: 10 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type CashEvent = typeof cashEvents.$inferSelect;
export type InsertCashEvent = typeof cashEvents.$inferInsert;

/** Small shop-wide settings shared by every register (key → value). */
export const appSettings = mysqlTable("app_settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: varchar("value", { length: 255 }).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/**
 * Transactions table
 *
 * paymentMethod/paymentStatus/paymentId were added for cashless support.
 * They all default to the cash case ("cash" / "completed" / null), so a
 * row written by an older build — or by any code path that never mentions
 * payment — still reads back as a completed cash sale, which is exactly
 * what it was.
 *
 * For cashless sales `received` equals `total` and `changeAmount` is 0
 * (enforced server-side in transaction.create): there is no cash drawer
 * movement, so reusing those columns to mean anything else would corrupt
 * the till reconciliation.
 */
export const transactions = mysqlTable("transactions", {
  id: int("id").autoincrement().primaryKey(),
  operator: varchar("operator", { length: 10 }).notNull(),
  items: json("items").notNull(), // [{product_id, name, emoji, price, cost, qty}]
  total: int("total").notNull(),
  received: int("received").notNull(),
  changeAmount: int("changeAmount").notNull(),
  voided: boolean("voided").notNull().default(false),
  paymentMethod: varchar("paymentMethod", { length: 20 }).notNull().default("cash"),
  paymentStatus: varchar("paymentStatus", { length: 20 }).notNull().default("completed"),
  paymentId: int("paymentId"), // → payments.id, null for cash
  // Slip / approval number, copied from the payment at the moment of sale.
  // Denormalised on purpose, exactly like items[] already snapshots the
  // product name and price: this is an accounting record, and the figure
  // it needs is the one that was true when the sale happened. It also
  // keeps the CSV export a single-table read.
  paymentRef: varchar("paymentRef", { length: 191 }),
  // Idempotency key minted by the register for one checkout attempt and
  // reused on every retry of it. On festival Wi-Fi a request can reach the
  // server and commit while its response is lost; the cashier then sees an
  // error and presses 確定 again. Without this key that second press books
  // the same sale twice. UNIQUE, nullable (rows from before this existed,
  // and callers that don't send one, stay NULL — MySQL/TiDB allow many).
  clientRequestId: varchar("clientRequestId", { length: 64 }).unique(),
  // The number the customer is told at the register and called out at the
  // handover counter (受け渡し). Counts from 1 each day (Japan time), handed
  // out inside the checkout transaction (db.createTransactionSerialized).
  // Null on sales from before it existed.
  orderNo: int("orderNo"),
  // Waiting to be handed over at the counter. Set on every new sale; the
  // default (false) is what rows from before this existed get, so they
  // don't all turn up as waiting orders.
  handoverPending: boolean("handoverPending").notNull().default(false),
  handedAt: timestamp("handedAt"),
  handedBy: varchar("handedBy", { length: 10 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Transaction = typeof transactions.$inferSelect;
export type InsertTransaction = typeof transactions.$inferInsert;

/**
 * Restocks table
 */
export const restocks = mysqlTable("restocks", {
  id: int("id").autoincrement().primaryKey(),
  productId: int("productId").notNull(),
  amount: int("amount").notNull(),
  operator: varchar("operator", { length: 10 }).notNull(),
  // "YYYY-MM-DD" (Japan time) from which this restock counts as stock —
  // e.g. day 2's share, entered ahead. Null: from the moment it was entered.
  // A string, not DATE, so no driver or server timezone can shift the day.
  availableOn: varchar("availableOn", { length: 10 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Restock = typeof restocks.$inferSelect;
export type InsertRestock = typeof restocks.$inferInsert;

/**
 * Activity logs table
 */
export const activityLogs = mysqlTable("activity_logs", {
  id: int("id").autoincrement().primaryKey(),
  operator: varchar("operator", { length: 10 }).notNull(),
  operatorName: varchar("operatorName", { length: 50 }).notNull().default(""),
  action: varchar("action", { length: 30 }).notNull(),
  detail: varchar("detail", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ActivityLog = typeof activityLogs.$inferSelect;
export type InsertActivityLog = typeof activityLogs.$inferInsert;

/**
 * Member PINs table — pin column widened to VARCHAR(255) to hold a
 * salted hash ("salt:hash", ~160 chars) instead of a bare 4-digit PIN.
 */
export const memberPins = mysqlTable("member_pins", {
  id: int("id").autoincrement().primaryKey(),
  memberId: varchar("memberId", { length: 10 }).notNull().unique(),
  pin: varchar("pin", { length: 255 }).notNull(),
  // A PIN chosen at first login is not usable until an admin approves it
  // (server/login.ts): otherwise anyone who knew the 合言葉 could claim a
  // classmate who hadn't logged in yet just by typing their number.
  // Existing rows (and PINs an admin sets) are approved.
  approved: boolean("approved").notNull().default(true),
  // Shown only to the device that asked for a waiting PIN; the admin types
  // it in, read off that person's screen, to approve (server/login.ts). So
  // a PIN someone else asked for under a classmate's number can't be
  // approved by mistake. Null once approved, and on rows from before.
  requestCode: varchar("requestCode", { length: 8 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type MemberPin = typeof memberPins.$inferSelect;
export type InsertMemberPin = typeof memberPins.$inferInsert;

/**
 * Accounting entries table — tracks money the POS system itself never
 * otherwise sees: ingredient/goods purchase expenses (matching the
 * school's 仕入帳 ledger format, with optional receipt number/quantity/
 * unit price), items deductible from profit before returning it to the
 * student council (health test fee, money collected from students,
 * exchange fees, etc.), and repayments of the 40,000-yen advance loan.
 */
export const accountingEntries = mysqlTable("accounting_entries", {
  id: int("id").autoincrement().primaryKey(),
  category: varchar("category", { length: 20 }).notNull(), // "purchase" | "deduction" | "loan_repay"
  label: varchar("label", { length: 100 }).notNull(),
  amount: int("amount").notNull(),
  note: varchar("note", { length: 255 }),
  receiptNo: varchar("receiptNo", { length: 50 }),
  quantity: int("quantity"),
  unitPrice: int("unitPrice"),
  operator: varchar("operator", { length: 10 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type AccountingEntry = typeof accountingEntries.$inferSelect;
export type InsertAccountingEntry = typeof accountingEntries.$inferInsert;

/**
 * Payments table — one row per cashless payment attempt.
 *
 * Kept separate from `transactions` on purpose: a payment can fail,
 * expire or be abandoned, and none of those are sales. A transaction row
 * is only ever written once its payment reached "completed", and the two
 * are linked both ways (transactions.paymentId ⇄ payments.transactionId).
 *
 * `orderRef` is our idempotency key and is UNIQUE: it is what stops a
 * double-tapped "決済を開始" from opening two payments for one cart.
 * `transactionId` doubles as a consumed-flag — a payment with a non-null
 * transactionId has already been turned into a sale and must never be
 * spent again (checked under SELECT ... FOR UPDATE in db.ts).
 *
 * Cash never touches this table.
 */
export const payments = mysqlTable("payments", {
  id: int("id").autoincrement().primaryKey(),
  provider: varchar("provider", { length: 30 }).notNull(),
  // Nullable: a terminal (card-reader) payment has no provider-side id
  // until the reader reports one back, unlike a server-API payment which
  // gets one the moment it is created.
  providerPaymentId: varchar("providerPaymentId", { length: 191 }),
  // Human-facing reference printed on the slip (伝票番号 / 承認番号).
  // This is the column the 入金明細 from the payment company is matched
  // against when reconciling, so it is worth keeping separate from the
  // machine id above.
  providerRef: varchar("providerRef", { length: 191 }),
  method: varchar("method", { length: 20 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  amount: int("amount").notNull(),
  // The cart this payment was opened for: [{product_id, qty}].
  // Two jobs — it reserves stock while the customer is paying (see
  // db.listOpenPayments), and it lets transaction.create verify that the
  // sale being recorded is the one that was actually paid for.
  items: json("items"),
  orderRef: varchar("orderRef", { length: 64 }).notNull().unique(),
  operator: varchar("operator", { length: 10 }).notNull(),
  transactionId: int("transactionId"),
  // Provider response kept verbatim for reconciliation/support. Never a
  // source of truth for amounts — `amount` above is what we charged.
  rawPayload: json("rawPayload"),
  errorMessage: varchar("errorMessage", { length: 255 }),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => [
  // Webhooks arrive keyed by the provider's own id (db.ts ensurePaymentTables).
  index("idx_payments_provider_payment_id").on(t.provider, t.providerPaymentId),
]);

export type Payment = typeof payments.$inferSelect;
export type InsertPayment = typeof payments.$inferInsert;

/**
 * Sessions ended before their expiry (logout, or replaced by a renewed
 * one), until they would have expired anyway. Kept in the database so a
 * restart — frequent on Render — doesn't bring a logged-out cookie back
 * to life (server/posAuth.ts).
 */
export const revokedSessions = mysqlTable("revoked_sessions", {
  jti: varchar("jti", { length: 64 }).primaryKey(),
  /** When the token stops being accepted (ms since epoch): at once for a logout, after a short grace for a renewal. */
  notAfter: bigint("notAfter", { mode: "number" }).notNull(),
  /** The token's own expiry (ms); the row can go after this. */
  expiresAt: bigint("expiresAt", { mode: "number" }).notNull(),
});

export type RevokedSession = typeof revokedSessions.$inferSelect;
