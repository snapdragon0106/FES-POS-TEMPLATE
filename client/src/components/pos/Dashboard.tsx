import { useMemo, useCallback } from "react";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { TrendingUp, ShoppingBag, Percent, Receipt, Download } from "lucide-react";
import {
  DEFAULT_PAYMENT_METHOD,
  PAYMENT_METHOD_STYLE,
  isCashless,
  paymentMethodOf,
  type PaymentMethod,
} from "@shared/paymentTypes";

import type { CoinEstimate, DrawerState } from "@shared/cash";
import CashSection from "./CashSection";

const yen = (n: number) => "¥" + Math.round(n || 0).toLocaleString("ja-JP");

const methodOf = (tx: any): PaymentMethod => paymentMethodOf(tx.paymentMethod);

/**
 * One CSV cell, quoted. Text that Excel would read as a formula (starting
 * with = + - @, or a tab/CR) gets a leading ' so it stays text: product
 * names and slip numbers are typed in by people, and "=HYPERLINK(…)" in
 * one of them would otherwise run when the sheet is opened (CSV injection).
 * Plain numbers, including negative ones, are left alone.
 */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

interface Props {
  products: any[];
  transactions: any[];
  drawer: DrawerState;
  coins: CoinEstimate;
  cashEvents: any[];
  collectThreshold: number;
  isAdmin: boolean;
  canManageCash: boolean;
}

export default function Dashboard({ products, transactions, drawer, coins, cashEvents, collectThreshold, isAdmin, canManageCash }: Props) {
  const stats = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const valid = transactions.filter((t: any) => !t.voided && new Date(t.createdAt) >= todayStart);
    const totalSales = valid.reduce((s: number, t: any) => s + t.total, 0);
    const totalCost = valid.reduce(
      (s: number, t: any) =>
        s + (Array.isArray(t.items) ? (t.items as any[]) : []).reduce((a: number, it: any) => a + (it.cost || 0) * it.qty, 0),
      0
    );
    const profit = totalSales - totalCost;
    const margin = totalSales ? profit / totalSales : 0;

    const byProduct: { name: string; qty: number; rev: number }[] = products.map((p) => {
      let qty = 0, rev = 0;
      valid.forEach((t: any) =>
        (Array.isArray(t.items) ? (t.items as any[]) : []).forEach((it: any) => {
          if (it.product_id === p.id) { qty += it.qty; rev += it.price * it.qty; }
        })
      );
      return { name: p.emoji + " " + p.name, qty, rev };
    }).sort((a, b) => b.rev - a.rev);

    const hourly: Record<number, number> = {};
    valid.forEach((t: any) => {
      const h = new Date(t.createdAt).getHours();
      hourly[h] = (hourly[h] || 0) + t.total;
    });
    const hourlyData = Object.keys(hourly)
      .sort((a, b) => Number(a) - Number(b))
      .map((h) => ({ time: h + "時", sales: hourly[Number(h)] }));

    // Split by payment method. `cashSales` is the number that has to
    // match the money physically in the drawer at the end of the day —
    // cashless sales raise the day's total without putting a yen in it,
    // so counting the drawer against totalSales would look like a
    // shortage every time.
    const byMethod = new Map<PaymentMethod, { count: number; total: number }>();
    valid.forEach((t: any) => {
      const m = methodOf(t);
      const entry = byMethod.get(m) ?? { count: 0, total: 0 };
      entry.count += 1;
      entry.total += t.total;
      byMethod.set(m, entry);
    });
    const cashSales = byMethod.get(DEFAULT_PAYMENT_METHOD)?.total ?? 0;
    const methodBreakdown = Array.from(byMethod.entries())
      .map(([method, v]) => ({ method, ...v }))
      .sort((a, b) => b.total - a.total);
    const hasCashless = methodBreakdown.some((m) => isCashless(m.method));

    return {
      totalSales,
      profit,
      margin,
      txCount: valid.length,
      byProduct,
      hourlyData,
      cashSales,
      methodBreakdown,
      hasCashless,
    };
  }, [products, transactions]);

  // === CSV Export ===
  const exportCSV = useCallback(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const valid = transactions.filter((t: any) => !t.voided && new Date(t.createdAt) >= todayStart);

    // BOM for Excel compatibility
    const BOM = "\uFEFF";
    const headers = ["取引ID", "日時", "担当者", "商品名", "数量", "単価", "小計", "合計", "支払い方法", "伝票番号", "預かり金", "お釣り"];
    const rows: string[][] = [];

    valid.forEach((t: any) => {
      const dt = new Date(t.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
      const items = t.items as any[] || [];
      const method = methodOf(t);
      const cashless = isCashless(method);
      items.forEach((it: any, idx: number) => {
        rows.push([
          idx === 0 ? String(t.id) : "",
          idx === 0 ? dt : "",
          idx === 0 ? (t.operator || "") : "",
          it.name || "",
          String(it.qty),
          String(it.price),
          String(it.price * it.qty),
          idx === 0 ? String(t.total) : "",
          idx === 0 ? PAYMENT_METHOD_STYLE[method].label : "",
          // The line the payment company's 入金明細 is matched against.
          idx === 0 ? (t.paymentRef || "") : "",
          // Blank rather than 0 for cashless: a 0 in 預かり金 reads as
          // "received nothing", when in fact no cash was involved at all.
          idx === 0 ? (cashless ? "" : String(t.received)) : "",
          idx === 0 ? (cashless ? "" : String(t.changeAmount)) : "",
        ]);
      });
    });

    const csvContent = BOM + [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD in local time (toISOString is UTC: wrong date before 9am JST)
    a.href = url;
    a.download = `売上データ_${today}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [transactions]);

  // === Summary CSV Export ===
  const exportSummaryCSV = useCallback(() => {
    const BOM = "\uFEFF";
    const headers = ["商品名", "販売数", "売上金額"];
    const rows: string[][] = stats.byProduct.map((p) => [
      p.name,
      String(p.qty),
      String(p.rev),
    ]);

    // Add totals row
    rows.push([
      "合計",
      String(stats.byProduct.reduce((s, p) => s + p.qty, 0)),
      String(stats.totalSales),
    ]);

    const csvContent = BOM + [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD in local time (toISOString is UTC: wrong date before 9am JST)
    a.href = url;
    a.download = `商品別集計_${today}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [stats]);

  const subKpis = [
    { label: "本日の取引数", value: stats.txCount + "件", icon: Receipt, color: "var(--ws-sc)", bg: "var(--ws-scg)" },
    { label: "粗利", value: yen(stats.profit), icon: ShoppingBag, color: "var(--ws-or)", bg: "var(--ws-org)" },
    { label: "粗利率", value: (stats.margin * 100).toFixed(1) + "%", icon: Percent, color: "var(--ws-warn)", bg: "var(--ws-wns)" },
  ];

  return (
    <div className="ws-fade">
      <div className="flex items-center justify-between mb-5">
        <h2 className="hos-title">売上ダッシュボード</h2>
        <div className="flex gap-2">
          <button
            onClick={exportCSV}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold transition-all duration-150 active:scale-[0.97]"
            style={{ background: "var(--ws-s2)", color: "var(--ws-tx)", border: "1px solid var(--ws-bd)" }}
            title="取引明細をCSVでダウンロード"
          >
            <Download size={14} />
            取引明細
          </button>
          <button
            onClick={exportSummaryCSV}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold transition-all duration-150 active:scale-[0.97]"
            style={{ background: "var(--ws-s2)", color: "var(--ws-tx)", border: "1px solid var(--ws-bd)" }}
            title="商品別集計をCSVでダウンロード"
          >
            <Download size={14} />
            商品別集計
          </button>
        </div>
      </div>

      {/* Hero KPI — HarmonyOS card guideline: the single most important
          number gets a dedicated, large, high-contrast presentation. */}
      <div className="ws-card p-6 mb-3 flex items-center gap-5">
        <div
          className="ws-icon-chip"
          style={{ background: "radial-gradient(circle at 32% 28%, var(--ws-secc) 0%, var(--ws-secc-deep) 100%)", color: "var(--ws-onsecc)", width: 56, height: 56, fontSize: 24 }}
        >
          <TrendingUp size={24} />
        </div>
        <div>
          <div className="hos-caption mb-1">本日の売上</div>
          <div className="hos-display font-number">{yen(stats.totalSales)}</div>
        </div>
      </div>

      {/* Supporting KPIs — smaller, grouped below the hero card */}
      <div className="grid grid-cols-3 gap-2.5 mb-6">
        {subKpis.map((k) => (
          <div key={k.label} className="ws-card p-3.5 flex flex-col items-start gap-2">
            <div className="ws-icon-chip-sm" style={{ background: k.bg, color: k.color }}>
              <k.icon size={15} />
            </div>
            <div>
              <div className="hos-caption mb-0.5">{k.label}</div>
              <div className="font-number text-[15px] font-extrabold" style={{ color: "var(--ws-tx)" }}>{k.value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Payment breakdown — only rendered once a cashless sale exists,
          so a cash-only festival sees the dashboard it always had. The
          点線 row is the one that matters at closing time: it is what the
          cash drawer should actually contain. */}
      {stats.hasCashless && (
        <div className="ws-card p-5 mb-6">
          <h3 className="hos-subtitle mb-4">支払い方法別</h3>
          <div className="flex flex-col gap-2.5">
            {stats.methodBreakdown.map((m) => {
              const style = PAYMENT_METHOD_STYLE[m.method];
              const share = stats.totalSales ? m.total / stats.totalSales : 0;
              return (
                <div key={m.method} className="flex items-center gap-3">
                  <span className="ws-icon-chip-sm" style={{ background: style.bg, color: style.color, fontSize: 13 }}>
                    {style.emoji}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="text-[13px] font-bold block truncate" style={{ color: "var(--ws-tx)" }}>
                      {style.label}
                    </span>
                    <span className="hos-caption">{m.count}件 ・ {(share * 100).toFixed(0)}%</span>
                  </span>
                  <span className="font-number font-extrabold text-[15px]" style={{ color: "var(--ws-tx)" }}>
                    {yen(m.total)}
                  </span>
                </div>
              );
            })}
          </div>
          <hr className="ws-sep my-3.5" />
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold" style={{ color: "var(--ws-ts)" }}>
              うち現金での売上（レジの現金は下の「レジの現金」で確認）
            </span>
            <span className="font-number font-extrabold text-lg" style={{ color: "var(--ws-sc)" }}>
              {yen(stats.cashSales)}
            </span>
          </div>
        </div>
      )}

      <CashSection
        drawer={drawer}
        coins={coins}
        events={cashEvents}
        collectThreshold={collectThreshold}
        products={products}
        transactions={transactions}
        isAdmin={isAdmin}
        canManageCash={canManageCash}
      />

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Product Sales */}
        <div className="ws-card p-5">
          <h3 className="hos-subtitle mb-4">商品別売上</h3>
          {stats.byProduct.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={stats.byProduct} layout="vertical" margin={{ left: 60, right: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--ws-bd)" />
                <XAxis type="number" tick={{ fill: "var(--ws-ts)", fontSize: 11 }} />
                <YAxis type="category" dataKey="name" tick={{ fill: "var(--ws-ts)", fontSize: 11 }} width={80} />
                <Tooltip
                  contentStyle={{ background: "var(--ws-s2)", border: "1px solid var(--ws-bd)", borderRadius: 12, color: "var(--ws-tx)" }}
                  formatter={(value: number) => [yen(value), "売上"]}
                />
                <Bar dataKey="rev" fill="var(--ws-ac)" radius={[0, 8, 8, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-center py-10 hos-body">データなし</div>
          )}
        </div>

        {/* Hourly Sales */}
        <div className="ws-card p-5">
          <h3 className="hos-subtitle mb-4">時間帯別売上</h3>
          {stats.hourlyData.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={stats.hourlyData} margin={{ left: 20, right: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--ws-bd)" />
                <XAxis dataKey="time" tick={{ fill: "var(--ws-ts)", fontSize: 11 }} />
                <YAxis tick={{ fill: "var(--ws-ts)", fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: "var(--ws-s2)", border: "1px solid var(--ws-bd)", borderRadius: 12, color: "var(--ws-tx)" }}
                  formatter={(value: number) => [yen(value), "売上"]}
                />
                <Line type="monotone" dataKey="sales" stroke="var(--ws-sc)" strokeWidth={2.5} dot={{ fill: "var(--ws-sc)", r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-center py-10 hos-body">データなし</div>
          )}
        </div>
      </div>
    </div>
  );
}
