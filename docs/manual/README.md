# 操作説明書（クラス配布用）

クラスメイトに配る操作説明書のソース。出来上がりは `docs/FES-POS操作説明書.pdf`（A4・20ページ）。

- `index.html` — 説明書の本体。印刷用CSS（`@page`）込みで、これ1枚がPDFの中身そのもの
- `images/` — 説明に使っている画面キャプチャ15枚（受け渡しと注文番号の2枚は、見本の名簿の新しいお店で撮ったJPEG）

## 直したいとき

文章や構成を直すなら `index.html` を編集して、下の「PDFに書き出す」だけ実行すればいい。
**画面キャプチャを撮り直す必要があるのは、UIそのものを変えたときだけ。**

## PDFに書き出す

Chromiumの印刷機能を使う（日本語フォント・スクリーンショット・レイアウトをそのまま保てるため）。

```js
// playwright があれば、これだけ
const page = await browser.newPage();
await page.goto("file:///…/docs/manual/index.html", { waitUntil: "networkidle" });
await page.pdf({
  path: "docs/FES-POS操作説明書.pdf",
  format: "A4",
  printBackground: true,          // 背景色を落とすと色分けが全部消えるので必須
  displayHeaderFooter: true,      // ページ番号のフッター
  margin: { top: "17mm", bottom: "16mm", left: "15mm", right: "15mm" },
});
```

日本語が豆腐（□）になる場合は Noto Sans CJK JP が入っていない。`fonts-noto-cjk` を入れる。

## 載せる範囲の方針

- **一般の部員向け。** 管理者だけができる操作（商品・会計・操作ログ・PINの各タブ、取消・削除、在庫補充、
  閉店後の集計）は説明しない。画面キャプチャも**一般ユーザーでログインして**撮っている。
  管理者で撮ると、読む人の画面には無いボタンやタブが写ってしまうため
- **名前は写さない。** ログイン中の本人の名前（PIN入力画面・PCのサイドバー）も、履歴に出る担当者の名前も、
  撮影直前に名簿（Render の `POS_MEMBERS`）と一致する文字をすべてぼかしている。
  本文にも個人名は書かない
- 未有効の機能（キャッシュレス決済など）は載せない

## 画面キャプチャを撮り直すとき

載せているのは**本番のデータではなく、ローカルに立てたデモ用のデータ**。
本番DBのスクリーンショットを載せると、実際の売上や個人の操作履歴が配布物に出てしまうため。

手順の要点:

1. ローカルにMySQLを立てて空のDBを作る
   （`ensure*` 系の自己修復マイグレーションは `ADD COLUMN IF NOT EXISTS` を使っていて、
   これはTiDB/MariaDBの拡張。**素のMySQLでは通らない**ので `drizzle-kit push` でスキーマを作る）
2. 文化祭当日らしいデモデータを入れる（売上20件前後・補充・仕入れ・取消を1件）
   - チョコバナナだけ在庫を減らしておくと「残りわずか」の警告が撮れる
3. `pnpm build` → `NODE_ENV=production node dist/index.js` で起動
   （`tsx server/_core/index.ts` だと `serveStatic` が `dist/public` を見つけられない）
4. Playwrightで撮影。レジ周りはスマホ幅（400×860・2x）、売上・在庫・履歴はPC幅（1360×940・2x）
   - 撮影直前に名簿の名前を含むテキストを `filter: blur(5px)` の `<span>` で包んでぼかす
   - 撮る前に `animation-duration: 0s` を流し込んで `ws-fade` を止める。
     でないと途中までフェードした行が写る
   - タイムゾーンは `Asia/Tokyo` を指定する（時刻表示が日本時間になる）
5. 2720px幅のままだと重いので、PC画面は1400px、スマホ画面は720pxに縮小して `images/` に置く

撮影に使った一時スクリプトはリポジトリには入れていない（ローカルDBの用意が前提で、
プロジェクトのビルドには関係しないため）。
