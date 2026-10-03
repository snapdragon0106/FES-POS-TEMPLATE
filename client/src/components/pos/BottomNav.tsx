import {
  ShoppingCart, LayoutDashboard, Package, Settings2, History, ScrollText, KeyRound, Calculator, PackageCheck,
} from "lucide-react";
import { NAV_ITEMS, type NavKey } from "@shared/posTypes";

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
  /** Counts shown on a tab (受け渡し待ち). */
  badges?: Partial<Record<NavKey, number>>;
}

export default function BottomNav({ tab, setTab, isAdmin, badges }: Props) {
  const visible = NAV_ITEMS.filter((n) => !n.admin || isAdmin);

  return (
    // Admin users see up to 8 tabs. Rather than letting the row overflow
    // the screen (as a fixed icon/label size did), every item shrinks
    // together via flex: 1 1 0 + min-width: 0, and the row itself can
    // scroll horizontally as a last-resort safety net on very narrow
    // screens or very long localized labels.
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-30 flex items-stretch"
      style={{
        background: "var(--ws-sb)",
        borderTop: "1px solid var(--ws-bd)",
        padding: "8px 2px 6px",
        paddingBottom: "max(6px, env(safe-area-inset-bottom))",
        overflowX: "auto",
      }}
    >
      {visible.map((n) => {
        const Icon = ICONS[n.key];
        const active = tab === n.key;
        const badge = badges?.[n.key];
        return (
          <button
            key={n.key}
            onClick={() => setTab(n.key)}
            className="flex flex-col items-center gap-0.5 px-0.5 py-0.5"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              flex: "1 1 0%",
              minWidth: 0,
              color: active ? "var(--ws-ac)" : "var(--ws-ts)",
            }}
          >
            <span style={{ position: "relative", display: "inline-flex" }}>
              <Icon size={17} strokeWidth={active ? 2.4 : 2} style={{ flexShrink: 0 }} />
              {badge ? (
                <span
                  className="font-number"
                  style={{ position: "absolute", top: -6, right: -10, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 999, background: "var(--ws-dg)", color: "#fff", fontSize: 10, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                >
                  {badge}
                </span>
              ) : null}
            </span>
            <span
              className="text-[9px]"
              style={{
                fontWeight: active ? 700 : 500,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: "100%",
              }}
            >
              {n.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
