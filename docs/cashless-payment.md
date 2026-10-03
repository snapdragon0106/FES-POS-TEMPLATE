# キャッシュレス決済 — 決済代行サービスとのAPI連携の準備

このドキュメントは「Airペイ・アルファノートなどの決済代行サービスと契約したとき、
コードのどこを触れば会計処理と在庫管理が繋がるか」をまとめたもの。

**現時点では契約は一切していない。** 入っているのは、契約が決まった時点で
プロバイダ1ファイルを書く（か、環境変数を設定する）だけで動くようにするための足場。

## 現在の状態

`PAYMENT_PROVIDER` が未設定なので、**本番は現金のみで動いている**。
支払い方法の選択UIそのものが描画されないため、レジの見た目・操作は導入前と完全に同じ。

| 状態 | 内容 |
|---|---|
| 実装済み | 決済の抽象化レイヤー、DB、tRPC API、レジUI、Webhook受け口、**在庫引当**、テスト109件 |
| 未実装 | 実在サービスの個別実装、QRコードの画像描画、返金処理 |
| 契約 | 未着手 |

---

## まず最初に: 決済代行サービスは連携方式が2種類ある

ここを取り違えると準備が全部無駄になるので、契約前に必ず確認すること。
**「APIで連携できますか」だけでは足りない。** 同じ「決済代行」でも中身が違う。

### ① サーバーAPI型（オンライン決済型）

こちらのサーバーが決済会社のREST APIを叩き、決済IDを受け取り、
結果はWebhookで通知される。ネット決済系（Stripe、GMOペイメントゲートウェイ、
SBペイメントサービス、PayPayオンライン決済など）がこの形。

```
このPOSサーバー ──API──▶ 決済会社
       ▲                    │
       └────Webhook─────────┘
```

- このPOSのサーバーが決済会社と直接通信する
- Webhookの署名検証があるので、**入金の裏付けが暗号的に取れる**（一番安全）
- レジ端末のOSを問わない

### ② 端末アプリ連携型（app-to-app / 対面決済型）

カードリーダーと決済会社の**専用アプリ**が決済を行い、POSアプリは
URLスキームでそのアプリを起動して結果を受け取る。**Airペイ・Square・stera pack・
スマレジPAYGATEなど、対面のカードリーダー系はほぼこちら。**

```
このPOSアプリ ──URLスキームで起動──▶ 決済会社のアプリ ──▶ カードリーダー
       ◀────結果を持って戻ってくる────┘
（このPOSのサーバーは決済会社と一切通信しない）
```

- **サーバーAPIもWebhookも存在しない。** サーバー間の通信が無い
- 決済の結果は「レジ端末が自己申告する」形になる（暗号的な裏付けは取れない）
- そのかわり**伝票番号（承認番号）を必ず記録**し、後日の入金明細と突き合わせる
- 決済アプリと同じ端末でPOSを動かす必要がある

### 契約前に決済会社へ聞くべき3つのこと

1. **外部POSとの連携方式はサーバーAPI型か、端末アプリ連携型か**
2. **外部POS向けの連携仕様書（URLスキーム / APIリファレンス）をもらえるか**
   — 対面決済系は「自社POSアプリ（Airレジ等）とだけ連携」で、
   third-party向けには公開していない場合がある。**ここが実際の分かれ目になる**
3. **対応OSは何か** — 特にAirペイは**iPad / iPhone（iOS）が前提**。
   このPOSはAndroidアプリ（Capacitor）とiOS向けPWAで配布しているので、
   Airペイと同一端末で動かすならiOS側（PWA）に寄せる必要がある

> 上記の仕様は決済会社側の都合で変わるため、このドキュメントの記述ではなく
> **必ず契約前に営業担当へ直接確認すること。** コード側はどちらの型でも
> 対応できるようにしてあるので、確認結果に合わせて設定を選べばよい。

### 連携が取れなかった場合も詰まない

third-party連携が提供されていなくても、`PAYMENT_PROVIDER=manual` で運用できる。
決済端末をレジの隣に置いて単独で使い、承認された伝票を見て店員がPOS側を確定する形。
売上・在庫・精算の扱いは連携時と完全に同じで、確定操作だけが人間になる。
実際の店舗でもよくある運用なので、これで妥協しても業務は回る。

---

## ファイル構成

```
shared/paymentTypes.ts          支払い方法・決済状態の共有語彙
server/stock.ts                 在庫計算（引当を含む）— 会計・事前チェック・画面表示で共通
server/payments/
  types.ts                      PaymentProvider インターフェース ← 新規プロバイダはこれを実装
  registry.ts                   環境変数からプロバイダを決定。未知の値は起動時にthrow
  service.ts                    金額再計算・在庫引当・状態遷移
  webhookRoute.ts               POST /api/payments/webhook/:provider（サーバーAPI型のみ）
  providers/
    manual.ts                   ①店頭QR掲示 ②決済端末を単独運用して目視確認
    terminal.ts                 端末アプリ連携型（URLスキーム設定だけで動く汎用実装）
    mock.ts                     開発用。サーバーAPI型を書くときの見本
server/payments.test.ts         決済のテスト（47件）
server/stock.test.ts            在庫引当のテスト（25件）
```

---

## 環境変数

| 変数 | 既定値 | 意味 |
|---|---|---|
| `PAYMENT_PROVIDER` | （空） | `manual` / `terminal` / `mock` / 今後追加するID。**空なら現金のみ** |
| `PAYMENT_METHODS` | （空） | 有効化する支払い方法をカンマ区切りで絞る。例 `credit,transport_ic` |
| `PAYMENT_WEBHOOK_SECRET` | （空） | Webhook署名検証用。**未設定ならWebhookは全拒否**（サーバーAPI型のみ） |
| `PAYMENT_TERMINAL_LAUNCH_URL` | （空） | `terminal` 用。決済アプリを開くURLスキーム（後述） |
| `PAYMENT_TERMINAL_CALLBACK_URL` | （空） | `terminal` 用。決済アプリの戻り先 |
| `PAYMENT_TERMINAL_LABEL` | （空） | `terminal` 用。UI表示名。例 `Airペイ` |

Renderの環境変数に足すだけで切り替わる。`mock` は本番では起動時にthrowする
（入金が無いのに「支払い完了」として売上を記録してしまうため）。

---

## ケースA: 端末アプリ連携型（Airペイなど）を入れる

**コードを書かずに環境変数だけで動く。** 連携仕様書からURLスキームを読み取って設定する。

```
PAYMENT_PROVIDER=terminal
PAYMENT_TERMINAL_LABEL=Airペイ
PAYMENT_TERMINAL_LAUNCH_URL=<決済アプリのURLスキーム>
PAYMENT_TERMINAL_CALLBACK_URL=https://fes-pos-xxxx.onrender.com/
PAYMENT_METHODS=credit,transport_ic,paypay
```

`fes-pos-xxxx.onrender.com` は自分のお店のアドレスに置き換える。

`PAYMENT_TERMINAL_LAUNCH_URL` には以下のプレースホルダが使える（それぞれURLエンコードされる）:

| プレースホルダ | 中身 |
|---|---|
| `{amount}` | 金額（円・整数） |
| `{orderRef}` | こちらの一意な注文参照（冪等キー） |
| `{callback}` | `PAYMENT_TERMINAL_CALLBACK_URL` の値 |

例（**実在のスキームではない。必ず連携仕様書の値に置き換えること**）:

```
examplepay://payment?amount={amount}&orderId={orderRef}&callback={callback}
```

パラメータ名は決済会社ごとに違い、推測できない。仕様書を入手してから設定すること。

### 当日のレジ操作

1. 支払い方法で「カード」等を選び「〇〇で支払う」を押す
2. 「決済アプリを開く」→ 決済アプリが起動し、金額が入っている
3. カード / 交通系ICを読み取る
4. POSに戻り、**レシートの伝票番号（承認番号）を入力**して「承認された」を押す
5. 「会計を確定する」で売上と在庫に反映される

### なぜ伝票番号が必須か

端末アプリ連携型には、こちらのサーバーが確認できる裏付けが存在しない
（決済会社のサーバーと通信していないので当然そうなる）。
つまり結果は**レジ端末の自己申告**であり、理屈の上ではログイン済みの部員が
実際には行われていない決済を「承認された」と報告できてしまう。

これは連携方式の性質上どうやっても消せないので、次のように**事後照合できる形**にしてある:

- 承認時は伝票番号の入力を必須にする（サーバー側で拒否する）
- 誰が報告したかを操作ログに残す
- 伝票番号を管理者の決済一覧とCSVに出す

閉店後に決済会社の入金明細と1行ずつ突き合わせれば、齟齬は必ず見つかる。
紙の伝票を使う従来のカード端末と同じ運用で、実務上はこれで十分。

---

## ケースB: サーバーAPI型を入れる

### 1. `server/payments/providers/<名前>.ts` を作る

`PaymentProvider`（`server/payments/types.ts`）を実装する。
`mock.ts` が全メソッドを実装した見本になっているので、コピーして中身を差し替えるのが早い。

```ts
export function createExampleProvider(config: { apiKey: string; apiSecret: string }): PaymentProvider {
  return {
    id: "example",
    label: "Example Pay",
    methods: ["credit", "paypay"],
    capabilities: { webhook: true, polling: true, cancel: true, manualConfirmation: false, terminalReporting: false },

    async createPayment(input) {
      // input.amount は円の整数。input.orderRef を必ず冪等キーとして渡すこと
      const res = await fetch("https://api.example.jp/payments", { ... });
      return {
        providerPaymentId: res.id,
        status: "pending",
        amount: input.amount,
        presentation: { kind: "qr_code", qrCodeData: res.qrUrl, message: "..." },
        expiresAt: new Date(res.expiresAt),
        raw: res,
      };
    },

    async getPayment(providerPaymentId) { /* 状態照会 */ },
    async cancelPayment(providerPaymentId) { /* 取消 */ },
    async verifyWebhook(rawBody, headers) { /* 署名検証。失敗したら必ず null を返す */ },
  };
}
```

### 2. `registry.ts` に登録する

```ts
const KNOWN_PROVIDERS = ["manual", "terminal", "mock", "example"] as const;

function build(id: string) {
  switch (id) {
    // ...
    case "example":
      return createExampleProvider({
        apiKey: process.env.EXAMPLE_API_KEY ?? "",
        apiSecret: process.env.EXAMPLE_API_SECRET ?? "",
      });
  }
}
```

APIキーは**必ず環境変数から読むこと。リポジトリに書かない。**

### 3. Renderに環境変数を設定し、Webhookの通知先を登録する

```
https://fes-pos-xxxx.onrender.com/api/payments/webhook/example
```

末尾はプロバイダの `id` と一致させること。一致しないリクエストは404で拒否される。

### 4. 以上

`routers.ts`・`db.ts`・UI・DBスキーマはどれも触らなくていい。
触る必要が出たなら抽象化が間違っているサインなので、インターフェース側を直す。

---

## 在庫管理 — キャッシュレスで何が変わるか

**現金会計は一瞬**で終わるが、**キャッシュレスは数秒〜1分かかる**。
その間、商品は「売れた」でも「在庫がある」でもない中間状態にある。
ここを扱わないと、お客様がカードを読み取っている最中に隣のレジが
最後のたこ焼きを売ってしまい、**支払い済みなのに商品が無い**という
文化祭で最悪の状況（返金対応）が起きる。

そこで**在庫引当**を実装した。

- 決済を開始すると、その決済はカート内容を保持し、**在庫を確保する**
- 引当は決済が完了（＝売上になる）・失敗・取消・時間切れになると自動的に消える。
  クリーンアップのバッチは要らない
- 引当の上限は**15分**（`server/stock.ts` の `RESERVATION_TTL_MS`）。
  決済会社がそれより短い有効期限を返した場合はそちらが優先される。
  レジを離れた店員が在庫を1日中ロックすることはない
- レジの商品グリッドに出る残数は引当済みを引いた数。**他のレジが売れる数**が出る
- サーバー側の確定時チェックも同じ `computeStock()` を使う。
  事前チェック・確定チェック・画面表示の3つが必ず一致する

在庫の定義は `server/stock.ts` の1箇所だけ:

```
在庫 = 初期在庫 − 売上（取消を除く） + 補充 − 引当中
```

---

## 絶対に崩してはいけない設計

会計まわりなので、以下は意図的にそうなっている。壊すと金額が合わなくなる。

- **金額はクライアントから受け取らない。** `payment.createIntent` はカート（商品IDと数量）
  だけを受け取り、金額は `service.ts` の `priceCart` が商品マスタから再計算する
- **`transaction.create` は `status === "completed"` の決済でしか売上を作らない。** かつ
  `payments.transactionId` が未設定であることを**同一DBトランザクション内の
  `SELECT ... FOR UPDATE`** で確認してから消費する。既存の在庫TOCTOU対策
  （`createTransactionSerialized`）と同じ仕組みに乗せてある
- **決済金額と会計時の合計が一致しなければ拒否する**（決済〜確定の間の価格変更対策）
- **商品内容も一致しなければ拒否する。** 金額だけの照合では、
  同額の別商品にすり替わったときに**別の商品の在庫が減ってしまう**
- **キャッシュレスの取引は `received = total` / `changeAmount = 0` をサーバー側で強制する。**
  クライアントが何を送ってきても無視する。レジ現金の照合はこの2列の合計でやる
- **Webhookは署名検証を通ったものだけ処理する。** シークレット未設定なら全拒否。
  認証されていないエンドポイントなので、署名そのものが認証になっている
- **Webhookの署名検証は生のバイト列に対して行う。** そのため `webhookRoute.ts` は
  `express.json()` より**前**に `express.raw()` で登録してある。順序を入れ替えると
  JSONの再シリアライズでバイト列が変わり、署名が通らなくなる
- **署名が有効でも金額が一致しないWebhookは `completed` にしない**（`failed` にして記録）
- **確定した決済の状態は戻せない。** `settlePaymentStatus` は `pending`/`authorized`
  からしか遷移させない。Webhookは再送されるし順序も保証されないため
- **端末連携の承認報告には伝票番号を必須とする**（前述の理由）
- **引当は決済側の状態から導出する。** 「引当テーブル」を別に作らないこと。
  二重管理になると、決済が失敗したのに在庫が戻らない不整合が必ず起きる

---

## 精算のとき

売上ダッシュボードにキャッシュレスの取引が1件でもあると「支払い方法別」カードが出る。
**「レジ内にあるべき現金」＝現金決済の合計**なので、閉店時はこの数字とレジの現金を突き合わせる。
本日の売上合計と突き合わせるとキャッシュレス分だけ足りなく見えるので注意。

キャッシュレス分は決済会社の入金明細と突き合わせる:

1. 取引明細CSV（ダッシュボード →「取引明細」）を出す。支払い方法列と伝票番号列がある
2. 決済会社の管理画面から当日の取引一覧を出す
3. 伝票番号で1行ずつ照合する

失敗・期限切れになった決済は売上にならないため取引履歴には出てこない。
管理者は `payment.list` API（未UI化）で確認できる。

---

## まだ無いもの

- **QRコードの画像描画** — 現状は決済URLを文字列とリンクで表示している。
  必要になったら `qrcode` パッケージを追加して `CheckoutModal.tsx` の
  `presentation.qrCodeData` 表示部分を差し替える。
  端末連携型・`manual` 運用では画面にQRを出す必要がないため後回しにしてある
- **返金（`refunded`）** — 状態は定義済みだが実行APIは未実装。
  取引の「取消」は売上を無効化するだけで、返金は決済会社の管理画面から手動対応になる
- **決済アプリからの自動復帰** — 端末連携型で決済アプリが結果を持って
  自動的にPOSへ戻る挙動は、決済会社がreturn URLに対応している場合のみ可能。
  対応状況が読めないので、現状は店員が伝票番号を入力する方式にしてある
  （こちらはどの決済会社でも必ず動く）
- **複数インスタンスへのスケール** — 引当はDBベースなので複数インスタンスでも正しく動くが、
  `rateLimiter.ts` は単一インスタンス前提のまま
