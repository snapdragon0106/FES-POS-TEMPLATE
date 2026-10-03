# セットアップ手順書（後輩・ほかのクラス向け）

出来上がりは `docs/FES-POSセットアップ手順書.pdf`（A4・19ページ）。ITに詳しくない人が、自分のクラス用に
FES POS を用意するための手順書。

- `index.html` — 本体（印刷用CSS込み。説明書 `docs/manual/` と同じデザイン）
- `images/` — 画面写真13枚。**見本の名簿**（見本 一郎 など）で、空のデータベースから立ち上げた「新しいお店」を撮ったもの

## この手順書が前提にしている仕組み

変えたら手順書も直すこと（詳しくは CLAUDE.md の「後輩・ほかのクラスが使うために」）。

- `render.yaml`（Render Blueprint）と、そこで聞かれる5つの値・自動で作られる2つの値
- 空のデータベースで起動できること（`ensureDatabase` / `ensureCoreTables`）と、接続先の整え方（`server/dbUrl.ts`）
- 名簿の書き方 `番号:名前,…`（`server/roster.ts` の `parseMembers`）と、起動時の日本語のエラー文
- 新しいお店の管理者が「管理者の復旧コードを使う」で最初のPINを決める流れ
- 会計タブの「行事名・団体名・借入金」の設定、商品タブの「練習」

GitHub・TiDB Cloud・Render の画面は英語で、よく変わる。ボタンの名前は2026年10月時点のもの。

## PDFに書き出す

説明書と同じ（`docs/manual/README.md` の「PDFに書き出す」）。フッターは「FES POS セットアップ手順書」。

日本語フォントは **Noto Sans CJK JP** にすること。Linux で `LANG=ja_JP` のまま撮ると、fontconfig が中国語のフォント
（WenQuanYi）を選び、太字も無くなる。fontconfig の設定で `sans-serif` に Noto Sans CJK JP を優先させて撮った。

## 画面写真を撮り直すとき

1. ローカルの TiDB に、存在しないデータベース名を指定してサーバーを起動する（表は自動で作られる）。
   環境変数は見本の値：`POS_MEMBERS="2301:見本 一郎,2302:見本 花子,…"`・`POS_SHOP_NAME="経高祭 2年3組"`・
   `POS_ADMIN_RECOVERY_CODE` に16文字以上の値
2. Playwright（スマホ幅 390×844・2倍・`locale: ja-JP`・`timezoneId: Asia/Tokyo`）で、合言葉 → 管理者の番号 →
   復旧コードでPIN → メンバーの申請 → 承認 → 商品の追加 → 在庫 → 会計タブ → 練習 → レジ、の順に撮る
3. 撮る前に、アニメーションを止めるCSS（`animation-duration:0s`）と、トーストを隠すCSS（`[data-sonner-toaster]{display:none}`）を入れる。
   日付の入力欄を日本の書き方（2026/10/04）で写すには、ブラウザを `--lang=ja-JP` と `LANG=ja_JP.UTF-8` で起動する
4. JPEG（品質82）で `images/` に置く
