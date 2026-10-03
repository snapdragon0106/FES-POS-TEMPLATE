import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { LOG_STYLE, type LogAction } from "@shared/posTypes";

interface Props {
  logs: any[];
}

export default function ActivityLogTab({ logs }: Props) {
  const groups = useMemo(() => {
    const todayKey = new Date().toDateString();
    const map = new Map<string, { label: string; items: any[] }>();
    logs.forEach((l: any) => {
      const d = new Date(l.createdAt);
      const dayKey = d.toDateString();
      const label = dayKey === todayKey
        ? "本日"
        : d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", weekday: "short" });
      if (!map.has(dayKey)) map.set(dayKey, { label, items: [] });
      map.get(dayKey)!.items.push(l);
    });
    return Array.from(map.values());
  }, [logs]);

  return (
    <div className="ws-fade">
      <h2 className="hos-title mb-5">操作ログ</h2>
      {logs.length === 0 ? (
        <div className="ws-card p-8 text-center hos-body">
          操作ログがありません
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.label}>
            <div className="ws-section-label">{group.label}</div>
            <div className="flex flex-col gap-1.5">
              {group.items.map((l: any, i: number) => {
                const ls = LOG_STYLE[l.action as LogAction] || { label: l.action, color: "var(--ws-ts)", warn: false };
                return (
                  <div
                    key={l.id}
                    className={`ws-card ws-fade ws-stagger-${Math.min(i + 1, 8)} p-3.5`}
                    style={{
                      borderColor: ls.warn ? "var(--ws-dg)" : undefined,
                      background: ls.warn ? "var(--ws-dgs)" : undefined,
                    }}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="ws-dot" style={{ background: ls.color }} />
                      {ls.warn && <AlertTriangle size={13} style={{ color: "var(--ws-dg)" }} />}
                      <span className="font-number hos-caption font-bold" style={{ color: "var(--ws-ts)" }}>
                        {new Date(l.createdAt).toLocaleString("ja-JP", {
                          hour: "2-digit", minute: "2-digit", second: "2-digit",
                        })}
                      </span>
                      <span className="font-number text-xs font-extrabold" style={{ color: "var(--ws-tx)" }}>
                        {l.operator}
                      </span>
                      {l.operatorName && l.operatorName !== l.operator && (
                        <span className="hos-caption">({l.operatorName})</span>
                      )}
                      <span
                        className="ws-badge ml-auto"
                        style={{ background: ls.color + "22", color: ls.color }}
                      >
                        {ls.label}
                      </span>
                    </div>
                    {l.detail && (
                      <div className="hos-body text-xs mt-1.5">{l.detail}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
