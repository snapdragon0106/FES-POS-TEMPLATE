import { eq, and, desc, asc, sql, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import {
  products, InsertProduct, Product,
  transactions, InsertTransaction, Transaction,
  restocks, InsertRestock, Restock,
  activityLogs, InsertActivityLog, ActivityLog,
  memberPins, InsertMemberPin, MemberPin,
  accountingEntries, InsertAccountingEntry, AccountingEntry,
  payments, InsertPayment, Payment,
  productImages, ProductImage,
  cashEvents, InsertCashEvent, CashEvent,
  appSettings,
  revokedSessions, RevokedSession,
} from "../drizzle/schema";
import { ENV } from './_core/env';
import { jstDate } from "@shared/stockSchedule";
import { normalizeDatabaseUrl } from "./dbUrl";

let _db: ReturnType<typeof drizzle> | null = null;

/**
 * A brand-new deployment (a new class or a new year) points DATABASE_URL at
 * a database that doesn't exist yet — e.g. the name at the end of the URL
 * changed from /fes2026 to /fes2027 to start the year with nothing in it.
 * Creates it so the person setting up never needs a database console. A
 * no-op when it exists; any failure (no privilege, unreachable server) is
 * left for the real connection below to report.
 */
async function ensureDatabase(url: string): Promise<void> {
  let name = "";
  let conn: mysql.Connection | null = null;
  try {
    const parsed = new URL(url);
    name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    if (!name) return;
    if (!/^[A-Za-z0-9_$-]{1,64}$/.test(name)) {
      console.warn(`[Migration] Database name "${name}" has characters this app doesn't create automatically; using it as is.`);
      return;
    }
    parsed.pathname = "/";
    conn = await mysql.createConnection(parsed.toString());
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\``);
    console.log(`[Migration] database ${name} is ready.`);
  } catch (error) {
    console.warn(`[Migration] Could not make sure database ${name || "(from DATABASE_URL)"} exists:`, error);
  } finally {
    await conn?.end().catch(() => {});
  }
}

/**
 * The tables the app has had from the start, created when missing so an
 * empty database works on the first boot with no `drizzle-kit push` (the
 * people who set this up next year shouldn't need a PC with Node on it).
 * The definitions are what `drizzle-kit push` creates from
 * drizzle/schema.ts (compared column by column on TiDB), so a later push
 * finds nothing to change. Tables added later have their own CREATE in the
 * ensure* function that introduced them; columns added later are added by
 * those functions too, which run after this one.
 */
async function ensureCoreTables(db: NonNullable<typeof _db>): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS products (
        id INT NOT NULL AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        emoji VARCHAR(10) NOT NULL,
        price INT NOT NULL,
        cost INT NOT NULL,
        initialStock INT NOT NULL,
        threshold INT NOT NULL,
        displayOrder INT NOT NULL DEFAULT 0,
        imageHash VARCHAR(64) DEFAULT NULL,
        practice BOOLEAN NOT NULL DEFAULT FALSE,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT NOT NULL AUTO_INCREMENT,
        operator VARCHAR(10) NOT NULL,
        items JSON NOT NULL,
        total INT NOT NULL,
        received INT NOT NULL,
        changeAmount INT NOT NULL,
        voided BOOLEAN NOT NULL DEFAULT FALSE,
        paymentMethod VARCHAR(20) NOT NULL DEFAULT 'cash',
        paymentStatus VARCHAR(20) NOT NULL DEFAULT 'completed',
        paymentId INT DEFAULT NULL,
        paymentRef VARCHAR(191) DEFAULT NULL,
        clientRequestId VARCHAR(64) DEFAULT NULL,
        orderNo INT DEFAULT NULL,
        handoverPending BOOLEAN NOT NULL DEFAULT FALSE,
        handedAt TIMESTAMP NULL DEFAULT NULL,
        handedBy VARCHAR(10) DEFAULT NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY transactions_clientRequestId_unique (clientRequestId)
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS restocks (
        id INT NOT NULL AUTO_INCREMENT,
        productId INT NOT NULL,
        amount INT NOT NULL,
        operator VARCHAR(10) NOT NULL,
        availableOn VARCHAR(10) DEFAULT NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id INT NOT NULL AUTO_INCREMENT,
        operator VARCHAR(10) NOT NULL,
        operatorName VARCHAR(50) NOT NULL DEFAULT '',
        action VARCHAR(30) NOT NULL,
        detail VARCHAR(255) DEFAULT NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS member_pins (
        id INT NOT NULL AUTO_INCREMENT,
        memberId VARCHAR(10) NOT NULL,
        pin VARCHAR(255) NOT NULL,
        approved BOOLEAN NOT NULL DEFAULT TRUE,
        requestCode VARCHAR(8) DEFAULT NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY member_pins_memberId_unique (memberId)
      )
    `);
    console.log("[Migration] core tables (products, transactions, restocks, activity_logs, member_pins) are ready.");
  } catch (error) {
    console.error("[Migration] Failed to ensure core tables:", error);
  }
}

/**
 * One-time-per-boot schema fix: the `member_pins.pin` column was
 * originally sized for a plain 4-digit PIN (varchar(4)). PINs are now
 * stored as a salted hash (~160 characters), so the column needs to be
 * wider. This runs against whatever DATABASE_URL the server is actually
 * using — the exact connection the running app already trusts — so
 * there's no risk of it landing on the wrong database via a database
 * console. Safe to leave in permanently: widening an already-wide
 * column is a harmless no-op.
 */
async function ensurePinColumnWidth(db: NonNullable<typeof _db>): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE member_pins MODIFY COLUMN pin VARCHAR(255) NOT NULL`);
    console.log("[Migration] member_pins.pin column is VARCHAR(255) or wider.");
  } catch (error) {
    console.error("[Migration] Failed to widen member_pins.pin column:", error);
  }
}

/**
 * Creates the accounting_entries table if it doesn't exist yet, and
 * ensures the receiptNo/quantity/unitPrice columns (added to match the
 * school's official 仕入帳 ledger format) exist even if the table was
 * created by an earlier version of this app. Runs against whichever
 * DATABASE_URL the app is actually using — same self-healing approach
 * as ensurePinColumnWidth, so no manual database console step is ever
 * required.
 */
async function ensureAccountingTable(db: NonNullable<typeof _db>): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS accounting_entries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        category VARCHAR(20) NOT NULL,
        label VARCHAR(100) NOT NULL,
        amount INT NOT NULL,
        note VARCHAR(255),
        receiptNo VARCHAR(50),
        quantity INT,
        unitPrice INT,
        operator VARCHAR(10) NOT NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
    await db.execute(sql`ALTER TABLE accounting_entries ADD COLUMN IF NOT EXISTS receiptNo VARCHAR(50)`);
    await db.execute(sql`ALTER TABLE accounting_entries ADD COLUMN IF NOT EXISTS quantity INT`);
    await db.execute(sql`ALTER TABLE accounting_entries ADD COLUMN IF NOT EXISTS unitPrice INT`);
    console.log("[Migration] accounting_entries table is ready (with receiptNo/quantity/unitPrice).");
  } catch (error) {
    console.error("[Migration] Failed to ensure accounting_entries table:", error);
  }
}

/**
 * Some legacy tables (created by the original Manus scaffold) may be
 * missing the createdAt/updatedAt timestamp columns that the current
 * schema definition expects — selecting a nonexistent column makes
 * every query on that table fail with a 500 (which is exactly what
 * broke checkout: transaction.create reads restocks for stock
 * validation). Adding the columns is harmless if they already exist
 * (ADD COLUMN IF NOT EXISTS is a no-op then), so this runs on every
 * boot, same self-healing approach as the other ensure functions.
 */
async function ensureTimestampColumns(db: NonNullable<typeof _db>): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE restocks ADD COLUMN IF NOT EXISTS createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL`);
    await db.execute(sql`ALTER TABLE restocks ADD COLUMN IF NOT EXISTS updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL`);
    // The REAL missing column (per Render logs: "Unknown column 'operator'
    // in 'field list'"): the original restocks table was created without
    // an operator column. Existing rows get '' as a harmless default.
    await db.execute(sql`ALTER TABLE restocks ADD COLUMN IF NOT EXISTS operator VARCHAR(10) NOT NULL DEFAULT ''`);
    // Stock scheduled for a later day (shared/stockSchedule.ts). Null = available at once.
    await db.execute(sql`ALTER TABLE restocks ADD COLUMN IF NOT EXISTS availableOn VARCHAR(10)`);
    await db.execute(sql`ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL`);
    await db.execute(sql`ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL`);
    // Other columns the app's schema expects that older versions of these
    // tables may not have had. All harmless no-ops if already present.
    await db.execute(sql`ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS operatorName VARCHAR(50) NOT NULL DEFAULT ''`);
    await db.execute(sql`ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS detail VARCHAR(255)`);
    await db.execute(sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS threshold INT NOT NULL DEFAULT 10`);
    await db.execute(sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS displayOrder INT NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS voided BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL`);
    await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL`);
    await db.execute(sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL`);
    await db.execute(sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL`);
    await db.execute(sql`ALTER TABLE member_pins ADD COLUMN IF NOT EXISTS createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL`);
    await db.execute(sql`ALTER TABLE member_pins ADD COLUMN IF NOT EXISTS updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL`);
    // First-login PINs wait for an admin (server/login.ts). DEFAULT TRUE:
    // everyone who already has a PIN keeps working.
    await db.execute(sql`ALTER TABLE member_pins ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT TRUE`);
    console.log("[Migration] timestamp columns are ensured on all POS tables.");
  } catch (error) {
    console.error("[Migration] Failed to ensure timestamp columns:", error);
  }
}

/**
 * Creates the `payments` table and adds the three payment columns to
 * `transactions`, if they aren't there yet. Same self-healing approach as
 * the ensure* functions above: the production database must never need a
 * manual SQL console step to catch up with a deploy.
 *
 * The defaults matter. Existing transaction rows predate cashless, so
 * they backfill to paymentMethod='cash' / paymentStatus='completed' —
 * which is precisely what they were, meaning every historical sale still
 * reads correctly instead of showing up as an unpaid mystery.
 */
async function ensurePaymentTables(db: NonNullable<typeof _db>): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        provider VARCHAR(30) NOT NULL,
        providerPaymentId VARCHAR(191),
        providerRef VARCHAR(191),
        method VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        amount INT NOT NULL,
        items JSON,
        orderRef VARCHAR(64) NOT NULL,
        operator VARCHAR(10) NOT NULL,
        transactionId INT,
        rawPayload JSON,
        errorMessage VARCHAR(255),
        expiresAt TIMESTAMP NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL,
        UNIQUE KEY payments_orderRef_unique (orderRef)
      )
    `);
    // Columns added after the table first shipped. No-ops when present.
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS providerRef VARCHAR(191)`);
    await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS items JSON`);
    await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paymentMethod VARCHAR(20) NOT NULL DEFAULT 'cash'`);
    await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paymentStatus VARCHAR(20) NOT NULL DEFAULT 'completed'`);
    await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paymentId INT`);
    await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paymentRef VARCHAR(191)`);
    console.log("[Migration] payments table and transaction payment columns are ready.");
  } catch (error) {
    console.error("[Migration] Failed to ensure payment tables:", error);
  }

  // Webhooks arrive keyed by the provider's own id, so that lookup runs on
  // every callback. Separate try/catch because index DDL syntax varies more
  // between MySQL and TiDB than column DDL does, and a missing index is a
  // slow query — not a reason to fail the boot.
  try {
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_payments_provider_payment_id ON payments (provider, providerPaymentId)`);
  } catch (error) {
    console.warn("[Migration] Could not create payments provider index (non-fatal):", error);
  }
}

/**
 * Adds the checkout idempotency key (transactions.clientRequestId) and its
 * UNIQUE index. The index is what makes a retried checkout safe even when
 * two copies of the same request race: the second insert fails on it and
 * createTransactionSerialized answers with the first one's id instead.
 *
 * The index name matches what drizzle-kit generates for `.unique()` on
 * this column, so a later `drizzle-kit push` sees it as already present
 * rather than creating a second one.
 */
async function ensureCheckoutIdempotency(db: NonNullable<typeof _db>): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS clientRequestId VARCHAR(64)`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS transactions_clientRequestId_unique ON transactions (clientRequestId)`);
    console.log("[Migration] transactions.clientRequestId (checkout idempotency) is ready.");
  } catch (error) {
    console.error("[Migration] Failed to ensure checkout idempotency column:", error);
  }
}

/**
 * Product photos: the products.imageHash column and the product_images
 * table that holds the bytes. Both are no-ops once present.
 */
async function ensureProductImages(db: NonNullable<typeof _db>): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS imageHash VARCHAR(64)`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS product_images (
        productId INT PRIMARY KEY,
        mime VARCHAR(32) NOT NULL,
        data MEDIUMTEXT NOT NULL,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL
      )
    `);
    console.log("[Migration] product_images table and products.imageHash are ready.");
  } catch (error) {
    console.error("[Migration] Failed to ensure product images:", error);
  }
}

/**
 * The cash drawer ledger (釣り銭・回収・締め) and the shop-wide settings
 * table (currently just the 回収 reminder threshold).
 */
async function ensureCashTables(db: NonNullable<typeof _db>): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS cash_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        kind VARCHAR(16) NOT NULL,
        amount INT NOT NULL,
        breakdown JSON,
        expected INT,
        note VARCHAR(255),
        operator VARCHAR(10) NOT NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS app_settings (
        \`key\` VARCHAR(64) PRIMARY KEY,
        value VARCHAR(255) NOT NULL,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL
      )
    `);
    // Who provided / got back the float (釣り銭の返却). Nullable: older rows have none.
    await db.execute(sql`ALTER TABLE cash_events ADD COLUMN IF NOT EXISTS party VARCHAR(50)`);
    console.log("[Migration] cash_events (with party) and app_settings tables are ready.");
  } catch (error) {
    console.error("[Migration] Failed to ensure cash tables:", error);
  }
}

/**
 * The handover counter (受け渡し, server/handover.ts): each sale's order
 * number and whether its goods have been handed over. DEFAULT FALSE: sales
 * from before this don't show up as waiting orders.
 */
async function ensureHandoverColumns(db: NonNullable<typeof _db>): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS orderNo INT`);
    await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS handoverPending BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS handedAt TIMESTAMP NULL DEFAULT NULL`);
    await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS handedBy VARCHAR(10)`);
    // Practice products (practice.seed / practice.cleanup). Same startup
    // step: a column the product list selects must exist before it is read.
    await db.execute(sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS practice BOOLEAN NOT NULL DEFAULT FALSE`);
    console.log("[Migration] transactions handover columns (orderNo, handoverPending, handedAt, handedBy) and products.practice are ready.");
  } catch (error) {
    console.error("[Migration] Failed to ensure handover columns:", error);
  }
}

/**
 * Login hardening (server/login.ts, server/posAuth.ts): the code a waiting
 * first-login PIN is approved with, and ended sessions that must stay
 * ended across a restart.
 */
async function ensureSecurityTables(db: NonNullable<typeof _db>): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE member_pins ADD COLUMN IF NOT EXISTS requestCode VARCHAR(8)`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS revoked_sessions (
        jti VARCHAR(64) PRIMARY KEY,
        notAfter BIGINT NOT NULL,
        expiresAt BIGINT NOT NULL
      )
    `);
    console.log("[Migration] member_pins.requestCode and revoked_sessions are ready.");
  } catch (error) {
    console.error("[Migration] Failed to ensure security tables:", error);
  }
}

/**
 * In-flight initialisation promise. Without this, `_db` was assigned
 * *before* the ensure* migrations had run, so a concurrent request would
 * see a non-null `_db`, skip the wait and query a table whose columns did
 * not exist yet — exactly the "Unknown column 'operator' in 'field list'"
 * burst seen in the Render logs right before the [Migration] lines. Every
 * caller now awaits the same promise, and `_db` is only published once the
 * migrations have finished.
 */
let _dbInit: Promise<ReturnType<typeof drizzle> | null> | null = null;

/**
 * True while the first connection and the ensure* migrations are still
 * running. The health check uses this to say "starting" rather than
 * "error" in the first minute after a deploy or restart — otherwise a
 * perfectly healthy database reads as an outage on the incident runbook.
 */
export function isDbStarting(): boolean {
  return !_db && _dbInit !== null;
}

export async function getDb() {
  if (_db) return _db;
  if (!process.env.DATABASE_URL) return null;
  if (!_dbInit) {
    _dbInit = (async () => {
      try {
        const url = normalizeDatabaseUrl(process.env.DATABASE_URL!);
        await ensureDatabase(url);
        const db = drizzle(url);
        await ensureCoreTables(db);
        await ensurePinColumnWidth(db);
        await ensureAccountingTable(db);
        await ensureTimestampColumns(db);
        await ensurePaymentTables(db);
        await ensureCheckoutIdempotency(db);
        await ensureProductImages(db);
        await ensureCashTables(db);
        await ensureSecurityTables(db);
        await ensureHandoverColumns(db);
        _db = db;
        return db;
      } catch (error) {
        console.warn("[Database] Failed to connect:", error);
        // Clear the memo so a later request can retry instead of being
        // permanently stuck with a failed connection.
        _dbInit = null;
        return null;
      }
    })();
  }
  return _dbInit;
}

// ===== Products =====
// Throws (rather than returning []) when the DB is unreachable, matching
// every create*/delete* function below — otherwise a DB outage looked
// identical to "no products exist yet" from the cashier's screen instead of
// a visible error.
export async function listProducts(): Promise<Product[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.select().from(products).orderBy(asc(products.displayOrder));
}

export async function createProduct(data: Omit<InsertProduct, "id" | "createdAt" | "updatedAt">) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(products).values(data);
  return result[0].insertId;
}

export async function updateProduct(id: number, data: Partial<Omit<InsertProduct, "id" | "createdAt" | "updatedAt">>) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(products).set(data).where(eq(products.id, id));
}

export async function deleteProduct(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.transaction(async (tx) => {
    await tx.delete(productImages).where(eq(productImages.productId, id));
    await tx.delete(products).where(eq(products.id, id));
  });
}

export async function deleteAllProducts() {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.transaction(async (tx) => {
    await tx.delete(productImages);
    await tx.delete(products);
  });
}

/**
 * Sets (or with `null`, removes) a product's photo. The bytes and the
 * hash on the product row change in one DB transaction, so the list never
 * advertises a hash whose image isn't there yet. Returns false when the
 * product doesn't exist.
 */
export async function setProductImage(
  productId: number,
  image: { mime: string; data: string; hash: string } | null
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.transaction(async (tx) => {
    const rows = await tx.select({ id: products.id }).from(products).where(eq(products.id, productId)).for("update");
    if (rows.length === 0) return false;
    if (image) {
      await tx
        .insert(productImages)
        .values({ productId, mime: image.mime, data: image.data })
        .onDuplicateKeyUpdate({ set: { mime: image.mime, data: image.data } });
    } else {
      await tx.delete(productImages).where(eq(productImages.productId, productId));
    }
    await tx.update(products).set({ imageHash: image ? image.hash : null }).where(eq(products.id, productId));
    return true;
  });
}

export async function getProductImage(productId: number): Promise<(ProductImage & { hash: string | null }) | null> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db
    .select({
      productId: productImages.productId,
      mime: productImages.mime,
      data: productImages.data,
      updatedAt: productImages.updatedAt,
      hash: products.imageHash,
    })
    .from(productImages)
    .innerJoin(products, eq(products.id, productImages.productId))
    .where(eq(productImages.productId, productId));
  return rows[0] ?? null;
}

// ===== Transactions =====
export async function listTransactions(): Promise<Transaction[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.select().from(transactions).orderBy(desc(transactions.createdAt));
}

export async function createTransaction(data: Omit<InsertTransaction, "id" | "createdAt" | "updatedAt">) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(transactions).values(data);
  return result[0].insertId;
}

/**
 * Runs a checkout inside a single DB transaction, row-locking the involved
 * products first (SELECT ... FOR UPDATE, in a stable id order to avoid
 * deadlocks between concurrent checkouts). Without this, two registers
 * reading stock for the same product at the same time could both read the
 * pre-sale count, both pass validation, and both insert — overselling the
 * last unit. `build` re-reads transactions/restocks/products *inside* the
 * transaction (so it sees a consistent snapshot serialized against the
 * lock) and returns the row to insert; MySQL/TiDB holds the row locks until
 * this transaction commits or rolls back, so a concurrent checkout for the
 * same product blocks until this one finishes and then sees the updated
 * stock.
 *
 * `lockPayment` extends the same guarantee to cashless sales. A payment
 * may only ever become one transaction, so `build` locks the payment row
 * here and checks that nothing has claimed it yet; the claim itself
 * (payments.transactionId) is written below, inside this same DB
 * transaction. Two simultaneous checkouts quoting one payment therefore
 * serialize on the row lock, and the loser sees transactionId already set
 * instead of booking a second sale against one payment.
 */
/**
 * READ COMMITTED, not the engine default (REPEATABLE READ), and this is
 * load-bearing — the lock above only protects stock if the reads after it
 * can see what the previous lock holder committed.
 *
 * On MySQL/InnoDB, REPEATABLE READ happens to work: its snapshot is taken
 * at the first plain SELECT, which runs after the row lock is granted. On
 * TiDB — what production runs — the snapshot is fixed when the transaction
 * *starts*, before the lock wait. A checkout that queued behind another on
 * the same product would then read the sales table as it was before the
 * other one committed, pass the stock check against stock that no longer
 * exists, and oversell. Under READ COMMITTED every statement reads the
 * latest committed data on both engines, so the lock-then-read pattern
 * means the same thing everywhere.
 */
const CHECKOUT_TX_CONFIG = { isolationLevel: "read committed" } as const;

export type SerializedCheckoutResult = {
  id: number;
  /** True when this request was a retry of a checkout that had already been recorded. */
  duplicate: boolean;
  /** Today's order number (受け渡し); null for a retry of a sale from before numbers existed. */
  orderNo: number | null;
};

// The day's order-number counter, in app_settings: "YYYY-MM-DD:N" (Japan time).
export const ORDER_SEQ_KEY = "order.seq";

/** mysql2 reports a UNIQUE violation as ER_DUP_ENTRY; drizzle wraps it in `cause`. */
function isDuplicateKeyError(error: unknown): boolean {
  for (let e: any = error; e; e = e.cause) {
    if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) return true;
  }
  return false;
}

async function findByClientRequestId(
  reader: { select: NonNullable<typeof _db>["select"] },
  clientRequestId: string
): Promise<{ id: number; orderNo: number | null } | undefined> {
  const rows = await reader
    .select({ id: transactions.id, orderNo: transactions.orderNo })
    .from(transactions)
    .where(eq(transactions.clientRequestId, clientRequestId));
  return rows[0];
}

export async function createTransactionSerialized(
  productIds: number[],
  build: (tx: {
    listProducts: () => Promise<Product[]>;
    listTransactions: () => Promise<Transaction[]>;
    listRestocks: () => Promise<Restock[]>;
    listOpenPayments: () => Promise<Payment[]>;
    lockPayment: (paymentId: number) => Promise<Payment | undefined>;
  }) => Promise<Omit<InsertTransaction, "id" | "createdAt" | "updatedAt">>,
  options?: { clientRequestId?: string }
): Promise<SerializedCheckoutResult> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const clientRequestId = options?.clientRequestId;

  try {
    return await db.transaction(async (tx) => {
      const uniqueIds = Array.from(new Set(productIds)).sort((a, b) => a - b);
      if (uniqueIds.length > 0) {
        // Lock just the rows this checkout touches, in a stable order, so
        // concurrent checkouts for disjoint products never block each other
        // and checkouts sharing a product serialize instead of deadlocking.
        await tx.select().from(products).where(inArray(products.id, uniqueIds)).for("update");
      }

      // A retry of a checkout that already went through. Checked before the
      // stock check on purpose: if the first attempt sold the last unit, the
      // retry would otherwise be told the item is out of stock — while the
      // sale it is asking about actually succeeded.
      if (clientRequestId) {
        const prior = await findByClientRequestId(tx, clientRequestId);
        if (prior) return { ...prior, duplicate: true };
      }

      const data = await build({
        listProducts: () => tx.select().from(products).orderBy(asc(products.displayOrder)),
        listTransactions: () => tx.select().from(transactions).orderBy(desc(transactions.createdAt)),
        listRestocks: () => tx.select().from(restocks).orderBy(desc(restocks.createdAt)),
        // Read inside the transaction so the stock check sees a consistent
        // view of what other registers currently have reserved.
        listOpenPayments: () =>
          tx.select().from(payments).where(inArray(payments.status, ["pending", "authorized"])),
        // Products are always locked before payments (see the ordering
        // above), so two checkouts can never hold one lock each and wait
        // on the other.
        lockPayment: async (paymentId: number) => {
          const rows = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
          return rows[0];
        },
      });
      // Today's next order number. Taken after the checks above, so a
      // refused sale uses no number, and from one counter row locked for
      // the rest of this transaction: two registers can't be told the same
      // number. (The transaction id can't serve: TiDB hands out ids in
      // blocks per server, so they jump and aren't a count.) Locked after
      // the products and payment, in the same order by every checkout.
      const today = jstDate();
      await tx
        .insert(appSettings)
        .values({ key: ORDER_SEQ_KEY, value: `${today}:0` })
        .onDuplicateKeyUpdate({ set: { value: sql`value` } });
      const [seq] = await tx.select().from(appSettings).where(eq(appSettings.key, ORDER_SEQ_KEY)).for("update");
      const [seqDay, seqN] = (seq?.value ?? "").split(":");
      const orderNo = seqDay === today ? (Number(seqN) || 0) + 1 : 1;
      await tx.update(appSettings).set({ value: `${today}:${orderNo}` }).where(eq(appSettings.key, ORDER_SEQ_KEY));

      const result = await tx
        .insert(transactions)
        .values({ ...data, clientRequestId: clientRequestId ?? null, orderNo, handoverPending: true });
      const insertId = result[0].insertId;
      if (data.paymentId != null) {
        // Marks the payment spent. Inside the transaction, so a rollback
        // (e.g. the insert failing) leaves the payment reusable rather than
        // stranding a customer who has already paid.
        await tx
          .update(payments)
          .set({ transactionId: insertId })
          .where(eq(payments.id, data.paymentId));
      }
      return { id: insertId, duplicate: false, orderNo };
    }, CHECKOUT_TX_CONFIG);
  } catch (error) {
    // Two copies of the same request arrived together (e.g. a client
    // timeout fired while the first was still running). The UNIQUE index
    // let exactly one of them insert; answer the other with that row.
    if (clientRequestId && isDuplicateKeyError(error)) {
      const prior = await findByClientRequestId(db, clientRequestId);
      if (prior) return { ...prior, duplicate: true };
    }
    throw error;
  }
}

export async function getTransactionById(id: number): Promise<Transaction | undefined> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(transactions).where(eq(transactions.id, id));
  return rows[0];
}

export async function voidTransaction(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(transactions).set({ voided: true }).where(eq(transactions.id, id));
}

/** Deletes the sale only if it is voided — the rule is enforced in SQL too. */
export async function deleteTransaction(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(transactions).where(and(eq(transactions.id, id), eq(transactions.voided, true)));
}

export async function getTransactionsByIds(ids: number[]): Promise<Transaction[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  if (ids.length === 0) return [];
  return db.select().from(transactions).where(inArray(transactions.id, ids));
}

/** Deletes only the voided ones among `ids` (a live sale is never erased). */
export async function deleteVoidedTransactionsByIds(ids: number[]): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  if (ids.length === 0) return 0;
  const result = await db.delete(transactions).where(and(inArray(transactions.id, ids), eq(transactions.voided, true)));
  return result[0].affectedRows;
}

export async function deleteAllTransactions() {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(transactions);
}

// ===== Restocks =====
export async function listRestocks(): Promise<Restock[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.select().from(restocks).orderBy(desc(restocks.createdAt));
}

export async function getRestockById(id: number): Promise<Restock | null> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(restocks).where(eq(restocks.id, id));
  return rows[0] ?? null;
}

export async function deleteRestock(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(restocks).where(eq(restocks.id, id));
}

export async function createRestock(data: Omit<InsertRestock, "id" | "createdAt" | "updatedAt">) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(restocks).values(data);
  return result[0].insertId;
}

export async function deleteAllRestocks() {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(restocks);
}

// ===== Activity Logs =====
export async function listActivityLogs(): Promise<ActivityLog[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.select().from(activityLogs).orderBy(desc(activityLogs.createdAt));
}

export async function createActivityLog(data: Omit<InsertActivityLog, "id" | "createdAt" | "updatedAt">) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(activityLogs).values(data);
}

export async function deleteAllActivityLogs() {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(activityLogs);
}

// ===== Member PINs =====
export async function getMemberPin(memberId: string): Promise<MemberPin | undefined> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(memberPins).where(eq(memberPins.memberId, memberId));
  return rows[0];
}

export async function listMemberPins(): Promise<MemberPin[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.select().from(memberPins);
}

/**
 * Sets a member's PIN. `approved: false` (with the code the admin approves
 * it with) only for a first-login PIN waiting for an admin.
 */
export async function upsertMemberPin(memberId: string, pin: string, approved = true, requestCode: string | null = null) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const existing = await getMemberPin(memberId);
  if (existing) {
    await db.update(memberPins).set({ pin, approved, requestCode }).where(eq(memberPins.memberId, memberId));
  } else {
    await db.insert(memberPins).values({ memberId, pin, approved, requestCode });
  }
}

/**
 * Approves a waiting first-login PIN, only if it is still the request with
 * this code (a newer request under the same number replaces the code).
 * False if there was no such request waiting.
 */
export async function approveMemberPin(memberId: string, requestCode: string): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db
    .update(memberPins)
    .set({ approved: true, requestCode: null })
    .where(and(eq(memberPins.memberId, memberId), eq(memberPins.approved, false), eq(memberPins.requestCode, requestCode)));
  return result[0].affectedRows === 1;
}

export async function deleteMemberPin(memberId: string) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(memberPins).where(eq(memberPins.memberId, memberId));
}

export async function deleteAllMemberPins() {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(memberPins);
}

// ===== Accounting Entries (purchases / deductions / loan repayments) =====
export async function listAccountingEntries(): Promise<AccountingEntry[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.select().from(accountingEntries).orderBy(desc(accountingEntries.createdAt));
}

export async function createAccountingEntry(entry: InsertAccountingEntry): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(accountingEntries).values(entry);
  return result[0].insertId;
}

export async function getAccountingEntryById(id: number): Promise<AccountingEntry | null> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(accountingEntries).where(eq(accountingEntries.id, id));
  return rows[0] ?? null;
}

export async function deleteAccountingEntry(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(accountingEntries).where(eq(accountingEntries.id, id));
}

export async function deleteAllAccountingEntries() {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(accountingEntries);
}

// ===== Payments (cashless) =====
export async function createPayment(
  data: Omit<InsertPayment, "id" | "createdAt" | "updatedAt">
): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(payments).values(data);
  return result[0].insertId;
}

export async function getPaymentById(id: number): Promise<Payment | undefined> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(payments).where(eq(payments.id, id));
  return rows[0];
}

/**
 * Webhooks identify a payment by the provider's id, not ours. Scoped by
 * provider as well so two providers' id spaces can never collide.
 */
export async function getPaymentByProviderId(
  provider: string,
  providerPaymentId: string
): Promise<Payment | undefined> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // Terminal payments carry a null providerPaymentId until the reader
  // reports one. Matching on an empty string would then pick an arbitrary
  // unrelated payment, so refuse the lookup outright.
  if (!providerPaymentId) return undefined;
  const rows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.provider, provider), eq(payments.providerPaymentId, providerPaymentId)));
  return rows[0];
}

/**
 * Payments that are still waiting on the customer.
 *
 * These hold a reservation on the stock in their `items`: a cashless
 * payment takes anywhere from a few seconds (card reader) to a minute
 * (customer fumbling with a QR app), and without this two registers can
 * both sell the last たこ焼き while the first customer is still paying.
 * The caller filters out the ones that have aged out — see
 * payments/service.ts reservedStock.
 */
export async function listOpenPayments(): Promise<Payment[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.select().from(payments).where(inArray(payments.status, ["pending", "authorized"]));
}

export async function getPaymentByOrderRef(orderRef: string): Promise<Payment | undefined> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(payments).where(eq(payments.orderRef, orderRef));
  return rows[0];
}

export async function updatePayment(
  id: number,
  data: Partial<Omit<InsertPayment, "id" | "createdAt" | "updatedAt">>
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(payments).set(data).where(eq(payments.id, id));
}

/**
 * Moves a payment to a new status only while it is still open.
 *
 * Providers retry webhooks and may deliver them out of order, so a late
 * "pending" must not undo a "completed", and a duplicate "completed" must
 * not fire the side effects twice. The WHERE clause makes that a database
 * guarantee rather than something every caller has to remember: it
 * returns whether this call was the one that actually moved the row.
 */
export async function settlePaymentStatus(
  id: number,
  status: string,
  extra?: { rawPayload?: unknown; errorMessage?: string }
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db
    .update(payments)
    .set({
      status,
      ...(extra?.rawPayload !== undefined ? { rawPayload: extra.rawPayload } : {}),
      ...(extra?.errorMessage !== undefined ? { errorMessage: extra.errorMessage } : {}),
    })
    .where(and(eq(payments.id, id), inArray(payments.status, ["pending", "authorized"])));
  return result[0].affectedRows > 0;
}

export async function listPayments(limit = 200): Promise<Payment[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.select().from(payments).orderBy(desc(payments.createdAt)).limit(limit);
}

export async function deleteAllPayments() {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(payments);
}

/**
 * Wipes transactions/restocks/activity logs/products/accounting entries and
 * reseeds the default product list, all inside one DB transaction. The five
 * deletes plus the reseed loop used to be separate unguarded awaits — if any
 * one of them failed partway through (e.g. a transient connection blip), the
 * shop was left in a half-wiped, half-reseeded state with no way back.
 * Wrapping it in a transaction means it either fully succeeds or fully rolls
 * back to what was there before.
 */
export async function resetAllData(defaults: Omit<InsertProduct, "id" | "createdAt" | "updatedAt">[]) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.transaction(async (tx) => {
    await tx.delete(transactions);
    // After transactions: a payment row is only meaningful alongside the
    // sale it paid for, and wiping it first would briefly leave sales
    // pointing at a payment that no longer exists.
    await tx.delete(payments);
    await tx.delete(restocks);
    await tx.delete(activityLogs);
    await tx.delete(productImages);
    await tx.delete(products);
    await tx.delete(accountingEntries);
    // Practice-run floats and counts go with the practice sales; the
    // settings (回収 threshold) are configuration and stay.
    await tx.delete(cashEvents);
    // Order numbers start again from 1.
    await tx.delete(appSettings).where(eq(appSettings.key, ORDER_SEQ_KEY));
    for (const p of defaults) {
      await tx.insert(products).values(p);
    }
  });
}

// ===== Practice (練習用の商品) =====
// Rehearsing at the register before the festival, on the real system:
// practice products are ordinary products marked `practice`, sold like any
// other. Afterwards cleanupPractice takes them away together with every
// sale that contains one — all in one transaction — so the takings, the
// stock of the real goods, the handover queue and today's order numbers
// are as if the rehearsal never happened. The activity log keeps its lines
// (it is the record of what was done).

const PRACTICE_PREFIX = "【練習】";

/** Whether a sale contains one of the given products. */
function containsAny(items: unknown, ids: Set<number>): boolean {
  return Array.isArray(items) && items.some((it: any) => ids.has(Number(it?.product_id)));
}

export async function listPracticeProducts(): Promise<Product[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.select().from(products).where(eq(products.practice, true)).orderBy(asc(products.displayOrder));
}

/**
 * Marks products named 【練習】… as practice products (ones an admin added by
 * hand before this existed), and adds `defaults` only if there are still
 * none — pressing the button twice doesn't double them.
 */
export async function seedPracticeProducts(
  defaults: Omit<InsertProduct, "id" | "createdAt" | "updatedAt" | "practice">[]
): Promise<{ adopted: number; created: number }> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.transaction(async (tx) => {
    const named = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.practice, false), sql`${products.name} LIKE ${PRACTICE_PREFIX + "%"}`));
    if (named.length) {
      await tx.update(products).set({ practice: true }).where(inArray(products.id, named.map((p) => p.id)));
    }
    const existing = await tx.select({ id: products.id }).from(products).where(eq(products.practice, true));
    if (existing.length) return { adopted: named.length, created: 0 };
    for (const p of defaults) await tx.insert(products).values({ ...p, practice: true });
    return { adopted: 0, created: defaults.length };
  });
}

export type PracticeSummary = {
  products: Product[];
  /** Sales containing a practice product (what cleanup deletes). */
  sales: { id: number; orderNo: number | null; total: number; voided: boolean; createdAt: Date }[];
  /** Cash records made since practice began: the ones cleanup may delete. */
  cashEvents: CashEvent[];
};

/** When practice began: the earliest practice product. Cash records from before it are never practice. */
function practiceSince(rows: Product[]): Date | null {
  return rows.length ? new Date(Math.min(...rows.map((p) => new Date(p.createdAt).getTime()))) : null;
}

export async function practiceSummary(): Promise<PracticeSummary> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const practiceRows = await db.select().from(products).where(eq(products.practice, true)).orderBy(asc(products.displayOrder));
  const since = practiceSince(practiceRows);
  if (!since) return { products: [], sales: [], cashEvents: [] };
  const ids = new Set(practiceRows.map((p) => p.id));
  const sales = (await db.select().from(transactions).orderBy(desc(transactions.createdAt)))
    .filter((t) => containsAny(t.items, ids))
    .map((t) => ({ id: t.id, orderNo: t.orderNo ?? null, total: t.total, voided: t.voided, createdAt: t.createdAt }));
  const cash = (await db.select().from(cashEvents).orderBy(desc(cashEvents.createdAt), desc(cashEvents.id)))
    .filter((e) => new Date(e.createdAt).getTime() >= since.getTime());
  return { products: practiceRows, sales, cashEvents: cash };
}

export type PracticeCleanup = { products: number; sales: number; restocks: number; cashEvents: number; orderNo: number };

/**
 * Removes the practice products, every sale containing one (voided or
 * not — they are rehearsal, not takings), their restocks, and the chosen
 * cash records made since practice began. Today's order counter goes back
 * to the highest number still in use, so the first real customer isn't
 * number 31 because of the rehearsal.
 *
 * Locks the practice products first and the order counter second — the
 * order every checkout takes them in — so a checkout racing the cleanup
 * either finishes before it (and its sale is deleted with the rest) or
 * waits and then finds the product gone. READ COMMITTED for the same
 * reason as checkout (CHECKOUT_TX_CONFIG): after the locks, read what is
 * committed now, not a snapshot from before the wait.
 */
export async function cleanupPractice(cashEventIds: number[]): Promise<PracticeCleanup> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.transaction(async (tx) => {
    const practiceRows = await tx.select().from(products).where(eq(products.practice, true)).orderBy(asc(products.id)).for("update");
    const since = practiceSince(practiceRows);
    if (!since) return { products: 0, sales: 0, restocks: 0, cashEvents: 0, orderNo: 0 };
    const productIds = practiceRows.map((p) => p.id);
    const ids = new Set(productIds);

    const today = jstDate();
    await tx
      .insert(appSettings)
      .values({ key: ORDER_SEQ_KEY, value: `${today}:0` })
      .onDuplicateKeyUpdate({ set: { value: sql`value` } });
    const [seq] = await tx.select().from(appSettings).where(eq(appSettings.key, ORDER_SEQ_KEY)).for("update");

    const all = await tx
      .select({ id: transactions.id, items: transactions.items, orderNo: transactions.orderNo, createdAt: transactions.createdAt })
      .from(transactions);
    const doomed = all.filter((t) => containsAny(t.items, ids)).map((t) => t.id);
    const gone = new Set(doomed);
    for (let i = 0; i < doomed.length; i += 500) {
      await tx.delete(transactions).where(inArray(transactions.id, doomed.slice(i, i + 500)));
    }

    const restockRows = await tx.select({ id: restocks.id }).from(restocks).where(inArray(restocks.productId, productIds));
    if (restockRows.length) await tx.delete(restocks).where(inArray(restocks.productId, productIds));

    let cashDeleted = 0;
    if (cashEventIds.length) {
      const chosen = (await tx.select().from(cashEvents).where(inArray(cashEvents.id, cashEventIds)))
        .filter((e) => new Date(e.createdAt).getTime() >= since.getTime())
        .map((e) => e.id);
      if (chosen.length) await tx.delete(cashEvents).where(inArray(cashEvents.id, chosen));
      cashDeleted = chosen.length;
    }

    await tx.delete(productImages).where(inArray(productImages.productId, productIds));
    await tx.delete(products).where(inArray(products.id, productIds));

    // Never raises the counter, only lowers it to the highest number a
    // remaining sale of today holds.
    const [seqDay, seqN] = (seq?.value ?? "").split(":");
    let orderNo = seqDay === today ? Number(seqN) || 0 : 0;
    if (seqDay === today) {
      const keep = all
        .filter((t) => !gone.has(t.id) && t.orderNo != null && jstDate(new Date(t.createdAt)) === today)
        .reduce((m, t) => Math.max(m, t.orderNo!), 0);
      if (keep < orderNo) {
        orderNo = keep;
        await tx.update(appSettings).set({ value: `${today}:${orderNo}` }).where(eq(appSettings.key, ORDER_SEQ_KEY));
      }
    }
    return { products: productIds.length, sales: doomed.length, restocks: restockRows.length, cashEvents: cashDeleted, orderNo };
  }, CHECKOUT_TX_CONFIG);
}

// ===== Cash drawer (釣り銭・回収・締め) =====
export async function listCashEvents(): Promise<CashEvent[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.select().from(cashEvents).orderBy(desc(cashEvents.createdAt), desc(cashEvents.id));
}

export async function createCashEvent(data: Omit<InsertCashEvent, "id" | "createdAt">): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(cashEvents).values(data);
  return result[0].insertId;
}

export async function getCashEventById(id: number): Promise<CashEvent | null> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(cashEvents).where(eq(cashEvents.id, id));
  return rows[0] ?? null;
}

export async function deleteCashEvent(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(cashEvents).where(eq(cashEvents.id, id));
}

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(appSettings).values({ key, value }).onDuplicateKeyUpdate({ set: { value } });
}

// ===== Ended sessions (server/posAuth.ts) =====
export async function revokeSession(jti: string, notAfter: number, expiresAt: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // A logout after a renewal must not lengthen the grace: keep the earlier.
  await db
    .insert(revokedSessions)
    .values({ jti, notAfter, expiresAt })
    .onDuplicateKeyUpdate({ set: { notAfter: sql`LEAST(notAfter, ${notAfter})` } });
}

/** Every ended session that hasn't expired yet; forgets the rest. */
export async function listRevokedSessions(now: number): Promise<RevokedSession[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(revokedSessions).where(sql`${revokedSessions.expiresAt} <= ${now}`);
  return db.select().from(revokedSessions);
}

export async function getRevokedSession(jti: string): Promise<RevokedSession | undefined> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(revokedSessions).where(eq(revokedSessions.jti, jti));
  return rows[0];
}

// ===== Handover counter (受け渡し, server/handover.ts) =====
export type HandoverRow = Pick<
  Transaction,
  "id" | "orderNo" | "items" | "operator" | "createdAt" | "handoverPending" | "handedAt" | "handedBy"
>;

/**
 * Sales from about the last day that are waiting at the counter, or were
 * handed over in the last 15 minutes (for undo). Relative to the database's
 * own clock, like the timestamps it stored; the caller keeps today's.
 */
export async function listHandoverOrders(): Promise<HandoverRow[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db
    .select({
      id: transactions.id,
      orderNo: transactions.orderNo,
      items: transactions.items,
      operator: transactions.operator,
      createdAt: transactions.createdAt,
      handoverPending: transactions.handoverPending,
      handedAt: transactions.handedAt,
      handedBy: transactions.handedBy,
    })
    .from(transactions)
    .where(and(
      eq(transactions.voided, false),
      sql`${transactions.createdAt} >= NOW() - INTERVAL 1 DAY`,
      sql`(${transactions.handoverPending} = TRUE OR ${transactions.handedAt} >= NOW() - INTERVAL 15 MINUTE)`
    ))
    .orderBy(asc(transactions.createdAt), asc(transactions.id));
}

/** Marks one waiting order handed over. False if it wasn't waiting (someone else just did, or it was voided). */
export async function markHandedOver(id: number, by: string): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db
    .update(transactions)
    .set({ handoverPending: false, handedAt: sql`CURRENT_TIMESTAMP`, handedBy: by })
    .where(and(eq(transactions.id, id), eq(transactions.handoverPending, true), eq(transactions.voided, false)));
  return result[0].affectedRows === 1;
}

/** Puts a handed-over order back in the queue (tapped by mistake). */
export async function undoHandedOver(id: number): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db
    .update(transactions)
    .set({ handoverPending: true, handedAt: null, handedBy: null })
    .where(and(
      eq(transactions.id, id),
      eq(transactions.handoverPending, false),
      eq(transactions.voided, false),
      sql`${transactions.handedAt} IS NOT NULL`
    ));
  return result[0].affectedRows === 1;
}

/** Marks every waiting order handed over (sales typed in from paper, or a counter nobody staffed). */
export async function markAllHandedOver(by: string): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db
    .update(transactions)
    .set({ handoverPending: false, handedAt: sql`CURRENT_TIMESTAMP`, handedBy: by })
    .where(eq(transactions.handoverPending, true));
  return result[0].affectedRows;
}
