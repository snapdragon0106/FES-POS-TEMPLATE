# FES POS

文化祭の物販のためのレジシステムです。スマホのブラウザがそのままレジになります。

- **レジ** — 商品をタップして会計。お釣りの計算と注文番号
- **受け渡し** — 会計した注文が、商品を渡す係のスマホに数秒で出る
- **在庫** — 全員のスマホで残りの数が同じ。2日目の分を日付指定で先に登録できる
- **現金** — 釣り銭の登録・本部への回収・締め（数えた現金との差額）・釣り銭の返却
- **売上** — 売上・利益・商品別の集計、CSVのダウンロード、学校提出用の収支報告書（PDF）
- **練習** — 本番と同じ画面で練習して、練習の記録だけをあとでまとめて消せる

## 自分のクラスで使う（プログラミングは不要）

**手順書：[docs/FES-POSセットアップ手順書.pdf](docs/FES-POSセットアップ手順書.pdf)**
（GitHub・TiDB Cloud・Render の無料プランで、1〜2時間で用意できます）

1. このページの **Use this template** → **Create a new repository** で、自分用のコピーを作る
2. **TiDB Cloud** でデータベースを作り、接続先（`mysql://…`）を用意する
3. **Render** の **New → Blueprint** でそのリポジトリを選び、接続先・名簿・管理者・合言葉・店の名前を入れる
4. 管理者は、ログイン画面の「管理者の復旧コードを使う」で最初のPINを決める（コードは Render が自動で作る）
5. メンバーは各自PINを決めて申請し、管理者が承認する

名簿・合言葉・接続先は Render の設定（Environment）にだけ入れます。**このリポジトリには書かないでください。**

## 配る資料

| 資料 | 読む人 |
|---|---|
| [操作説明書](docs/FES-POS操作説明書.pdf) | メンバー全員（レジ・受け渡しの使い方） |
| [障害対応手順書](docs/FES-POS障害対応手順書.pdf) | 管理者・リーダー（当日に動かなくなったとき。印刷しておく） |
| [セットアップ手順書](docs/FES-POSセットアップ手順書.pdf) | 用意する人・次の年に引き継ぐ人 |

## 開発する人へ

React 19 + Vite + tRPC v11 + Drizzle ORM（MySQL/TiDB）。Render にデプロイする（`render.yaml`）。

```
corepack pnpm@10.4.1 install
corepack pnpm@10.4.1 run check   # 型チェック
corepack pnpm@10.4.1 run test    # 単体テスト
corepack pnpm@10.4.1 run build
```

- 設計の決まりごと・崩してはいけないこと: [`CLAUDE.md`](CLAUDE.md)
- 環境変数: [`.env.example`](.env.example)
- データベースの表は**サーバーの起動時に自動で作られる**（`server/db.ts` の `ensure*`）。`drizzle-kit push` は使わない
  （TiDB では、同じ表でも主キーなどを作り直そうとする）
- 会計まわりを変えたら、ローカルの TiDB に対して [`scripts/verify/`](scripts/verify/) を流す
- キャッシュレス決済の準備: [`docs/cashless-payment.md`](docs/cashless-payment.md)
