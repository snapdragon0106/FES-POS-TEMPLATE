import { useEffect, useState, useMemo } from "react";
import { Wallet, Trash2, Plus, Landmark, Printer } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errorMessage";
import { dissolveOut, dissolveRestore } from "@/lib/dissolve";

const yen = (n: number) => "¥" + Math.round(n || 0).toLocaleString("ja-JP");

/** "令和8年10月" for the report's date line, from today's date (Japan time). */
function reiwaMonth(now = new Date()): string {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric" })
    .format(now)
    .split("-")
    .map(Number);
  return `令和${y - 2018}年${m}月`;
}

interface Props {
  transactions: any[];
  operator: string;
  isAdmin: boolean;
}

// ===== Purchase entry form (matches 仕入帳: 摘要/数量/単価/金額/レシートNO) =====
function PurchaseForm({ onSubmit }: { onSubmit: (v: { label: string; amount: number; quantity?: number; unitPrice?: number; receiptNo: string }) => void }) {
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [receiptNo, setReceiptNo] = useState("");

  const submit = () => {
    const amt = Number(amount);
    if (!label.trim()) { toast.error("摘要（商品名）を入力してください"); return; }
    if (!Number.isInteger(amt) || amt <= 0) { toast.error("金額を正しく入力してください"); return; }
    onSubmit({
      label: label.trim(),
      amount: amt,
      quantity: quantity ? Number(quantity) : undefined,
      unitPrice: unitPrice ? Number(unitPrice) : undefined,
      receiptNo: receiptNo.trim(),
    });
    setLabel(""); setAmount(""); setQuantity(""); setUnitPrice(""); setReceiptNo("");
  };

  return (
    <div className="ws-card p-3.5 flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="摘要（商品名）例：食材一式"
          className="ws-input text-sm"
          style={{ flex: "1 1 0%", minWidth: 0, width: "auto" }}
        />
        <input
          value={receiptNo}
          onChange={(e) => setReceiptNo(e.target.value)}
          placeholder="レシートNO"
          className="ws-input text-sm"
          style={{ flex: "0 1 110px", minWidth: 0, width: "auto" }}
        />
      </div>
      <div className="flex gap-2">
        <input
          value={quantity}
          onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          placeholder="数量（任意）"
          className="ws-input font-number text-sm"
          style={{ flex: "1 1 0%", minWidth: 0, width: "auto" }}
        />
        <input
          value={unitPrice}
          onChange={(e) => setUnitPrice(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          placeholder="単価（任意）"
          className="ws-input font-number text-sm"
          style={{ flex: "1 1 0%", minWidth: 0, width: "auto" }}
        />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          placeholder="金額"
          className="ws-input font-number text-sm"
          style={{ flex: "1 1 0%", minWidth: 0, width: "auto" }}
        />
      </div>
      <button
        onClick={submit}
        className="flex items-center justify-center gap-1 py-2 text-sm font-bold"
        style={{ background: "var(--ws-ac)", color: "#fff", border: "none", cursor: "pointer" }}
      >
        <Plus size={14} />
        追加
      </button>
    </div>
  );
}

// ===== Simple entry form (deduction / loan repay: 摘要 + 金額 + メモ) =====
function SimpleForm({ placeholder, onSubmit }: { placeholder: string; onSubmit: (label: string, amount: number, note: string) => void }) {
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const submit = () => {
    const amt = Number(amount);
    if (!label.trim()) { toast.error("項目名を入力してください"); return; }
    if (!Number.isInteger(amt) || amt <= 0) { toast.error("金額を正しく入力してください"); return; }
    onSubmit(label.trim(), amt, note.trim());
    setLabel(""); setAmount(""); setNote("");
  };

  return (
    <div className="ws-card p-3.5 flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={placeholder}
          className="ws-input text-sm"
          style={{ flex: "1 1 0%", minWidth: 0, width: "auto" }}
        />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          placeholder="金額"
          className="ws-input font-number text-sm"
          style={{ flex: "0 1 112px", minWidth: 0, width: "auto" }}
        />
      </div>
      <div className="flex gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="メモ（任意）"
          className="ws-input text-xs"
          style={{ flex: "1 1 0%", minWidth: 0, width: "auto" }}
        />
        <button
          onClick={submit}
          className="flex items-center gap-1 px-4 text-sm font-bold"
          style={{ background: "var(--ws-ac)", color: "#fff", border: "none", cursor: "pointer" }}
        >
          <Plus size={14} />
          追加
        </button>
      </div>
    </div>
  );
}

export default function AccountingTab({ transactions, operator, isAdmin }: Props) {
  const entriesQuery = trpc.accounting.list.useQuery();
  const createEntry = trpc.accounting.create.useMutation();
  const deleteEntry = trpc.accounting.delete.useMutation();
  const utils = trpc.useUtils();

  // 行事名・団体名・借入金 are kept on the server (accounting.settings), so
  // next year's class only changes them here; 代表者 is typed when printing.
  const settingsQuery = trpc.accounting.settings.useQuery();
  const saveSettings = trpc.accounting.saveSettings.useMutation();
  const [eventName, setEventName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [loanText, setLoanText] = useState("40000");
  const [repName, setRepName] = useState("");
  useEffect(() => {
    const s = settingsQuery.data;
    if (!s) return;
    setEventName(s.eventName);
    setGroupName(s.groupName);
    setLoanText(String(s.loanAmount));
  }, [settingsQuery.data]);
  const LOAN_AMOUNT = Number(loanText) || 0;
  const settingsDirty =
    !!settingsQuery.data &&
    (eventName !== settingsQuery.data.eventName || groupName !== settingsQuery.data.groupName || LOAN_AMOUNT !== settingsQuery.data.loanAmount);
  const handleSaveSettings = async () => {
    try {
      await saveSettings.mutateAsync({ eventName, groupName, loanAmount: LOAN_AMOUNT });
      toast.success("報告書の設定を保存しました");
      utils.accounting.settings.invalidate();
    } catch (e) {
      toast.error(getErrorMessage(e, "保存できませんでした"));
    }
  };

  const entries = entriesQuery.data || [];
  const purchases = entries.filter((e: any) => e.category === "purchase");
  const deductions = entries.filter((e: any) => e.category === "deduction");
  const loanRepayments = entries.filter((e: any) => e.category === "loan_repay");

  // ===== Totals — matches the school's official 文化祭物品販売報告書 math =====
  // ①収益合計 = 売上高、②支出合計 = 借入高（設定、既定40,000円）＋控除費目、
  // 残金（①－②）＝①－②。実際の仕入れ額は、様式上この計算には使わない
  // （仕入帳は別途の明細書として提出するもの）。
  const totals = useMemo(() => {
    const totalSales = transactions
      .filter((t: any) => !t.voided)
      .reduce((s: number, t: any) => s + t.total, 0);
    const deductionTotal = deductions.reduce((s: number, e: any) => s + e.amount, 0);
    const shishutsuGokei = LOAN_AMOUNT + deductionTotal; // 支出合計②
    const zankin = totalSales - shishutsuGokei; // 残金（①－②）
    const purchaseTotal = purchases.reduce((s: number, e: any) => s + e.amount, 0);
    const loanRepaid = loanRepayments.reduce((s: number, e: any) => s + e.amount, 0);
    const loanRemaining = LOAN_AMOUNT - loanRepaid;
    return { totalSales, deductionTotal, shishutsuGokei, zankin, purchaseTotal, loanRepaid, loanRemaining };
  }, [transactions, deductions, purchases, loanRepayments, LOAN_AMOUNT]);

  const handleAddPurchase = async (v: { label: string; amount: number; quantity?: number; unitPrice?: number; receiptNo: string }) => {
    try {
      // server/routers.ts accounting.create already writes the activity log
      // atomically — a client-side addLog call here used to create a
      // second, duplicate log entry for the same action.
      await createEntry.mutateAsync({ category: "purchase", label: v.label, amount: v.amount, quantity: v.quantity, unitPrice: v.unitPrice, receiptNo: v.receiptNo || undefined });
      toast.success("記録しました");
      utils.accounting.list.invalidate();
    } catch (e) {
      toast.error(getErrorMessage(e, "記録に失敗しました"));
    }
  };

  const handleAdd = async (category: "deduction" | "loan_repay", label: string, amount: number, note: string) => {
    try {
      await createEntry.mutateAsync({ category, label, amount, note: note || undefined });
      toast.success("記録しました");
      utils.accounting.list.invalidate();
    } catch (e) {
      toast.error(getErrorMessage(e, "記録に失敗しました"));
    }
  };

  const handleDelete = async (id: number, category: string, label: string, ev: React.MouseEvent) => {
    const row = (ev.currentTarget as HTMLElement).closest(".ws-card") as HTMLElement | null;
    if (!confirm(`「${label}」の記録を削除しますか？`)) return;
    try {
      const del = deleteEntry.mutateAsync({ id, category: category as any });
      if (row) await dissolveOut(row);
      await del;
      toast.success("削除しました");
      utils.accounting.list.invalidate();
    } catch (e) {
      if (row) dissolveRestore(row);
      toast.error(getErrorMessage(e, "削除に失敗しました"));
    }
  };

  const dateStr = (iso: string) => new Date(iso).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });

  const PurchaseRow = ({ e }: { e: any }) => (
    <div className="ws-card p-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="hos-subtitle truncate" style={{ fontSize: 14 }}>{e.label}</div>
        <div className="hos-caption">
          {dateStr(e.createdAt)}
          {e.receiptNo ? ` ・ No.${e.receiptNo}` : ""}
          {e.quantity ? ` ・ 数量${e.quantity}` : ""}
          {e.unitPrice ? ` ・ 単価${yen(e.unitPrice)}` : ""}
        </div>
      </div>
      <span className="font-number font-extrabold">{yen(e.amount)}</span>
      {isAdmin && (
        <button onClick={(ev) => handleDelete(e.id, e.category, e.label, ev)} className="ws-icon-chip-sm" style={{ width: 28, height: 28, background: "var(--ws-dgs)", color: "var(--ws-dg)", border: "none", cursor: "pointer" }}>
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );

  const SimpleRow = ({ e }: { e: any }) => (
    <div className="ws-card p-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="hos-subtitle truncate" style={{ fontSize: 14 }}>{e.label}</div>
        <div className="hos-caption">{dateStr(e.createdAt)}{e.note ? ` ・ ${e.note}` : ""}</div>
      </div>
      <span className="font-number font-extrabold">{yen(e.amount)}</span>
      {isAdmin && (
        <button onClick={(ev) => handleDelete(e.id, e.category, e.label, ev)} className="ws-icon-chip-sm" style={{ width: 28, height: 28, background: "var(--ws-dgs)", color: "var(--ws-dg)", border: "none", cursor: "pointer" }}>
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );

  // Flatten transactions into one row per item, matching 売上帳's per-line format.
  const salesLedgerRows = useMemo(() => {
    const rows: { date: string; receiptNo: number; name: string; qty: number; price: number; amount: number; txTotal: number; isLast: boolean }[] = [];
    transactions.filter((t: any) => !t.voided).forEach((t: any) => {
      const items = Array.isArray(t.items) ? (t.items as any[]) : [];
      items.forEach((it: any, idx: number) => {
        rows.push({
          date: dateStr(t.createdAt),
          receiptNo: t.id,
          name: it.name,
          qty: it.qty,
          price: it.price,
          amount: it.price * it.qty,
          txTotal: t.total,
          isLast: idx === items.length - 1,
        });
      });
    });
    return rows;
  }, [transactions]);

  return (
    <div className="ws-fade">
      <div className="flex items-center justify-between mb-1">
        <h2 className="hos-title">会計報告</h2>
        <button
          onClick={() => window.print()}
          className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold"
          style={{ background: "var(--ws-s2)", color: "var(--ws-tx)", border: "1px solid var(--ws-bd)", cursor: "pointer" }}
        >
          <Printer size={14} />
          PDF出力
        </button>
      </div>
      <p className="hos-caption mb-4">学校指定の様式（仕入帳・売上帳・物品販売報告書）でPDF出力します</p>

      {/* Names and the loan amount on the printed report. 行事名・団体名・借入金 are saved for next time. */}
      <div className="ws-card p-4 mb-4 flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 min-w-0">
            <span className="hos-caption">行事名</span>
            <input value={eventName} onChange={(e) => setEventName(e.target.value)} placeholder="例：経高祭" maxLength={30} className="ws-input text-sm" />
          </label>
          <label className="flex flex-col gap-1 min-w-0">
            <span className="hos-caption">団体名</span>
            <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="例：3年5組" maxLength={40} className="ws-input text-sm" />
          </label>
          <label className="flex flex-col gap-1 min-w-0">
            <span className="hos-caption">仕入代金の借入金（円）</span>
            <input value={loanText} onChange={(e) => setLoanText(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className="ws-input font-number text-sm" />
          </label>
          <label className="flex flex-col gap-1 min-w-0">
            <span className="hos-caption">代表者生徒氏名（保存しません）</span>
            <input value={repName} onChange={(e) => setRepName(e.target.value)} placeholder="印刷するときに入力" className="ws-input text-sm" />
          </label>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="hos-caption">{settingsDirty ? "変更が保存されていません" : "行事名・団体名・借入金は、次に開いたときも残ります"}</span>
          <button
            onClick={handleSaveSettings}
            disabled={!settingsDirty || saveSettings.isPending}
            className="px-3.5 py-2 text-xs font-bold flex-shrink-0"
            style={{ background: "var(--ws-ac)", color: "#fff", border: "none", cursor: "pointer", opacity: !settingsDirty || saveSettings.isPending ? 0.5 : 1 }}
          >
            保存
          </button>
        </div>
      </div>

      {/* Summary — matches 文化祭物品販売報告書 */}
      <div className="ws-card p-5 mb-4">
        <div className="hos-subtitle mb-3">最終集計（物品販売報告書）</div>
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between"><span className="hos-body">① 収益合計（売上高）</span><span className="font-number font-bold">{yen(totals.totalSales)}</span></div>
          <hr className="ws-sep" />
          <div className="flex justify-between"><span className="hos-body">仕入代金借入高</span><span className="font-number">{yen(LOAN_AMOUNT)}</span></div>
          <div className="flex justify-between"><span className="hos-body">保菌検査代・その他（控除）</span><span className="font-number">{yen(totals.deductionTotal)}</span></div>
          <div className="flex justify-between"><span className="hos-subtitle" style={{ fontSize: 14 }}>② 支出合計</span><span className="font-number font-extrabold">{yen(totals.shishutsuGokei)}</span></div>
          <hr className="ws-sep" />
          <div className="flex justify-between items-center">
            <span className="hos-subtitle" style={{ fontSize: 15 }}>残金（①－②）生徒会へ納入</span>
            <span className="font-number font-extrabold" style={{ fontSize: 20, color: "var(--ws-sc)" }}>{yen(totals.zankin)}</span>
          </div>
          <p className="hos-caption">※借入金（{yen(LOAN_AMOUNT)}）と残金は分けて生徒会へ提出します。実際の仕入れ額は、この計算には使いません（仕入帳を別途提出）。</p>
        </div>
      </div>

      {/* Loan */}
      <div className="ws-section-label">貸付金（{yen(LOAN_AMOUNT)}）の返済状況</div>
      <div className="ws-card p-5 mb-2">
        <div className="flex items-center gap-3 mb-3">
          <div className="ws-icon-chip" style={{ background: "var(--ws-secc)", color: "var(--ws-onsecc)" }}>
            <Landmark size={19} />
          </div>
          <div className="flex-1">
            <div className="hos-caption">返済状況</div>
            <div className="font-number font-extrabold" style={{ fontSize: 17 }}>
              {yen(totals.loanRepaid)} <span className="hos-caption">/ {yen(LOAN_AMOUNT)}</span>
            </div>
          </div>
          <span className="ws-badge" style={{ background: totals.loanRemaining <= 0 ? "var(--ws-scg)" : "var(--ws-wns)", color: totals.loanRemaining <= 0 ? "var(--ws-sc)" : "var(--ws-warn)" }}>
            {totals.loanRemaining <= 0 ? "返済完了" : `残り${yen(totals.loanRemaining)}`}
          </span>
        </div>
        <SimpleForm placeholder="例：生徒会へ返済" onSubmit={(l, a, n) => handleAdd("loan_repay", l, a, n)} />
        {loanRepayments.length > 0 && (
          <div className="flex flex-col gap-1.5 mt-2">
            {loanRepayments.map((e: any) => <SimpleRow key={e.id} e={e} />)}
          </div>
        )}
      </div>

      {/* Purchases (仕入帳 detail) */}
      <div className="ws-section-label">仕入帳（実際の仕入れ明細）</div>
      <div className="flex flex-col gap-2 mb-2">
        <PurchaseForm onSubmit={handleAddPurchase} />
        {purchases.map((e: any) => <PurchaseRow key={e.id} e={e} />)}
        {purchases.length === 0 && <div className="hos-caption text-center py-2">まだ記録がありません</div>}
      </div>

      {/* Deductions */}
      <div className="ws-section-label">控除費目（保菌検査代・生徒からの集金・両替手数料など）</div>
      <div className="flex flex-col gap-2 mb-2">
        <SimpleForm placeholder="例：保菌検査代" onSubmit={(l, a, n) => handleAdd("deduction", l, a, n)} />
        {deductions.map((e: any) => <SimpleRow key={e.id} e={e} />)}
        {deductions.length === 0 && <div className="hos-caption text-center py-2">まだ記録がありません</div>}
      </div>

      {/* ===== Print-only report — matches the 3-sheet school format ===== */}
      <div className="print-report">
        {/* Sheet 1: 仕入帳 */}
        <div style={{ pageBreakAfter: "always" }}>
          <h1 style={{ fontSize: 18, fontWeight: 800 }}>仕入帳（文化祭物販団体）</h1>
          <p style={{ fontSize: 12, marginBottom: 12 }}>団体名：{groupName || "＿＿＿＿＿＿＿＿＿＿"}</p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, border: "1px solid #333" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333" }}>
                <th style={cellHead}>月日</th>
                <th style={cellHead}>レシートNO</th>
                <th style={cellHead}>摘要（商品名）</th>
                <th style={cellHead}>数量</th>
                <th style={cellHead}>単価</th>
                <th style={cellHead}>金額</th>
              </tr>
            </thead>
            <tbody>
              {purchases.length === 0 && <tr><td colSpan={6} style={{ ...cellBody, textAlign: "center", color: "#777" }}>記録なし</td></tr>}
              {purchases.map((e: any) => (
                <tr key={e.id}>
                  <td style={cellBody}>{dateStr(e.createdAt)}</td>
                  <td style={cellBody}>{e.receiptNo || ""}</td>
                  <td style={cellBody}>{e.label}</td>
                  <td style={{ ...cellBody, textAlign: "right" }}>{e.quantity || ""}</td>
                  <td style={{ ...cellBody, textAlign: "right" }}>{e.unitPrice ? yen(e.unitPrice) : ""}</td>
                  <td style={{ ...cellBody, textAlign: "right" }}>{yen(e.amount)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={5} style={{ ...cellBody, textAlign: "right", fontWeight: 700 }}>支払金額計</td>
                <td style={{ ...cellBody, textAlign: "right", fontWeight: 700 }}>{yen(totals.purchaseTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Sheet 2: 売上帳 */}
        <div style={{ pageBreakAfter: "always" }}>
          <h1 style={{ fontSize: 18, fontWeight: 800 }}>売上帳（文化祭物販団体）</h1>
          <p style={{ fontSize: 12, marginBottom: 12 }}>団体名：{groupName || "＿＿＿＿＿＿＿＿＿＿"}</p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, border: "1px solid #333" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333" }}>
                <th style={cellHead}>月日</th>
                <th style={cellHead}>レシートNO</th>
                <th style={cellHead}>摘要（商品名）</th>
                <th style={cellHead}>数量</th>
                <th style={cellHead}>単価</th>
                <th style={cellHead}>金額</th>
                <th style={cellHead}>支払金額計</th>
              </tr>
            </thead>
            <tbody>
              {salesLedgerRows.length === 0 && <tr><td colSpan={7} style={{ ...cellBody, textAlign: "center", color: "#777" }}>記録なし</td></tr>}
              {salesLedgerRows.map((r, i) => (
                <tr key={i}>
                  <td style={cellBody}>{r.date}</td>
                  <td style={cellBody}>{r.receiptNo}</td>
                  <td style={cellBody}>{r.name}</td>
                  <td style={{ ...cellBody, textAlign: "right" }}>{r.qty}</td>
                  <td style={{ ...cellBody, textAlign: "right" }}>{yen(r.price)}</td>
                  <td style={{ ...cellBody, textAlign: "right" }}>{yen(r.amount)}</td>
                  <td style={{ ...cellBody, textAlign: "right" }}>{r.isLast ? yen(r.txTotal) : ""}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={6} style={{ ...cellBody, textAlign: "right", fontWeight: 700 }}>支払金額計 合計</td>
                <td style={{ ...cellBody, textAlign: "right", fontWeight: 700 }}>{yen(totals.totalSales)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Sheet 3: 文化祭物品販売報告書 */}
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 800, textAlign: "center", marginBottom: 20 }}>文化祭物品販売報告書</h1>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, border: "1px solid #333" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333" }}>
                <th style={{ ...cellHead, textAlign: "left" }}>摘要</th>
                <th style={cellHead}>金額</th>
              </tr>
            </thead>
            <tbody>
              <tr><td style={cellBody}>1　売上高</td><td style={{ ...cellBody, textAlign: "right" }}>{yen(totals.totalSales)}</td></tr>
              <tr><td style={{ ...cellBody, textAlign: "right", fontWeight: 700 }}>収益合計①</td><td style={{ ...cellBody, textAlign: "right", fontWeight: 700 }}>{yen(totals.totalSales)}</td></tr>
              <tr><td style={cellBody}>2　仕入代金借入高</td><td style={{ ...cellBody, textAlign: "right" }}>{yen(LOAN_AMOUNT)}</td></tr>
              {deductions.map((e: any) => (
                <tr key={e.id}><td style={cellBody}>{e.label}</td><td style={{ ...cellBody, textAlign: "right" }}>{yen(e.amount)}</td></tr>
              ))}
              <tr><td style={{ ...cellBody, textAlign: "right", fontWeight: 700 }}>支出合計②</td><td style={{ ...cellBody, textAlign: "right", fontWeight: 700 }}>{yen(totals.shishutsuGokei)}</td></tr>
              <tr style={{ borderTop: "2px solid #333" }}><td style={{ ...cellBody, fontWeight: 800, fontSize: 15 }}>残金（①－②）</td><td style={{ ...cellBody, textAlign: "right", fontWeight: 800, fontSize: 15 }}>{yen(totals.zankin)}</td></tr>
            </tbody>
          </table>

          <p style={{ fontSize: 13, marginTop: 24 }}>残金　¥{totals.zankin.toLocaleString("ja-JP")}　を生徒会へ納入します。</p>
          <p style={{ fontSize: 13 }}>以上、{eventName}収支報告（物品販売団体）をいたします。</p>
          <p style={{ fontSize: 13, marginTop: 16 }}>{reiwaMonth()}　　日</p>
          <p style={{ fontSize: 13, marginTop: 12 }}>団体名（　{groupName}　）</p>
          <p style={{ fontSize: 13, marginTop: 12 }}>代表者生徒氏名：{repName}</p>
          <p style={{ fontSize: 13, marginTop: 12 }}>担当教員氏名：　　　　　　　　　　　　　　印</p>
          <p style={{ fontSize: 11, marginTop: 20, color: "#555" }}>※借入金（{yen(LOAN_AMOUNT)}）と残金を分けて提出してください。</p>
        </div>
      </div>
    </div>
  );
}

const cellHead: React.CSSProperties = { padding: "5px 6px", textAlign: "center", borderRight: "1px solid #999" };
const cellBody: React.CSSProperties = { padding: "4px 6px", borderRight: "1px solid #ccc", borderBottom: "1px solid #eee" };
