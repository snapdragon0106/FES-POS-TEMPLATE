import { useState, useEffect, useMemo, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { useQueryClient } from "@tanstack/react-query";
import { NAV_ITEMS, type NavKey } from "@shared/posTypes";
import Sidebar from "@/components/pos/Sidebar";
import BottomNav from "@/components/pos/BottomNav";
import POSRegister from "@/components/pos/POSRegister";
import Dashboard from "@/components/pos/Dashboard";
import InventoryTab from "@/components/pos/InventoryTab";
import ProductsTab from "@/components/pos/ProductsTab";
import HistoryTab from "@/components/pos/HistoryTab";
import ActivityLogTab from "@/components/pos/ActivityLogTab";
import PinManagerTab from "@/components/pos/PinManagerTab";
import AccountingTab from "@/components/pos/AccountingTab";
import HandoverTab from "@/components/pos/HandoverTab";
import ConnectionBanner from "@/components/pos/ConnectionBanner";
import { getErrorMessage } from "@/lib/errorMessage";
import { useTheme } from "@/contexts/ThemeContext";
import { Sun, Moon, LogOut, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { computeCoins, computeDrawer, shouldCollect, DEFAULT_COLLECT_THRESHOLD } from "@shared/cash";
import { isRestockAvailable, jstDate } from "@shared/stockSchedule";

/** "/" without a session is the server's login page (server/gate.ts). */
const LOGIN_URL = "/";

// The tab last open on this device, so a reload (or the phone dropping the
// page) comes back to it. A per-device convenience only: storage can be
// missing or blocked, and then the app opens on レジ as before.
const TAB_KEY = "pos_tab";
function savedTab(): NavKey {
  try {
    const v = localStorage.getItem(TAB_KEY);
    if (v && NAV_ITEMS.some((n) => n.key === v)) return v as NavKey;
  } catch {}
  return "pos";
}

export default function POSApp() {
  const [tab, setTabState] = useState<NavKey>(savedTab);
  const setTab = (next: NavKey) => {
    setTabState(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {}
  };
  const [syncing, setSyncing] = useState(false);

  const { theme, toggleTheme } = useTheme();

  // This app is only ever sent to a browser with a valid session — the
  // server decides that from the cookie and serves the login page instead
  // otherwise (server/gate.ts). So there is no login screen in here and no
  // "logged in?" flag of our own. posSession.me gives the name and the
  // admin flag for display; every action is still checked by the server.
  const meQuery = trpc.posSession.me.useQuery(undefined, { staleTime: Infinity, retry: 1 });
  const me = meQuery.data;
  const operator = me?.operatorId ?? "";
  const isAdmin = !!me?.isAdmin;
  const canManageCash = !!me?.canManageCash;
  // Wrong PINs in the last hour (server/login.ts): the admin sees them on
  // every tab, not only when the PIN tab happens to be open.
  const loginAlerts = trpc.pin.alerts.useQuery(undefined, { enabled: isAdmin, refetchInterval: 30000, retry: 1 }).data;
  const operatorName = me?.operatorName ?? "";
  useEffect(() => {
    // The session ended while the app was open (logged out elsewhere, PIN
    // reset, expired): the server's login page takes it from here.
    if (meQuery.isSuccess && me === null) window.location.replace(LOGIN_URL);
  }, [meQuery.isSuccess, me]);
  // An admin-only tab remembered on a phone now used by someone else.
  useEffect(() => {
    if (me && !me.isAdmin && NAV_ITEMS.find((n) => n.key === tab)?.admin) setTab("pos");
  }, [me, tab]);

  // Data queries - only enabled when session is ready.
  // refetchInterval makes every device pull the latest sales/stock automatically
  // (near real-time across all registers). refetchOnWindowFocus refreshes when a
  // phone wakes from sleep. Increase POLL_MS if you have many devices or want to
  // be gentle on the TiDB free quota.
  const POLL_MS = 8000;
  const poll = {
    // Only once the server has confirmed the session (posSession.me). A
    // stale or hand-made "logged in" marker used to start every poll,
    // each answered 401, and the 401 handler reloaded the page — under the
    // cashier's fingers, mid-login.
    enabled: !!me,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    // One quick retry, not React Query's default three with backoff: the
    // next poll is only 8s away anyway, and three retries (each allowed
    // the full request timeout) would keep an outage hidden from the
    // connection banner for over a minute.
    retry: 1,
  };
  const productsQuery = trpc.product.list.useQuery(undefined, poll);
  const transactionsQuery = trpc.transaction.list.useQuery(undefined, poll);
  const restocksQuery = trpc.restock.list.useQuery(undefined, poll);
  // Admin-only on the server too. Only the admin has the 操作 tab, so
  // every other register downloading the whole log every 8 seconds was
  // pure waste — about a third of each phone's traffic at festival scale.
  const logsQuery = trpc.activityLog.list.useQuery(undefined, { ...poll, enabled: poll.enabled && isAdmin });
  // Units another register is in the middle of selling. Returns {} when
  // cashless is disabled, so a cash-only shop pays nothing for this.
  const reservedQuery = trpc.payment.reservedStock.useQuery(undefined, poll);
  // The cash drawer ledger (釣り銭・回収・締め) — a handful of rows a day.
  // Polled like the rest so the 回収 reminder reaches every register.
  const cashQuery = trpc.cash.list.useQuery(undefined, poll);
  // Orders waiting at the handover counter (server/handover.ts). Every 2
  // seconds on the counter's own screen, so an order shows up there right
  // after 会計完了; with the rest otherwise, for the count on the tab. The
  // server answers from memory unless something changed, so this costs the
  // database nothing between sales.
  const handoverQuery = trpc.handover.queue.useQuery(undefined, {
    ...poll,
    refetchInterval: tab === "handover" ? 2000 : POLL_MS,
    refetchIntervalInBackground: tab === "handover",
  });
  const handoverCount = handoverQuery.data?.pending.length ?? 0;

  const products = productsQuery.data || [];
  const transactions = transactionsQuery.data || [];
  const restocksList = restocksQuery.data || [];
  const activityLogs = logsQuery.data || [];
  const reservedMap = reservedQuery.data || {};
  const cashEvents = cashQuery.data?.events || [];
  const collectThreshold = cashQuery.data?.collectThreshold ?? DEFAULT_COLLECT_THRESHOLD;
  const drawer = useMemo(() => computeDrawer(cashEvents, transactions), [cashEvents, transactions]);
  // What is in the box note by note (an estimate): drives the "running
  // low" warning and how the checkout says to hand over change.
  const coins = useMemo(() => computeCoins(cashEvents, transactions), [cashEvents, transactions]);
  const loading = productsQuery.isLoading || transactionsQuery.isLoading;

  // Today in Japan time, re-checked every minute: stock scheduled for a
  // later day joins the count at 0:00 on its own, without waiting for the
  // data to change (the server switches at the same moment).
  const [today, setToday] = useState(() => jstDate());
  useEffect(() => {
    const t = setInterval(() => setToday(jstDate()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Stock calculation — the same arithmetic as server/stock.ts computeStock.
  const { stockMap, initialMap } = useMemo(() => {
    const sMap: Record<number, number> = {};
    const iMap: Record<number, number> = {};
    products.forEach((p) => {
      sMap[p.id] = p.initialStock || 0;
      iMap[p.id] = p.initialStock || 0;
    });
    transactions.forEach((t) => {
      if (!t.voided && Array.isArray(t.items)) {
        (t.items as any[]).forEach((it) => {
          if (sMap[it.product_id] != null) sMap[it.product_id] -= it.qty;
        });
      }
    });
    restocksList.forEach((r) => {
      if (!isRestockAvailable(r, today)) return; // a later day's stock: not on sale yet
      if (sMap[r.productId] != null) {
        sMap[r.productId] += r.amount;
        iMap[r.productId] += r.amount;
      }
    });
    // Goods held by in-flight cashless payments are neither sold nor
    // available — someone is partway through buying them. Subtracting
    // them here is what stops a second register from selling the last
    // one while the first customer's card is still being read. The
    // server enforces the same thing under a row lock; this only keeps
    // the screen honest.
    Object.entries(reservedMap).forEach(([productId, qty]) => {
      const id = Number(productId);
      if (sMap[id] != null) sMap[id] -= qty as number;
    });
    return { stockMap: sMap, initialMap: iMap };
  }, [products, transactions, restocksList, reservedMap, today]);

  const getStock = useCallback((id: number) => stockMap[id] ?? 0, [stockMap]);

  // Mutations
  const posLogout = trpc.posSession.logout.useMutation();
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  const handleLogout = async () => {
    // The server ends the session (the cookie stops working even if it
    // was copied), then its login page takes over.
    await posLogout.mutateAsync().catch(() => {});
    // Drop everything this session fetched (the admin's logs, accounts,
    // PIN list…) so none of it lingers in memory on this phone.
    queryClient.clear();
    window.location.replace(LOGIN_URL);
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      // refetch({ throwOnError }) rather than invalidate(): invalidate
      // resolves even when the refetch fails, which made this button report
      // 同期完了 while the server was unreachable — exactly when the cashier
      // needs the truth.
      await Promise.all([
        productsQuery.refetch({ throwOnError: true }),
        transactionsQuery.refetch({ throwOnError: true }),
        restocksQuery.refetch({ throwOnError: true }),
        reservedQuery.refetch({ throwOnError: true }),
        ...(isAdmin ? [logsQuery.refetch({ throwOnError: true })] : []),
      ]);
      toast.success("同期完了");
    } catch (e) {
      toast.error(getErrorMessage(e, "同期できませんでした"));
    } finally {
      setSyncing(false);
    }
  };

  // The session is checked with the server (posSession.me) before any of
  // the app is built: a stale or hand-made "logged in" marker must never
  // put the register on screen, even for a moment.
  if (meQuery.isError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 p-6 text-center" style={{ background: "var(--ws-bg)" }}>
        <p className="text-sm" style={{ color: "var(--ws-ts)" }}>サーバーに接続できません。電波を確認して、もう一度お試しください。</p>
        <button onClick={() => meQuery.refetch()} className="px-4 py-2 text-sm font-bold" style={{ background: "var(--ws-ac)", color: "#fff", border: "none" }}>
          再試行
        </button>
      </div>
    );
  }

  // Show loading while restoring server session
  if (!me) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--ws-bg)" }}>
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-3" style={{ borderColor: "var(--ws-ac)", borderTopColor: "transparent" }} />
          <p className="text-sm" style={{ color: "var(--ws-ts)" }}>セッション復元中...</p>
        </div>
      </div>
    );
  }

  const visibleNavItems = NAV_ITEMS.filter((n) => !n.admin || isAdmin);

  return (
    <div className="min-h-screen" style={{ background: "var(--ws-bg)", fontFamily: "var(--font-body)" }}>
      {/* PC Sidebar */}
      <Sidebar
        tab={tab}
        setTab={setTab}
        isAdmin={isAdmin}
        operator={operator}
        operatorName={operatorName}
        onSync={handleSync}
        syncing={syncing}
        onLogout={handleLogout}
        badges={{ handover: handoverCount }}
      />

      {/* Main content */}
      <main className="md:ml-[260px] pb-28 md:pb-6 p-4 md:p-6">
        {/* Mobile header */}
        <div className="md:hidden flex items-center justify-between mb-4 px-1">
          <div className="flex items-center gap-2">
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center"
              style={{ background: "radial-gradient(circle at 32% 28%, var(--ws-secc) 0%, var(--ws-secc-deep) 100%)" }}
            >
              <span className="text-sm">🏪</span>
            </div>
            <span className="font-bold text-sm" style={{ color: "var(--ws-tx)" }}>
              FES POS
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => toggleTheme?.()}
              aria-label="テーマ切替"
              className="w-9 h-9 rounded-full flex items-center justify-center"
              style={{ background: "var(--ws-s2)", color: "var(--ws-ts)", border: "none", cursor: "pointer" }}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <span className="font-number text-xs font-bold" style={{ color: "var(--ws-ts)" }}>
              {operator}
            </span>
            {isAdmin && (
              <span className="ws-badge" style={{ background: "var(--ws-org)", color: "var(--ws-or)" }}>
                管理者
              </span>
            )}
            <button
              onClick={handleLogout}
              aria-label="退室する"
              className="w-9 h-9 rounded-full flex items-center justify-center"
              style={{ background: "var(--ws-dgs)", color: "var(--ws-dg)", border: "none", cursor: "pointer" }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>

        <ConnectionBanner
          serverUnreachable={productsQuery.isError || transactionsQuery.isError}
          lastSyncedAt={transactionsQuery.dataUpdatedAt}
          onRetry={handleSync}
          retrying={syncing}
        />

        {isAdmin && loginAlerts && (loginAlerts.adminFailures > 0 || loginAlerts.failures >= 5) && (
          <button
            onClick={() => setTab("pinmgr")}
            className="w-full flex items-start gap-2 p-3 mb-3 rounded-xl text-[13px] font-bold text-left"
            style={{ background: "var(--ws-dgs)", color: "var(--ws-dg)", border: "none", cursor: "pointer" }}
          >
            <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
            直近1時間にPINの入力ミスが {loginAlerts.failures} 回
            {loginAlerts.adminFailures > 0 ? `（うち管理者の番号 ${loginAlerts.adminFailures} 回）` : ""}。PIN管理で確認してください
          </button>
        )}

        {/* Tab content */}
        {tab === "pos" && (
          <POSRegister
            products={products}
            getStock={getStock}
            operator={operator}
            operatorName={operatorName}
            isAdmin={isAdmin}
            onSync={handleSync}
            collectReminder={shouldCollect(drawer, collectThreshold) ? drawer.takings : null}
            coins={coins}
          />
        )}
        {tab === "handover" && (
          <HandoverTab queue={handoverQuery.data} loading={handoverQuery.isLoading} />
        )}
        {tab === "dashboard" && (
          <Dashboard
            products={products}
            transactions={transactions}
            drawer={drawer}
            coins={coins}
            cashEvents={cashEvents}
            collectThreshold={collectThreshold}
            isAdmin={isAdmin}
            canManageCash={canManageCash}
          />
        )}
        {tab === "inventory" && (
          <InventoryTab
            products={products}
            getStock={getStock}
            initialMap={initialMap}
            restocks={restocksList}
            today={today}
            isAdmin={isAdmin}
            operator={operator}
            operatorName={operatorName}
          />
        )}
        {tab === "products" && isAdmin && (
          <ProductsTab
            products={products}
            operator={operator}
            operatorName={operatorName}
          />
        )}
        {tab === "history" && (
          <HistoryTab
            transactions={transactions}
            isAdmin={isAdmin}
            operator={operator}
          />
        )}
        {tab === "accounting" && isAdmin && (
          <AccountingTab
            transactions={transactions}
            operator={operator}
            isAdmin={isAdmin}
          />
        )}
        {tab === "actlog" && isAdmin && (
          <ActivityLogTab logs={activityLogs} />
        )}
        {tab === "pinmgr" && isAdmin && (
          <PinManagerTab operator={operator} />
        )}
      </main>

      {/* Mobile bottom nav */}
      <BottomNav tab={tab} setTab={setTab} isAdmin={isAdmin} badges={{ handover: handoverCount }} />
    </div>
  );
}
