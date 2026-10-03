import { useEffect, useRef, useState } from "react";
import { PackageCheck, Undo2, Volume2, VolumeX, CheckCheck, BellRing } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errorMessage";
import { orderLabel } from "@shared/posTypes";
import type { HandoverQueue } from "../../../../server/handover";

type Order = HandoverQueue["pending"][number];

const SOUND_KEY = "pos_handover_sound";
// Waiting longer than this is shown in the warning colour.
const LATE_MS = 5 * 60_000;

const itemsText = (o: Order) => o.items.map((it) => `${it.emoji}${it.name}×${it.qty}`).join("、");
const hhmm = (d: Date | string) =>
  new Date(d).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" });
function waited(from: Date | string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  return s < 60 ? "たった今" : `${Math.floor(s / 60)}分前`;
}

/**
 * Two short beeps, made on the spot (no sound file). A browser only lets a
 * page play sound after the person has touched it, so the context is made
 * when 音を鳴らす is switched on, and resumed on the next touch after a reload.
 */
function useBeep(enabled: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  const ensure = () => {
    if (!ctxRef.current) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return null;
      ctxRef.current = new AC();
    }
    if (ctxRef.current.state === "suspended") void ctxRef.current.resume();
    return ctxRef.current;
  };
  useEffect(() => {
    if (!enabled) return;
    const unlock = () => ensure();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, [enabled]);
  const beep = () => {
    const ctx = ensure();
    if (!ctx) return;
    [0, 0.22].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.18);
    });
  };
  return { beep, ensure };
}

interface Props {
  queue: HandoverQueue | undefined;
  loading: boolean;
}

/**
 * The handover counter (受け渡し): every sale, with its number and goods,
 * appears here within a couple of seconds of 会計完了 at any register
 * (server/handover.ts). The person at the counter hands the goods to the
 * customer who says that number and taps 渡した.
 */
export default function HandoverTab({ queue, loading }: Props) {
  const utils = trpc.useUtils();
  const complete = trpc.handover.complete.useMutation();
  const undo = trpc.handover.undo.useMutation();
  const completeAll = trpc.handover.completeAll.useMutation();

  const pending = queue?.pending ?? [];
  const recent = queue?.recent ?? [];

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const [sound, setSound] = useState(() => {
    try { return localStorage.getItem(SOUND_KEY) === "1"; } catch { return false; }
  });
  const { beep, ensure } = useBeep(sound);
  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    try { localStorage.setItem(SOUND_KEY, next ? "1" : "0"); } catch { /* private mode */ }
    if (next) { ensure(); beep(); }
  };

  // The counter phone stays on this screen for hours: keep it from
  // going to sleep while it's open (where the browser allows it).
  useEffect(() => {
    let lock: any = null;
    const request = async () => {
      try { lock = await (navigator as any).wakeLock?.request("screen"); } catch { /* not allowed / not supported */ }
    };
    const onVisible = () => { if (document.visibilityState === "visible") void request(); };
    void request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      try { lock?.release?.(); } catch { /* already released */ }
    };
  }, []);

  // A new order: a toast, a buzz, a beep (if switched on) and a highlight.
  // Orders already there when the screen opened are not announced.
  const seenRef = useRef<Set<number> | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    if (!queue) return;
    const ids = queue.pending.map((o) => o.id);
    if (!seenRef.current) {
      seenRef.current = new Set(ids);
      return;
    }
    const added = queue.pending.filter((o) => !seenRef.current!.has(o.id));
    ids.forEach((id) => seenRef.current!.add(id));
    if (added.length === 0) return;
    for (const o of added) {
      toast(`新しい注文 ${orderLabel(o.orderNo) || `#${o.id}`}`, { description: itemsText(o), duration: 5000 });
    }
    try { navigator.vibrate?.([150, 80, 150]); } catch { /* not supported */ }
    if (sound) beep();
    setFresh((prev) => new Set([...Array.from(prev), ...added.map((o) => o.id)]));
    // Not cleared when the queue changes again (another order a second
    // later): each highlight goes after its own 4 seconds.
    timersRef.current.push(setTimeout(() => {
      setFresh((prev) => {
        const next = new Set(prev);
        added.forEach((o) => next.delete(o.id));
        return next;
      });
    }, 4000));
  }, [queue]);
  useEffect(() => () => timersRef.current.forEach(clearTimeout), []);

  const refresh = () => utils.handover.queue.invalidate();

  const handleComplete = async (o: Order) => {
    try {
      const r = await complete.mutateAsync({ id: o.id });
      if (r.already) toast.info(`${orderLabel(o.orderNo) || `#${o.id}`} はほかの人が「渡した」にしていました`);
    } catch (e) {
      toast.error(getErrorMessage(e, "記録できませんでした"));
    }
    refresh();
  };

  const handleUndo = async (o: Order) => {
    try {
      await undo.mutateAsync({ id: o.id });
      toast.success(`${orderLabel(o.orderNo) || `#${o.id}`} を受け渡し待ちに戻しました`);
    } catch (e) {
      toast.error(getErrorMessage(e, "戻せませんでした"));
    }
    refresh();
  };

  const handleCompleteAll = async () => {
    if (!confirm(`受け渡し待ちの ${pending.length} 件を、すべて「渡した」にしますか？\n（紙で営業した分をあとから入力したときなど）`)) return;
    try {
      const r = await completeAll.mutateAsync();
      toast.success(`${r.count}件を「渡した」にしました`);
    } catch (e) {
      toast.error(getErrorMessage(e, "記録できませんでした"));
    }
    refresh();
  };

  return (
    <div className="ws-fade">
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="hos-title">受け渡し</h2>
          <span className="ws-badge" style={{ background: pending.length ? "var(--ws-ach)" : "var(--ws-s3)", color: pending.length ? "var(--ws-ac)" : "var(--ws-td)" }}>
            待ち {pending.length}件
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleSound}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
            style={{ background: sound ? "var(--ws-ach)" : "var(--ws-s2)", color: sound ? "var(--ws-ac)" : "var(--ws-ts)", border: "1px solid var(--ws-bd)", borderRadius: 999, cursor: "pointer" }}
          >
            {sound ? <Volume2 size={14} /> : <VolumeX size={14} />}
            {sound ? "音あり" : "音なし"}
          </button>
          {pending.length > 1 && (
            <button
              onClick={handleCompleteAll}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
              style={{ background: "var(--ws-s2)", color: "var(--ws-ts)", border: "1px solid var(--ws-bd)", borderRadius: 999, cursor: "pointer" }}
            >
              <CheckCheck size={14} />
              すべて渡した
            </button>
          )}
        </div>
      </div>

      <p className="hos-caption mb-3 flex items-center gap-1.5">
        <BellRing size={13} />
        どのレジで会計しても、数秒でここに出ます。お客さんに番号を聞いて商品を渡し、「渡した」を押してください。
      </p>

      {pending.length === 0 ? (
        <div className="ws-card p-8 text-center hos-body">
          {loading ? "読み込み中…" : "受け渡し待ちの注文はありません"}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {pending.map((o) => {
            const late = now - new Date(o.createdAt).getTime() > LATE_MS;
            const isFresh = fresh.has(o.id);
            return (
              <div
                key={o.id}
                className="ws-card p-4 flex flex-col gap-3"
                style={{
                  border: isFresh ? "2px solid var(--ws-ac)" : late ? "2px solid var(--ws-warn)" : undefined,
                  boxShadow: isFresh ? "0 0 0 4px var(--ws-ach)" : undefined,
                  transition: "box-shadow 0.4s, border-color 0.4s",
                }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-number font-extrabold" style={{ fontSize: 34, lineHeight: 1, color: "var(--ws-tx)" }}>
                    {o.orderNo ?? `#${o.id}`}
                    {o.orderNo && <span style={{ fontSize: 16, marginLeft: 2 }}>番</span>}
                  </span>
                  <span className="text-[12px] font-bold" style={{ color: late ? "var(--ws-warn)" : "var(--ws-ts)" }}>
                    {hhmm(o.createdAt)}（{waited(o.createdAt, now)}）
                  </span>
                </div>
                <ul className="flex flex-col gap-1.5">
                  {o.items.map((it, i) => (
                    <li key={i} className="flex items-center justify-between gap-2" style={{ color: "var(--ws-tx)" }}>
                      <span className="flex items-center gap-2 min-w-0">
                        <span style={{ fontSize: 22 }}>{it.emoji}</span>
                        <span className="text-[16px] font-bold truncate">{it.name}</span>
                      </span>
                      <span className="font-number font-extrabold text-[20px] flex-shrink-0">×{it.qty}</span>
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => handleComplete(o)}
                  disabled={complete.isPending}
                  className="flex items-center justify-center gap-2 py-3 text-[15px] font-bold"
                  style={{ background: "var(--ws-ac)", color: "#fff", border: "none", borderRadius: 999, cursor: "pointer" }}
                >
                  <PackageCheck size={18} />
                  渡した
                </button>
              </div>
            );
          })}
        </div>
      )}

      {recent.length > 0 && (
        <div className="mt-6">
          <div className="ws-section-label">さっき渡した注文（間違えて押したら「戻す」）</div>
          <div className="flex flex-col gap-1.5">
            {recent.map((o) => (
              <div key={o.id} className="ws-card px-3 py-2 flex items-center gap-3">
                <span className="font-number font-extrabold text-[16px]" style={{ color: "var(--ws-ts)", minWidth: 48 }}>
                  {orderLabel(o.orderNo) || `#${o.id}`}
                </span>
                <span className="text-[12px] truncate flex-1" style={{ color: "var(--ws-ts)" }}>
                  {itemsText(o)}
                </span>
                <span className="text-[11px] flex-shrink-0" style={{ color: "var(--ws-td)" }}>
                  {o.handedAt ? hhmm(o.handedAt) : ""}
                </span>
                <button
                  onClick={() => handleUndo(o)}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold flex-shrink-0"
                  style={{ background: "var(--ws-s2)", color: "var(--ws-ts)", border: "1px solid var(--ws-bd)", borderRadius: 999, cursor: "pointer" }}
                >
                  <Undo2 size={12} /> 戻す
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
