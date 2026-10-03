import {
  ShoppingCart, LayoutDashboard, Package, Settings2, History,
  LogOut, RefreshCw, ShieldCheck, User, Store, ScrollText, KeyRound,
  Sun, Moon, Calculator, PackageCheck,
} from "lucide-react";
import { NAV_ITEMS, type NavKey } from "@shared/posTypes";
import { useTheme } from "../../contexts/ThemeContext";

const ICONS: Record<string, any> = {
  pos: ShoppingCart,
  handover: PackageCheck,
  dashboard: LayoutDashboard,
  inventory: Package,
  products: Settings2,
  history: History,
  accounting: Calculator,
  actlog: ScrollText,
  pinmgr: KeyRound,
};

interface Props {
  tab: NavKey;
  setTab: (t: NavKey) => void;
  isAdmin: boolean;
  operator: string;
  operatorName: string;
  onSync: () => void;
  syncing: boolean;
  onLogout: () => void;
  /** Counts shown on a tab (受け渡し待ち). */
  badges?: Partial<Record<NavKey, number>>;
}

export default function Sidebar({ tab, setTab, isAdmin, operator, operatorName, onSync, syncing, onLogout, badges }: Props) {
  const visible = NAV_ITEMS.filter((n) => !n.admin || isAdmin);
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    // Floating glass panel: inset from every edge and rounded all around,
    // rather than a flush edge-to-edge rectangle — Liquid Glass controls
    // are a distinct layer that "floats above" the content, not fused to
    // the screen edge.
    <aside
      className="ws-tile-panel hidden md:flex flex-col fixed z-20"
      style={{
        top: 14,
        left: 14,
        bottom: 14,
        width: 232,
        borderRadius: 28,
        padding: "20px 12px",
      }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2.5 mb-6 px-1.5">
        <div
          className="ws-icon-chip"
          style={{ background: "radial-gradient(circle at 32% 28%, var(--ws-secc) 0%, var(--ws-secc-deep) 100%)", color: "var(--ws-onsecc)", width: 40, height: 40 }}
        >
          <Store size={19} />
        </div>
        <div>
          <div className="text-sm font-bold" style={{ color: "var(--ws-tx)", fontFamily: "var(--font-heading)" }}>
            FES POS
          </div>
          <div className="text-[11px]" style={{ color: "var(--ws-ts)" }}>
            物販管理
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-1 flex-1">
        {visible.map((n) => {
          const Icon = ICONS[n.key];
          const active = tab === n.key;
          const badge = badges?.[n.key];
          return (
            <button
              key={n.key}
              onClick={() => setTab(n.key)}
              className="flex items-center gap-3 px-4 py-2.5 text-[14px] font-medium transition-all w-full text-left"
              style={{
                background: active ? "var(--ws-secc)" : "transparent",
                color: active ? "var(--ws-onsecc)" : "var(--ws-ts)",
                border: "none",
                borderRadius: 999,
                cursor: "pointer",
                fontFamily: "var(--font-heading)",
              }}
            >
              <Icon size={18} />
              {n.label}
              {badge ? (
                <span
                  className="font-number"
                  style={{ marginLeft: "auto", minWidth: 20, height: 20, padding: "0 6px", borderRadius: 999, background: "var(--ws-dg)", color: "#fff", fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                >
                  {badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {/* User info + actions */}
      <div className="flex flex-col gap-2 mt-4">
        <div className="rounded-2xl p-3" style={{ background: "var(--ws-s2)", border: "1px solid var(--ws-bd)" }}>
          <div className="text-[11px] mb-0.5" style={{ color: "var(--ws-ts)" }}>
            ログイン中
          </div>
          <div className="flex items-center gap-2">
            <span className="font-number text-lg font-bold" style={{ color: "var(--ws-tx)" }}>{operator}</span>
            <span
              className="ws-badge text-[11px]"
              style={{
                background: isAdmin ? "var(--ws-org)" : "var(--ws-scg)",
                color: isAdmin ? "var(--ws-or)" : "var(--ws-sc)",
              }}
            >
              {isAdmin ? <ShieldCheck size={11} /> : <User size={11} />}
              {isAdmin ? "管理者" : "一般"}
            </span>
          </div>
          {operatorName && (
            <div className="text-[12px] mt-1" style={{ color: "var(--ws-ts)" }}>
              {operatorName}
            </div>
          )}
        </div>

        <button
          onClick={() => toggleTheme?.()}
          className="flex items-center justify-center gap-2 py-2.5 text-xs font-semibold"
          style={{
            color: "var(--ws-onsecc)",
            background: "var(--ws-secc)",
            border: "none",
            cursor: "pointer",
          }}
        >
          {isDark ? <Sun size={14} /> : <Moon size={14} />}
          {isDark ? "ライトモード" : "ダークモード"}
        </button>

        <button
          onClick={onSync}
          className="flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold"
          style={{
            color: "var(--ws-ts)",
            border: "1px solid var(--ws-bd)",
            background: "transparent",
            cursor: "pointer",
          }}
        >
          <RefreshCw size={13} className={syncing ? "ws-spin" : ""} />
          今すぐ同期
        </button>
        <button
          onClick={onLogout}
          className="flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold"
          style={{
            color: "var(--ws-dg)",
            border: "none",
            background: "transparent",
            cursor: "pointer",
          }}
        >
          <LogOut size={13} />
          退室する
        </button>
      </div>
    </aside>
  );
}
