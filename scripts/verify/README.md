# 実DBでの会計の検証スクリプト

`server/*.test.ts` はDBをモックしているので、**DBの振る舞いそのもの**（ロック・分離レベル・
UNIQUE制約）はテストできない。本番のTiDBで在庫の二重販売防止が効いていなかった問題
（コミット `5285c6e`）は、モックのテストでは110件すべて通ったまま見逃されていて、
このスクリプトを本物のDBに当てて初めて見つかった。

**会計（`transaction.create` / `createTransactionSerialized`）まわりを変えたら、
必ずTiDBに対してこれを流すこと。**

| スクリプト | 確かめること |
|---|---|
| `race.mjs` | 複数のレジ（別々のPINセッション）が同じ在庫わずかの商品を**同時に**会計しても、在庫を超えて売れない |
| `reconcile.mjs` | 1日分の営業（ランダムな会計・取消・削除・補充・釣り銭・回収・締め）を実際のAPIで流し、売上・各会計の合計とお釣り・在庫・レジの現金・締めの差額・操作ログ（会計1件ごとの行もサーバーが書く）が、スクリプトが別に付けた帳簿と全部一致するか。釣り銭・締め・返却が管理者と会計係だけにできることも確かめる（実行中だけ CASHIER_ID を会計係にして、終わったら元に戻す）。ログインはTurnstileを切ったサーバーで |
| `practice.mjs` | 練習用の商品の追加と「練習を片付ける」。練習用の商品を含む会計（取消済み・本番の商品と混ざったもの・片付けと同時に届いたもの）が全部消え、本番の会計・在庫・受け渡し・今日の注文番号が練習の前の続きに戻るか。現金の記録は選んだもの、かつ練習を始めた後のものだけ消えるか |
| `idempotency.mjs` | 同じ `clientRequestId` の再送（順番に・同時に）で会計が二重に記録されない。最後の1個の再送が「在庫不足」にならない |
| `surface.mjs` | **外から何が見えるか**。cookieなしで、いろいろなパス・メソッド（GET/HEAD/POST/PUT/DELETE/PATCH/OPTIONS）・Acceptを送り、返ってきた応答を種類ごとにまとめる。アプリのHTML・バンドル名・フレームワークのエラーページ・内部のファイル名・コメントが1つでも出たら失敗。**読むだけなので本番に向けてもよい**（合言葉は送らない＝回数制限に数えられない）：`BASE=https://fes-pos-xxxx.onrender.com node scripts/verify/surface.mjs`（自分のお店のアドレス） |

**ローカルのサーバー以外では動かない**ようにしてある（テスト用の商品と売上を書き込むため）。
本番のURLを指定しても即終了する。

## 使い方

```bash
# 1. ローカルのDBに向けてアプリを本番ビルドで起動（tsx ではなく dist/index.js）
corepack pnpm@10.4.1 run build
DATABASE_URL="mysql://root@127.0.0.1:4000/fespos" JWT_SECRET=<32文字以上> \
  POS_MEMBERS='<名簿のJSON>' POS_ADMIN_IDS=3509 POS_ACCESS_CODE=<合言葉> \
  PORT=3200 NODE_ENV=production node dist/index.js

# 2. 別のターミナルで（DB接続情報はスクリプトが直接DBを読んで検算するため）
# ACCESS_CODE はサーバーに渡した POS_ACCESS_CODE と同じ値（ログインの前に合言葉を通るため）
BASE=http://localhost:3200 ACCESS_CODE=<合言葉> DB_PORT=4000 DB_USER=root DB_PASS= node scripts/verify/race.mjs
BASE=http://localhost:3200 ACCESS_CODE=<合言葉> DB_PORT=4000 DB_USER=root DB_PASS= node scripts/verify/idempotency.mjs
# 管理者 3509 / PIN 1234、レジ係 3512 / PIN 0000 でログインする（ADMIN_ID 等で変更可）
BASE=http://localhost:3200 ACCESS_CODE=<合言葉> SALES=120 node scripts/verify/reconcile.mjs
```

`race.mjs` は `STOCK`（在庫数）・`ATTEMPTS`（同時会計の数）・`ROUNDS` で条件を変えられる。
当日に近いのは `STOCK=1 ATTEMPTS=4`（4台のレジが最後の1個を同時に売る）。

ログインに使う番号とPIN（3501/0000, 3509/1234, 3512/0000, 3527/0000）は、ローカルの検証用DB専用の値。
いまは初回のPINに管理者の承認が要り、1234・0000のような推測されやすいPINは新しく設定できないので、
**空のDBで試すときは、これらの番号のPINの行（承認済み）を先に入れておく**（既存の検証用DBからコピーするなど）。

`race.mjs`・`idempotency.mjs`・`practice.mjs` は DB を直接読んで検算する。データベース名は `DB_NAME`（既定 `fespos`）。

## なぜMySQLではなくTiDBで試すのか

本番はTiDB。MySQLとTiDBは同じSQLが通るが、**トランザクション中の読み取りの見え方が違う**。
REPEATABLE READ のとき、MySQLはトランザクション内の最初の読み取り時点のスナップショットを使い、
TiDBはトランザクション開始時点のスナップショットを使う。「ロックを取ってから読み直す」作りは、
MySQLでは正しくてもTiDBでは他のレジの確定が見えずに二重販売する（修正前はTiDBでだけ失敗した）。
**MySQLで通っても、本番で正しい保証にはならない。**

## ローカルにTiDBを立てる

TiDBの公式配布元（tiup）が使えない環境でも、Goのモジュールプロキシ経由でソースから作れる。

```bash
# TiDB 8.5 系のソースを取得（parser は別モジュールなので同じコミットのものを足す）
go mod download -json github.com/pingcap/tidb@release-8.5          # → Dir を控える
go mod download -json github.com/pingcap/tidb/pkg/parser@<同じコミット>
cp -r <parserのDir> <tidbのDir>/pkg/parser

# Go 1.25 でビルドすること（1.26 でビルドすると起動時に panic する）
cd <tidbのDir> && GOTOOLCHAIN=go1.25.12 GOFLAGS=-modcacherw go build -o tidb-server ./cmd/tidb-server

# 単体プロセス・組み込みストレージで起動（TiKV/PD不要）
./tidb-server -store unistore -path /tmp/tidb-data -P 4000 -status 10080
```

起動後 `SELECT @@tidb_txn_mode, @@transaction_isolation;` が `pessimistic` / `REPEATABLE-READ`
（TiDB Cloud の既定と同じ）であることを確認してから、`drizzle-kit push` でスキーマを作る。
MySQLを使う場合、`ensure*` 系の自己修復マイグレーションは `ADD COLUMN IF NOT EXISTS`
（TiDBの拡張）を使っているため失敗する。ローカル検証では `drizzle-kit push` でスキーマを作ればよい。
