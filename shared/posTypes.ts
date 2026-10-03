// The class roster, the admin IDs and the 合言葉 are NOT here: this file is
// bundled into the public app, so they live in server-only environment
// variables (server/roster.ts) and reach a browser only through
// authenticated API calls.

export type TransactionItem = {
  product_id: number;
  name: string;
  emoji: string;
  price: number;
  cost: number;
  qty: number;
};

export const NAV_ITEMS = [
  { key: "pos", label: "レジ", admin: false },
  { key: "handover", label: "受け渡し", admin: false },
  { key: "dashboard", label: "売上", admin: false },
  { key: "inventory", label: "在庫", admin: false },
  { key: "products", label: "商品", admin: true },
  { key: "history", label: "履歴", admin: false },
  { key: "accounting", label: "会計", admin: true },
  { key: "actlog", label: "操作", admin: true },
  { key: "pinmgr", label: "PIN", admin: true },
] as const;

export type NavKey = (typeof NAV_ITEMS)[number]["key"];

export const LOG_ACTIONS = [
  "login", "logout", "checkout", "void_tx", "delete_tx",
  "restock", "add_product", "edit_product", "delete_product", "reset_all",
  "reset_pin", "delete_pin", "pin_request", "approve_pin",
  "add_purchase", "delete_purchase", "add_deduction", "delete_deduction", "loan_repay", "delete_loan_repay",
  "payment_confirm", "payment_cancel", "payment_terminal",
  "cash_float", "cash_collect", "cash_count", "cash_delete", "cash_return", "cash_exchange",
  "login_failed", "login_locked", "admin_recover", "admin_recover_failed", "cash_managers",
  "handover_all", "practice_seed", "practice_cleanup", "report_settings",
] as const;

export type LogAction = (typeof LOG_ACTIONS)[number];

export const LOG_STYLE: Record<LogAction, { label: string; color: string; warn: boolean }> = {
  login: { label: "ログイン", color: "#15803d", warn: false },
  logout: { label: "ログアウト", color: "#64748b", warn: false },
  checkout: { label: "会計", color: "#1d4ed8", warn: false },
  void_tx: { label: "取引取消", color: "#b45309", warn: true },
  delete_tx: { label: "取引削除", color: "#dc2626", warn: true },
  restock: { label: "在庫補充", color: "#6366f1", warn: false },
  add_product: { label: "商品追加", color: "#ea580c", warn: false },
  edit_product: { label: "商品編集", color: "#ea580c", warn: false },
  delete_product: { label: "商品削除", color: "#dc2626", warn: true },
  reset_all: { label: "全リセット", color: "#dc2626", warn: true },
  reset_pin: { label: "PINリセット", color: "#7c3aed", warn: false },
  delete_pin: { label: "PIN削除", color: "#dc2626", warn: true },
  // A first-time PIN waits for an admin (server/login.ts). Marked warn so
  // one set by someone other than the member stands out.
  pin_request: { label: "PIN登録申請", color: "#b45309", warn: true },
  approve_pin: { label: "PIN承認", color: "#15803d", warn: false },
  add_purchase: { label: "仕入れ追加", color: "#0891b2", warn: false },
  delete_purchase: { label: "仕入れ削除", color: "#dc2626", warn: true },
  add_deduction: { label: "控除追加", color: "#0891b2", warn: false },
  delete_deduction: { label: "控除削除", color: "#dc2626", warn: true },
  loan_repay: { label: "貸付金返済記録", color: "#15803d", warn: false },
  delete_loan_repay: { label: "返済記録削除", color: "#dc2626", warn: true },
  // Marked warn: a manual confirmation books money on the cashier's word
  // alone (no API confirmed it), so it should stand out when reconciling.
  payment_confirm: { label: "決済を手動確定", color: "#b45309", warn: true },
  payment_cancel: { label: "決済取消", color: "#64748b", warn: false },
  // Not marked warn: with a card reader this is the normal path for every
  // sale, so colouring it as an exception would make the log unreadable.
  // Its accountability comes from the slip number recorded in `detail`.
  payment_terminal: { label: "端末決済", color: "#1d4ed8", warn: false },
  cash_float: { label: "釣り銭登録", color: "#15803d", warn: false },
  cash_collect: { label: "本部へ回収", color: "#0891b2", warn: false },
  cash_count: { label: "締め（現金照合）", color: "#1d4ed8", warn: false },
  cash_delete: { label: "現金記録の削除", color: "#dc2626", warn: true },
  cash_return: { label: "釣り銭を返却", color: "#0891b2", warn: false },
  cash_exchange: { label: "両替", color: "#6366f1", warn: false },
  // Written by the login page (server/login.ts). Marked warn: a run of
  // these for one number, or from devices that never logged in as it, is
  // someone guessing.
  login_failed: { label: "PIN誤り", color: "#b45309", warn: true },
  login_locked: { label: "PIN入力を停止", color: "#dc2626", warn: true },
  admin_recover: { label: "管理者PINを復旧", color: "#dc2626", warn: true },
  admin_recover_failed: { label: "復旧コード誤り", color: "#dc2626", warn: true },
  cash_managers: { label: "会計係の変更", color: "#7c3aed", warn: false },
  handover_all: { label: "まとめて受け渡し済み", color: "#b45309", warn: true },
  practice_seed: { label: "練習用の商品を追加", color: "#ea580c", warn: false },
  // Marked warn: it deletes sales (the practice ones) in bulk.
  practice_cleanup: { label: "練習の片付け", color: "#dc2626", warn: true },
  report_settings: { label: "報告書の設定", color: "#0891b2", warn: false },
};

/** How an order number is shown and called out: "12番". */
export const orderLabel = (orderNo: number | null | undefined): string => (orderNo ? `${orderNo}番` : "");
