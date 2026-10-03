import { useEffect, useState } from "react";
import { WifiOff, RefreshCw } from "lucide-react";

/**
 * The one signal every cashier needs during an outage: "the numbers on
 * this screen are no longer live". Without it, a register whose polling
 * has been failing for minutes looks exactly like a healthy one — stock
 * counts simply stop moving — and the first sign of trouble is a failed
 * checkout with a customer waiting.
 *
 * Two different causes, told apart because the fix differs: the phone
 * itself is offline (check its Wi-Fi/data) vs. the phone is online but
 * the server isn't answering (server or database trouble — see the
 * incident runbook). Either way the instruction is the same: if you
 * can't check out, write it on paper.
 */

function useDeviceOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

interface Props {
  /** The last poll failed (after its retry) — the server did not answer. */
  serverUnreachable: boolean;
  /** When the on-screen data was last successfully refreshed (ms epoch, 0 = never). */
  lastSyncedAt: number;
  onRetry: () => void;
  retrying: boolean;
}

export default function ConnectionBanner({ serverUnreachable, lastSyncedAt, onRetry, retrying }: Props) {
  const deviceOnline = useDeviceOnline();
  if (deviceOnline && !serverUnreachable) return null;

  const title = deviceOnline
    ? "サーバーに接続できません"
    : "この端末がインターネットにつながっていません";
  const since = lastSyncedAt
    ? new Date(lastSyncedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  return (
    <div
      role="alert"
      className="sticky top-2 z-30 mb-4 flex items-start gap-2.5"
      style={{
        background: "var(--ws-dgs)",
        border: "1.5px solid var(--ws-dg)",
        borderRadius: 14,
        padding: "12px 14px",
      }}
    >
      <WifiOff size={18} style={{ color: "var(--ws-dg)", flexShrink: 0, marginTop: 2 }} />
      <div className="flex-1 min-w-0">
        <div className="font-bold text-[14px]" style={{ color: "var(--ws-dg)" }}>
          {title}
        </div>
        <div className="text-[12px] leading-relaxed mt-0.5" style={{ color: "var(--ws-tx)" }}>
          最終同期 {since}。在庫・売上の表示は古い可能性があります。
          <b>会計できないときは紙に記録してください。</b>
        </div>
      </div>
      <button
        onClick={onRetry}
        disabled={retrying}
        className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] font-bold"
        style={{
          background: "var(--ws-dg)",
          color: "#fff",
          border: "none",
          flexShrink: 0,
          cursor: retrying ? "not-allowed" : "pointer",
          opacity: retrying ? 0.6 : 1,
        }}
      >
        <RefreshCw size={13} className={retrying ? "animate-spin" : ""} />
        再接続
      </button>
    </div>
  );
}
