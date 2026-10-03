import { useState } from "react";
import { Trash2, RefreshCw, Check, X, Wallet, AlertTriangle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useMembers } from "@/lib/members";
import { getErrorMessage } from "@/lib/errorMessage";

interface Props {
  operator: string;
}

export default function PinManagerTab({ operator }: Props) {
  // Polled so a classmate's first-login request shows up while the admin
  // has this tab open.
  const pinsQuery = trpc.pin.list.useQuery(undefined, { refetchInterval: 8000 });
  const approvePin = trpc.pin.approve.useMutation();
  const resetPin = trpc.pin.reset.useMutation();
  const deletePin = trpc.pin.delete.useMutation();
  const alerts = trpc.pin.alerts.useQuery(undefined, { refetchInterval: 30000 }).data;
  // 会計係: may register the float, close the day and give the float back.
  const cashQuery = trpc.cash.list.useQuery();
  const setManagers = trpc.cash.setManagers.useMutation();
  const managers = new Set(cashQuery.data?.managers ?? []);
  const utils = trpc.useUtils();
  const [codes, setCodes] = useState<Record<string, string>>({});

  const [resetId, setResetId] = useState<string | null>(null);
  const [newPin, setNewPin] = useState("");

  const pins = pinsQuery.data || [];
  const pinOf = new Map(pins.map((p) => [p.memberId, p]));
  const { members: roster } = useMembers();
  const members = roster.map((m) => ({
    id: m.id,
    name: m.name,
    hasPin: pinOf.get(m.id)?.approved === true,
    pending: pinOf.get(m.id)?.approved === false,
    hasRequestCode: pinOf.get(m.id)?.hasRequestCode === true,
    requestedAt: pinOf.get(m.id)?.updatedAt,
  }));
  const pendings = members.filter((m) => m.pending);

  const handleApprove = async (memberId: string) => {
    const code = (codes[memberId] ?? "").trim().toUpperCase();
    if (code.length !== 4) {
      toast.error("本人の画面に出ている申請コード（4文字）を入力してください");
      return;
    }
    try {
      await approvePin.mutateAsync({ memberId, code });
      toast.success("承認しました");
      setCodes((c) => ({ ...c, [memberId]: "" }));
      utils.pin.list.invalidate();
    } catch (e) {
      toast.error(getErrorMessage(e, "承認に失敗しました"));
    }
  };

  const handleReject = async (memberId: string) => {
    if (!confirm(`メンバー${memberId}のPIN登録申請を却下しますか？\n本人はもう一度PINを設定し直せます。`)) return;
    try {
      await deletePin.mutateAsync({ memberId });
      toast.success("却下しました");
      utils.pin.list.invalidate();
    } catch (e) {
      toast.error(getErrorMessage(e, "却下に失敗しました"));
    }
  };

  const toggleManager = async (memberId: string, name: string) => {
    const next = new Set(managers);
    if (next.has(memberId)) next.delete(memberId);
    else {
      if (!confirm(`${memberId} ${name} さんを会計係にしますか？\n釣り銭の登録・締め・釣り銭の返却ができるようになります。`)) return;
      next.add(memberId);
    }
    try {
      await setManagers.mutateAsync({ memberIds: Array.from(next) });
      utils.cash.list.invalidate();
      toast.success(next.has(memberId) ? "会計係にしました" : "会計係から外しました");
    } catch (e) {
      toast.error(getErrorMessage(e, "変更できませんでした"));
    }
  };

  const handleReset = async (memberId: string) => {
    if (newPin.length !== 4) {
      toast.error("4桁のPINを入力してください");
      return;
    }
    try {
      await resetPin.mutateAsync({ memberId, pin: newPin });
      toast.success("PINをリセットしました");
      setResetId(null);
      setNewPin("");
      utils.pin.list.invalidate();
    } catch (e) {
      toast.error(getErrorMessage(e, "リセットに失敗しました"));
    }
  };

  const handleDelete = async (memberId: string) => {
    if (!confirm(`メンバー${memberId}のPINを削除しますか？`)) return;
    try {
      await deletePin.mutateAsync({ memberId });
      toast.success("PINを削除しました");
      utils.pin.list.invalidate();
    } catch (e) {
      toast.error(getErrorMessage(e, "削除に失敗しました"));
    }
  };

  return (
    <div className="ws-fade">
      <h2 className="hos-title mb-5">PIN管理</h2>

      {alerts && alerts.failures > 0 && (
        <div className="ws-card p-3 mb-4 flex items-start gap-2 text-[13px]" style={{ border: "1.5px solid var(--ws-dg)", color: "var(--ws-tx)" }}>
          <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" style={{ color: "var(--ws-dg)" }} />
          <div>
            直近1時間に、PINの入力ミスが {alerts.failures} 回（{alerts.numbers} 人分）ありました
            {alerts.adminFailures > 0 && <>。うち管理者の番号へのミスが {alerts.adminFailures} 回</>}。
            本人の打ち間違いでなければ、誰かがPINを試しています。操作タブで端末と時刻を確認し、
            心当たりのない番号はPINをリセットしてください。
          </div>
        </div>
      )}

      {pendings.length > 0 && (
        <div className="ws-card p-3 mb-4" style={{ border: "1.5px solid var(--ws-warn)" }}>
          <div className="text-sm font-bold mb-1" style={{ color: "var(--ws-tx)" }}>
            承認待ち（{pendings.length}件）
          </div>
          <p className="text-[11px] mb-2.5" style={{ color: "var(--ws-ts)" }}>
            初回ログインで設定されたPINです。承認するまで入室できません。
            本人に会って、本人の画面に出ている<b>申請コード</b>を入力して承認してください。
            他の人が同じ番号で申請していた場合はコードが合わないので、承認できません。覚えのない申請は却下してください。
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {pendings.map((m) => (
              // Two rows: who and when on top, the code and buttons below.
              // On one row the phone had no room left for the name: only
              // the number chip showed, and the buttons wrapped into circles.
              <div key={m.id} className="flex flex-col gap-2 p-2.5" style={{ background: "var(--ws-s2)" }}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="ws-icon-chip-sm font-number font-extrabold flex-shrink-0" style={{ background: "var(--ws-s3)", color: "var(--ws-tx)", fontSize: 12 }}>
                    {m.id.slice(-2)}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-bold truncate" style={{ color: "var(--ws-tx)" }}>
                      {m.id} {m.name}
                    </div>
                    {m.requestedAt && (
                      <div className="text-[11px]" style={{ color: "var(--ws-td)" }}>
                        {new Date(m.requestedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" })} に申請
                      </div>
                    )}
                  </div>
                </div>
                {m.hasRequestCode ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={codes[m.id] ?? ""}
                      onChange={(e) => setCodes((c) => ({ ...c, [m.id]: e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4) }))}
                      placeholder="申請コード（4文字）"
                      aria-label="申請コード"
                      autoCapitalize="characters"
                      autoComplete="off"
                      className="ws-input font-number text-center text-sm flex-1 min-w-0"
                      style={{ padding: "6px 8px", letterSpacing: 2 }}
                    />
                    <button
                      onClick={() => handleApprove(m.id)}
                      className="flex items-center gap-1 px-3 py-2 text-[12px] font-bold whitespace-nowrap flex-shrink-0"
                      style={{ background: "var(--ws-ac)", color: "#fff", border: "none", borderRadius: 999, cursor: "pointer" }}
                    >
                      <Check size={13} /> 承認
                    </button>
                    <button
                      onClick={() => handleReject(m.id)}
                      className="flex items-center gap-1 px-3 py-2 text-[12px] font-bold whitespace-nowrap flex-shrink-0"
                      style={{ background: "var(--ws-dgs)", color: "var(--ws-dg)", border: "none", borderRadius: 999, cursor: "pointer" }}
                    >
                      <X size={13} /> 却下
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <p className="text-[11px] flex-1 min-w-0" style={{ color: "var(--ws-ts)" }}>
                      申請コードができる前の申請なので、承認できません。却下して、本人にもう一度PINを設定してもらってください（新しい申請コードが出ます）。
                    </p>
                    <button
                      onClick={() => handleReject(m.id)}
                      className="flex items-center gap-1 px-3 py-2 text-[12px] font-bold whitespace-nowrap flex-shrink-0"
                      style={{ background: "var(--ws-dgs)", color: "var(--ws-dg)", border: "none", borderRadius: 999, cursor: "pointer" }}
                    >
                      <X size={13} /> 却下
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="ws-card p-3 mb-4">
        <div className="flex items-center gap-1.5 text-sm font-bold mb-1" style={{ color: "var(--ws-tx)" }}>
          <Wallet size={14} /> 会計係
        </div>
        <p className="text-[11px] mb-2.5" style={{ color: "var(--ws-ts)" }}>
          管理者のほかに、釣り銭の登録・締め・釣り銭の返却ができる人です。本部への回収と両替は誰でもできます。
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {members.filter((m) => managers.has(m.id)).map((m) => (
            <button
              key={m.id}
              onClick={() => toggleManager(m.id, m.name)}
              className="ws-badge text-[11px]"
              title="会計係から外す"
              style={{ background: "var(--ws-ach)", color: "var(--ws-ac)", border: "none", cursor: "pointer" }}
            >
              {m.id.slice(-2)} {m.name} <X size={11} />
            </button>
          ))}
          <select
            value=""
            onChange={(e) => {
              const m = members.find((x) => x.id === e.target.value);
              if (m) toggleManager(m.id, m.name);
            }}
            aria-label="会計係を追加"
            className="ws-input text-[12px]"
            style={{ padding: "4px 8px", width: "auto" }}
          >
            <option value="">＋ 追加</option>
            {members.filter((m) => !managers.has(m.id) && m.id !== operator).map((m) => (
              <option key={m.id} value={m.id}>{m.id} {m.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {members.map((m, i) => (
          <div key={m.id} className={`ws-card ws-fade ws-stagger-${Math.min(i % 8 + 1, 8)} p-3 flex items-center gap-2.5`}>
            <div className="ws-icon-chip-sm font-number font-extrabold" style={{ background: "var(--ws-s2)", color: "var(--ws-tx)", fontSize: 12 }}>
              {m.id.slice(-2)}
            </div>
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-sm truncate" style={{ color: "var(--ws-tx)" }}>
                {m.name}
              </span>
              <span
                className="ws-badge text-[10px]"
                style={{
                  background: m.hasPin ? "var(--ws-scg)" : "var(--ws-s3)",
                  color: m.hasPin ? "var(--ws-sc)" : m.pending ? "var(--ws-warn)" : "var(--ws-td)",
                }}
              >
                <span className="ws-dot" style={{ width: 5, height: 5, background: m.hasPin ? "var(--ws-sc)" : m.pending ? "var(--ws-warn)" : "var(--ws-td)" }} />
                {m.hasPin ? "設定済" : m.pending ? "承認待ち" : "未設定"}
              </span>
            </div>

            {resetId === m.id ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  placeholder="新PIN"
                  className="ws-input font-number w-20 text-center text-sm"
                  style={{ padding: "4px 8px" }}
                  autoFocus
                />
                <button
                  onClick={() => handleReset(m.id)}
                  className="p-1.5 text-[11px] font-bold"
                  style={{ background: "var(--ws-ac)", color: "#fff", border: "none", cursor: "pointer" }}
                >
                  確定
                </button>
                <button
                  onClick={() => { setResetId(null); setNewPin(""); }}
                  className="p-1.5 text-[11px]"
                  style={{ background: "var(--ws-s2)", border: "1px solid var(--ws-bd)", color: "var(--ws-ts)", cursor: "pointer" }}
                >
                  取消
                </button>
              </div>
            ) : (
              m.hasPin && (
                <div className="flex gap-1">
                  <button
                    onClick={() => { setResetId(m.id); setNewPin(""); }}
                    className="ws-icon-chip-sm"
                    style={{ width: 28, height: 28, background: "var(--ws-s2)", color: "var(--ws-ts)", border: "none", cursor: "pointer" }}
                    title="PINリセット"
                  >
                    <RefreshCw size={12} />
                  </button>
                  <button
                    onClick={() => handleDelete(m.id)}
                    className="ws-icon-chip-sm"
                    style={{ width: 28, height: 28, background: "var(--ws-dgs)", color: "var(--ws-dg)", border: "none", cursor: "pointer" }}
                    title="PIN削除"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
