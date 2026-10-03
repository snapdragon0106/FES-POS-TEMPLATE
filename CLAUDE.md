# FES-POS — Claude Code 向けメモ

文化祭の物販POSシステム。React 19 + Vite + tRPC v11 + Drizzle ORM（MySQL/TiDB）。
2026年の経高祭で1クラスのために作り、実際の売上を2日間扱った本番システムを、後輩・ほかのクラスが使えるテンプレートにしたもの。
各クラスが自分のリポジトリ・Render・TiDB Cloud で動かす（`docs/FES-POSセットアップ手順書.pdf`、`render.yaml`）。
本文中の「以前は」「監査F-xx」「実際に起きた」は、作ったときの経緯（なぜ今の作りなのか）。

## 環境

- `pnpm` が無くても `corepack pnpm@10.4.1 <cmd>` で動く
  （例: `corepack pnpm@10.4.1 run check` / `run test` / `run build`）
- `pnpm dev` の script は `NODE_ENV=development tsx watch ...` という POSIX 構文で **Windows の PowerShell では動かない**（Git Bash か cross-env が必要）
- ローカルで動かすときは `.env.example` を `.env` にコピーして値を入れる（`.env` は `.gitignore` 済み）。
  `DATABASE_URL`・`JWT_SECRET`・`POS_MEMBERS`・`POS_ADMIN_IDS`・`POS_ACCESS_CODE` が無いと起動時に止まる。
  本番は同じキーを Render の Environment に入れる（`render.yaml` が作るときに聞く）

## DBについて

- DBのスキーマは `drizzle/schema.ts` が正。**表と列はサーバーの起動時に `ensure*` が作るので、`drizzle-kit push` は使わない**。
  空のデータベースでもそのまま起動する：`ensureDatabase`（接続先の最後のデータベース名が無ければ `CREATE DATABASE`）→
  `ensureCoreTables`（`products`・`transactions`・`restocks`・`activity_logs`・`member_pins` を `CREATE TABLE IF NOT EXISTS`）→ 以下の `ensure*`。
  以前はこの5つの表を作る処理が無く、新しいDBでは手元で `drizzle-kit push` を実行しないと動かなかった（後輩が使えない）。
  定義は `drizzle-kit push` が作るものと列・型・既定値・索引まで同じ（TiDBで information_schema を突き合わせて差分0件）。
  **`drizzle-kit push` をTiDBに向けないこと**：drizzle-kit（0.31）はTiDBの表を読み違え、自分で作った直後の表にも
  `ADD PRIMARY KEY`・既定値の変更など30件の変更を出し、`Multiple primary key defined` で止まる（実際に確かめた）。
  過去には `drizzle-kit generate && drizzle-kit migrate`（`db:push` script）と実DBの間でドリフトが起きた前科もある
- `server/db.ts` の `ensure*` 系関数（`ensureDatabase` / `ensureCoreTables` / `ensurePinColumnWidth` / `ensureAccountingTable` /
  `ensureTimestampColumns` / `ensurePaymentTables` / `ensureCheckoutIdempotency` ほか）は起動のたびに実行される自己修復マイグレーション。
  スキーマを変えたら、ここに同種の `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` を足すのが最も安全
  （本番DBに手動でSQLを流す前提を作らない）。`ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` は
  TiDBの拡張で、**素のMySQLでは構文エラーになる**（ローカル検証をMySQLでやるときは `drizzle-kit push` でスキーマを作る）
- **`DATABASE_URL` は貼り付けたままの形でも動くように整える**（`server/dbUrl.ts` の `normalizeDatabaseUrl`）。`DATABASE_URL=` や引用符ごと
  貼った値、TiDB Cloud のホストで `ssl` の指定が無い値・mysql2が無視する `sslaccept=strict`（Prisma用）や `ssl-mode` 付きの値は、
  TLSを有効にした形に直す。TiDB Cloud は暗号化されていない接続を断り、mysql2 は `ssl` パラメータが無いと平文で繋ごうとするため。
  既にある `ssl` はそのまま
- **既存の行があるテーブルにUNIQUE制約を足す変更で `drizzle-kit push` を実行すると、
  「テーブルを空にしますか（truncate）」と対話で聞かれる（`--force` でも出る）。本番で Yes を選ぶと全取引が消える。**
  `transactions.clientRequestId` がまさにこれ。この列と索引は `ensureCheckoutIdempotency` がデプロイ時に作るので、
  push は不要。もし聞かれたら必ず No

## セキュリティ上の設計判断（変更時に注意）

- `server/_core/env.ts` は起動時に **`JWT_SECRET` が32文字未満だとthrowする**（fail-fast）。
  Renderには設定済みだが、ローカルの `vitest.config.ts` にテスト専用のダミー値を注入している。
  このダミー値を消すとテストスイート全体が起動時に落ちる
- `server/rateLimiter.ts` はログインと合言葉用の簡易メモリ内レート制限（キーごとに回数・ロック時間・数える期間を指定）。
  **単一インスタンス前提**。複数インスタンスにスケールする場合は共有ストアへの移行が必要
- **PINの試行回数制限は3段（`server/login.ts` の `limitsFor`）。端末は `pos_device` cookie で区別する**
  （`server/posAuth.ts`。ランダムな端末IDと、その端末でログインしたことのある番号の一覧を署名したもの。400日。それだけでは何も開かない）。
  ①その番号×その端末：5回で5分 ②その番号×**その番号でログインしたことのない端末**全部：1時間に10回（管理者は5回）で1時間
  ③店全体×ログインしたことのない端末：15分に30回で15分。**本人のいつもの端末は②③の対象外**。
  以前は番号ごとに5回で5分だけで、(a) 40人に散らせば無制限に試せた (b) 第三者がわざと5回間違えると管理者本人も締め出せた
  （監査F-01・F-07）。端末cookieの無い送信（cookieを消した・スクリプト）は偽装可能なIPで①を数えるが、②③は必ずかかる。
  ログイン前からログインしていた端末は、次のAPI呼び出しで端末cookieを受け取る（`posAuthenticatedProcedure`）。
  **PINを間違えるたびに操作ログ（`login_failed`、端末IDの先頭6文字つき）、ロックのたびに `login_locked`**。直近1時間の件数は
  `pin.alerts`（管理者）で、管理者の画面に赤い帯（5回以上か管理者の番号へのミス）。**推測されやすいPIN（1234・0000・1212・2580・
  1990〜2030 など、`server/pinPolicy.ts`）は、初回設定・管理者のリセット・復旧のどれでも設定できない**（既存のPINはそのまま使える）
- **名簿（出席番号→氏名）・管理者ID・合言葉はコードに書かない。** Render の環境変数 `POS_MEMBERS`（JSON）・
  `POS_ADMIN_IDS`（カンマ区切り、2人以上可）・`POS_ACCESS_CODE` にだけあり、`server/roster.ts` が読む。
  以前は `shared/posTypes.ts` の定数で、画面がimportしていたため**公開JSバンドル（/assets/index-*.js）に全員の氏名が
  入っていた**（ログイン不要で誰でも読めた）うえ、GitHubの公開リポジトリにも載っていた。未設定・不正なら起動時にthrow
  （Renderは起動失敗のデプロイを採用せず旧版が動き続ける）。**`shared/` に個人情報や秘密を置かないこと**（全部バンドルされる）。
  テストは `vitest.config.ts` のダミー名簿を使う。
  **`POS_MEMBERS` は `3501:山田 太郎,3502:佐藤 花子` の形でも書ける**（`parseMembers`。改行区切り・全角の数字と記号・表計算から貼った
  タブ区切りも可。JSONも今までどおり読む）。設定する人がJSONを書けなくても済むように。起動時のエラーは日本語で、直す項目を名指しする
  （Renderのログで設定した本人が読む）。`POS_ACCESS_CODE` は前後の空白を無視する
- **`POS_SHOP_NAME`（任意）**：店の名前（例：経高祭 3年5組）。ログインページ（合言葉の後だけ。合言葉ページは匿名のまま）の見出し、
  会計タブの団体名の初期値、キャッシュレス決済の説明に使う（`server/shop.ts`）。以前は `server/payments/service.ts` に「経高祭 3年5組」と書いてあった
- 氏名がブラウザに届くのは、ログイン後の `member.list` / `posSession.me` だけ。ログインページ（合言葉通過後）は
  **各部分の1文字目以外を伏せる**（`maskName`、「山田 太郎」→「山＊ 太＊」）。以前は全文を出していて、合言葉のcookieだけで
  番号を順に開けば0.3秒で40人分の氏名一覧が作れた（監査F-06）
- **入れるかどうかは全部サーバーがcookieで決める。アプリ本体（HTML・JS・CSS）はログイン済みの端末にしか配らない**
  （`server/gate.ts` の `requireLoginForApp`）。
  - 合言葉cookie（`pos_gate`）なし → `/` に合言葉ページ、ほかのページは `/` へ転送、ファイルは404、**`/api/*` も全部404**
    （`/api/*` は**合言葉だけでは開かない**。ログイン済みのセッションが無ければ全部404。`hideApiWithoutSession`）
  - 合言葉あり・未ログイン → `/` にログインページ（`server/login.ts`）、アプリのファイルは404
  - ログイン済み（`pos_session` が有効）→ `/` にアプリ
  **合言葉ページ・ログインページは独自のURLを持たない**（どちらも `/` に表示し、フォームも `/` にPOST。
  どちらの処理かはフォームの中身ではなくcookieでサーバーが決める）。以前は `/api/gate`・`/api/login` にあり、
  ログインページのURLを外部から見つけられたと指摘された。ログインしていない相手には（合言葉を入れていても）、`/api/health` と決済Webhook以外の
  `/api/*` を存在しないパスと同じ404で返す（`hideApiWithoutSession`。tRPCがあることすら分からない。ログイン前の画面はAPIを使わない）。
  アプリ側は、この404（tRPCの形ではない＝`data`なし）を受けたら401と同じく `/` へ移動する（`main.tsx`）。
  合言葉なしで取れるのはアイコン・`robots.txt`・`manifest.webmanifest`（ブラウザはmanifestをcookieなしで取りに来る）と、
  後述の自己削除用 `sw.js` だけ
  ログイン成功時は合言葉cookieも30日延長する
  合言葉ページもログインページも**サーバーが返すスクリプトなしのHTMLフォーム**（`server/pages.ts`、厳しいCSP）。
  例外はCloudflare Turnstileを有効にしたときのCloudflareのスクリプトだけ（下記。自前のスクリプトは今も無い）。
  見た目はアプリと同じ（ガラスのカード・オーロラ背景・時間帯の色・PINの4つの枠）。**色・ガラス・入力欄・PIN枠などの共通スタイルは
  `client/public/theme.css` の1か所だけ**で、アプリ（`index.css` が `@import`）とこの2ページ（`/theme.css` を公開で配信）の両方が使う。
  アプリの見た目を変えるときはここを変えれば両方に反映される。ダークモードはアプリが `pos_theme` cookieにも書き
  （`ThemeContext.tsx`、ページ側はlocalStorageを読めないため）、時間帯はサーバーが日本時間で決める。PIN枠はスクリプトなしで、
  1つの入力欄の文字間隔を枠の間隔に合わせている。以前はこの2ページが素のフォームで、「HarmonyOSのUIではない」と指摘された
  「初回ログイン（PINを決める）か、PINを入れるか」もサーバーがDBを見てページを出し分け、POSTでもDBで判定し直す
  （フォームの種類を信用しない。既存PINを初回フォームで上書きできない）。
- **Cloudflare Turnstile（ロボット確認）を合言葉フォームとPINフォームに付けられる**（`server/turnstile.ts`）。
  Render の `TURNSTILE_SITE_KEY` と `TURNSTILE_SECRET_KEY` を**2つとも**設定すると有効、**どちらも無ければ無効**（本番の初期状態。
  スクリプト・CSS・CSPとも導入前と同じで、ページにTurnstileの痕跡は出ない）。**片方だけだと起動時にthrow**（`assertTurnstileConfig`）。
  有効なときは、ページがCloudflareの `api.js` を読み（CSPに `script-src`/`frame-src https://challenges.cloudflare.com` を足すのはそのページだけ）、
  フォームに入る `cf-turnstile-response` をサーバーが siteverify で確かめてから合言葉・PINを見る。フォームごとに `data-action`
  （`gate`/`login`）を付け、別のフォームのトークンは通さない。**確認の失敗は合言葉・PINの失敗回数に数えない**（回線が悪いだけで
  ロックされないように。試行回数制限は今までどおり別にある）。トークンが無ければCloudflareに問い合わせずに断る。
  **Cloudflareに届かないときは断る（fail closed）**。ログイン済みの端末には影響しない（確認はログインのときだけ、セッションは使っている間は自動更新）。
  当日Cloudflareが止まったら、Renderでキーを**2つとも**消せば無効になる（手順書3章E）。`remoteip` は送らない
  （`x-forwarded-for` は送信者が書けるので、偽の値で本物の人が落とされないように）。Androidアプリ（WebView）でも動くかは実機で確認すること。
  **この開発環境からはCloudflareに接続できない**（外向き通信の制限）ので、テストはsiteverifyを偽物に差し替えて行っている
  （`server/turnstile.test.ts`、ブラウザ確認は `api.js` と siteverify をどちらも偽物にして実施）。本物のウィジェットでの確認は本番かローカルPCで
- **初回ログインで決めたPINは、管理者が承認するまで使えない**（`member_pins.approved`。PIN管理タブの「承認待ち」で承認／却下）。
  以前は合言葉と番号さえ分かれば、まだログインしたことのない人（番号は連番）に誰でも成り済ませた
  （「ログインしたことのない番号ならバイパスできる」と指摘された）。承認待ちのPINは正しくても `?e=pending` を返すだけで、
  セッションの検証でも承認済みでないPINは指紋が一致しない扱い（`currentPinFingerprint`）。既存のPIN・管理者がリセットで
  設定したPINは承認済み。列は `ensureTimestampColumns` が `DEFAULT TRUE` で足す
  **承認は申請コードで行う**（`member_pins.requestCode`、`ensureSecurityTables`）。申請した端末にだけ4文字のコードを表示し、
  管理者は本人の画面のコードをPIN管理に入力して承認する（`pin.approve` はコードが一致しないと断る。`pin.list` はコードを返さない）。
  承認待ちの番号でもう一度PINを設定すると申請が置き換わりコードも変わる（申請は番号ごとに1時間5回まで）。以前は第三者が先に申請でき、
  管理者が本人のものと思って承認すれば成り済ましが成立した（監査F-08）。コードの無い古い申請は承認できない（却下して申請し直し）
  **管理者の特例は無い。** 以前は「承認済みPINを持つ管理者が1人もいないとき、管理者の番号の初回ログインは即承認」で、
  手順書の復旧方法（TiDBで管理者の行を消す）を実行している間、合言葉を知る誰でも先に管理者の番号を送れば管理者になれた（監査F-02）。
  管理者は1人でもよい（`POS_ADMIN_IDS` で2人以上にもできる）。管理者のPINの復旧（忘れた・DBが新しい）は **`POS_ADMIN_RECOVERY_CODE`**
  （`server/adminRecovery.ts`。Renderに16文字以上で一時的に設定→ログインページの「管理者の復旧コードを使う」→コードと新PIN→
  設定を消す）。短いと起動時にthrow。リンクは**どの番号のページにも**出す（管理者の番号を明かさない）。管理者以外の番号に正しいコードを
  入れても「違います」。間違いは店全体で1時間5回。成功・失敗とも操作ログ（`admin_recover` / `admin_recover_failed`）
  **経緯：** 以前は合言葉画面・ログイン画面がReactアプリの中にあり、全員にアプリ全体が配られ、アプリが
  `{"verified":false}` や `{"exists":false}` などの応答を見て画面を出し分けていた。応答を書き換えれば次の画面が出た
  （外部から2回指摘された。1回目は合言葉、2回目は「responseのfalseによる判定からセッションも含めたログイン管理に」）。
  そのため `accessCode.*`・`pin.check`・`posSession.login` のtRPC APIは削除した。**クライアントに「通してよいか」を
  判断させるAPIを戻さないこと**。アプリ内の `posSession.me` は名前と管理者表示のためだけで、権限は各APIがサーバーで確認する
- **Service Workerは使わない。`/sw.js` は古いService Workerを消すための自己削除スクリプト**（`server/serviceWorker.ts`）。
  **経緯：** 以前は `vite-plugin-pwa` のService Workerがアプリ一式（HTML込み）を端末に保存し、ページを開くとそれを出していた。
  ログインをサーバーに移した後も、それ以前に開いたことのある端末では**古い合言葉画面（Reactアプリ）が出続け**、合言葉を入れると
  「通信エラーが発生しました」になった（もう無いAPIを呼ぶため）。新しいService Workerに入れ替わることもできなかった：
  インストール時にアプリのJS/CSSを取りに行くが、それはログイン済みの端末にしか返さない（404）ので毎回失敗し、古いものが残り続けた。
  いまの `/sw.js` は何もダウンロードせずにインストールされ、キャッシュを全部消し（古いバンドルも）、自分を登録解除し、開いている
  ページを読み込み直す。ブラウザはService Workerのあるサイトを開くたびに `/sw.js` を取りに来るので、古い端末は次に開いたとき
  自動で直る（実際の旧版 `757b0bd` のService Workerで再現・確認済み）。**`/sw.js` は合言葉なしで返し、キャッシュさせないこと**
  （古い端末はcookieを持っていない）。アプリはService Workerを登録しない：ページは毎回サーバーが出し分けるので保存する意味がなく、
  JS/CSSはハッシュ付きファイル名でブラウザが1年キャッシュし、レジはオフラインでは動かない。**Service Workerを戻さないこと**
  （戻すなら、HTMLを保存しないこと・ログインなしでインストールできること・`/sw.js` を公開にすることが全部必要）
- **外から見える部分は最小にしてある。確かめるのは `scripts/verify/surface.mjs`**（cookieなしで大量のパス・メソッドを送り、
  応答を種類ごとにまとめる。読むだけなので本番に向けてもよい）。cookieなしで得られるのは、合言葉ページ・`/` への転送・
  公開ファイル・`/api/health` の `{"status":"ok"}` と、**それ以外すべてに同じ404（`{"error":"not found"}`、`sendNotFound`）**だけ。
  変更で崩しやすい点：
  - **GET/HEAD以外は `/` へのフォーム送信を除いて全部404**（`requireLoginForApp`）。以前は `PUT /`・`POST /pos`・`OPTIONS /` などに
    **ログインなしでアプリのHTMLが返っていた**（静的ファイルの受け皿 `app.use("*")` がメソッドを見ていなかった）
  - Expressの既定の応答を出さない：転送は本文なし（`redirect()`。`res.redirect` は「Found. Redirecting to」と書く）、
    どこにも当たらない要求と例外は最後のハンドラで同じ404／素の500（`/%` のような壊れたURLで出ていたExpressのエラーページを消した）
  - `ETag`・`Last-Modified`・`Accept-Ranges` を付けない（`app.set("etag", false)`・静的ファイルの設定）。Last-Modified は
    全ファイルでビルド時刻＝デプロイ時刻だった。キャッシュは Cache-Control だけで決める
  - `/theme.css` の `?v=` は中身のハッシュ（以前は起動時刻で、デプロイした時刻が分かった）
  - 公開で配るものにコメントを入れない：`theme.css` と `index.html`（インラインスクリプトも）はビルド時にコメントを消して圧縮
    （`vite.config.ts` の `stripComments`）、`sw.js` の中身にもコメントを書かない。以前は theme.css のコメントに
    `server/gate.ts` などの内部のファイル名や設計が書いてあった
  - ページに載ってよいスクリプトは Turnstile の `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer>` だけ
    （`surface.mjs` はこのタグだけを除いて `<script` を探す）
  - `/api/health` の詳細（db・遅延・commit・時刻）は**合言葉cookieのある端末だけ**。それ以外には ok／unavailable だけ（手順書にも記載）
  - 合言葉の照合はSHA-256のダイジェストどうしを定数時間で比べる（長さの違いで早く返らない）
  - 決済Webhookは、決済会社が設定されていなければ本文を読む前に404（1MBまで読み込ませる手段にしない）
  - Render（前段のプロキシ）が付けるヘッダ（`rndr-id` など）はアプリからは消せない。消すなら独自ドメイン＋Cloudflareの変換ルール
- フォームのPOSTは同じサイトからのものだけ受け付ける（`isSameOriginPost`。ブラウザが付ける `Sec-Fetch-Site` を優先し、
  無ければ `Origin`）。**Referrer-Policy を `no-referrer` にしないこと**：ブラウザが自サイトのフォームにも `Origin: null`
  を付けるようになり、ログインが全部403になる（実際に起きた）。今は `same-origin`
- **合言葉の試行回数制限は、送信元ごと（5回で5分）に加えて店全体（15分で30回→10分停止）。** 送信元は端末cookie
  （`pos_device`、合言葉を通ると発行）、無ければIP。IPは `x-forwarded-for` から取るが、これは送信者が自由に書けるため、
  IPごとの制限だけだと毎回IPを偽って総当たりできた。**店全体の停止は、合言葉を入れたことのある端末（端末cookieあり）には効かない。**
  以前は誰でも偽IPで30回間違えれば全員を10分ずつ締め出せ、合言葉を変えた直後（全員が入れ直す）に致命的だった（監査F-03）。
  `rateLimiter.ts` のキーは上限1万件で古いものから捨てる（偽IPでメモリを埋められないように）
- **ログアウトとPIN変更でセッションを終わらせる。** セッションJWTには `jti`（ID）と `pv`（保存中のPINハッシュの指紋）と
  `auth`（PINを入れた時刻）が入る。ログアウトで `jti` を失効リストに入れ、PINのリセット・削除で `pv` が合わなくなる。
  **失効リストはDB（`revoked_sessions`、`ensureSecurityTables`）とメモリの両方。** 以前はメモリだけで、Renderの休止・再起動のたびに
  ログアウトしたcookieが使えるようになった（監査F-05）。起動時に `loadRevocations` で読み込み、読み込み前は1件ずつDBに聞く。
  **自動延長したら古いcookieは10分後に無効**（`RENEWAL_GRACE_MS`。同時に飛んでいる他のリクエストが古いcookieを持っているため即時にはしない）。
  **延長は `auth` から7日まで**（`MAX_SESSION_AGE_MS`。文化祭の2日と数日前の練習に足りる長さ）。
  PINの参照は30秒キャッシュ（`forgetPinCache` で即時反映）。`jti`/`pv` の無い古いセッションは無効。`auth` の無いセッションは有効期限の1日前をPIN入力時刻とみなす
- **`/api/trpc` は変更（POST）をこのサイトからのJSONだけ受け付ける**（`server/gate.ts` の `guardApi`。`Sec-Fetch-Site: same-origin`、
  無ければ `Origin` の一致、`content-type: application/json`。応答は全部 `Cache-Control: no-store`）。tRPCは `multipart/form-data` も
  受け付けるので、他のサイトのフォームから入力の要らない手続き（ログアウト）を実行できた。今は SameSite=Lax と onrender.com が
  公開サフィックス一覧にあることで防げているが、独自ドメインに移ると崩れる（監査F-09）。ヘッダが両方無いリクエストは通す
  （ブラウザ以外＝被害者のcookieを持たない。`scripts/verify/` がこれを使う）
- アプリは `posSession.me` が返るまでレジ画面を作らず、セッションが切れたら（`me` が null・APIが401）`/` へ移動する（サーバーがログインページを出す）。
  ログアウト時は React Query のキャッシュを全部捨ててから `/` へ
- **入力はすべて上限付きで検証する**（商品名100字・価格100万円まで・会計の金額1000万円まで など）。
  **操作ログは全部サーバーが処理と一緒に書く。画面から書くAPI（`activityLog.create`）は削除した。** 以前は会計・補充・商品・リセット・
  ログアウトを画面が後から書いていて、誰でも任意の文言で「全リセット」などの記録を作れた（監査F-12）。会計のログの金額は
  商品マスタから計算した値（`bookedTotal`）。再送（`duplicate`）は書かない
- **全データリセット（`resetAll`）は `{ confirm: "全データリセット" }` が必要**（画面は入力を求める）。見本の商品（たこ焼きなど）は入れない
  （以前は入れていて、練習や去年のデータを消したお店に見知らぬ商品が並んだ）。商品が1つも無いとき、レジは「商品タブで追加」の案内を出す。操作ログも消えるが、
  リセットした人と消した件数を新しいログの1行目とRenderのログ（`console.warn`）に残す（監査F-10）
  **会計（`accounting.*`）は一覧・追加も管理者限定**（以前はUIだけが管理者限定で、APIは誰でも読み書きできた）
- 売上CSVは `=` `+` `-` `@` で始まる文字列の先頭に `'` を付ける（CSVインジェクション対策。Excelで式として実行されないように）
- アプリのHTMLには CSP（`script-src 'self'` ＋ index.html のインラインスクリプトのハッシュ）を付ける（`server/_core/vite.ts` の `appCsp`）。
  index.html にインラインスクリプトを足しても起動時にハッシュを計算し直すので手作業は不要
- `/api/health` は結果を5秒キャッシュする（公開URLなので、連打でTiDBの無料枠を消費させられないように）
- 依存ライブラリ：本番用は `pnpm audit --prod` で既知の脆弱性0件（Manus由来の未使用パッケージ axios・AWS SDK・streamdown 等を削除、
  tRPC・drizzle-orm・mysql2・express を更新、lodash は `pnpm.overrides` で更新）。開発用に中程度4件が残る
  （vitestの内部・iOS用ビルド部品・drizzle-kitの旧ローダー。本番には載らない）
- cookieは `SameSite=Lax`（以前はManusのiframe用に `None` で、他サイトからのリクエストにもセッションが付いた）
- `pin.list` はPINのハッシュを返さない（4桁PINのハッシュは1万通り試せば戻せるので、送ればPINを送ったのと同じ）。申請コードも返さない
- 平文で保存された古いPINは、起動時に `hashLegacyPins` がハッシュに置き換える（ログインを待たない）
- 画面のエラー表示（`ErrorBoundary.tsx`）は開発時だけスタックトレースを出す。Androidアプリは `allowBackup="false"`＋
  `data_extraction_rules.xml`（WebViewのcookie＝セッションをバックアップや機種変更で持ち出させない）
- Manus由来のもの（OAuth・ストレージのルート、`auth`/`system` ルーター、`vite-plugin-manus-runtime` のインライン
  スクリプト、全要素に元ファイル名と行番号を付ける `jsxLocPlugin`、`client/public/__manus__`、その依存パッケージ）は削除済み。
  その後さらに、テンプレートのREADME・`references/`・`template.json`・`todo.md`、`users` テーブルの定義と関数、
  ルート一覧を `window.__WOUTER_ROUTES__` に書き出す wouter のパッチ（と wouter 自体）、使っていない shadcn/ui 部品50個と
  その依存（Radix・cmdk・vaul・react-hook-form・framer-motion 等）、旧マイグレーションファイル（`drizzle/0001_*`・`meta/`）と
  `db:push` script も削除した。**本番DBに残っている空の `users` テーブル（Manus OAuth用）はコードからは消していない**
  （起動時に自動でDROPする案は見送った）。不要ならTiDBコンソールで `DROP TABLE users` を手動で実行する
- 全レスポンスにセキュリティヘッダ（フレーム埋め込み禁止・nosniff・Referrer-Policy same-origin・noindex・HSTS）と `robots.txt`（全拒否）。
  未知の `/api/*` はアプリのHTMLではなく404
- `server/posAuth.ts` の `verifyPosSession` は、JWTの署名検証に加えて毎リクエスト名簿（`POS_MEMBERS`）を再検証する
  （多層防御）。署名鍵が万一漏れても名簿外のIDでは通らず、名簿から外した人は次のリクエストで締め出される
- `server/routers.ts` の `transaction.create` は `db.createTransactionSerialized`（`server/db.ts`）でDBトランザクション化されており、
  関係する `products` 行を `SELECT ... FOR UPDATE` でロックしてから在庫チェック→挿入する。複数レジの同時会計で在庫が
  マイナスになる問題（TOCTOU）と、同一商品の重複明細が在庫チェックを素通りする問題への対処。**この構造を崩さないこと**
- **そのトランザクションは READ COMMITTED で実行する（`CHECKOUT_TX_CONFIG`）。既定の REPEATABLE READ に戻さないこと。**
  TiDB（本番）は REPEATABLE READ のときトランザクション**開始時点**のスナップショットで読むため、ロック待ちの間に
  他のレジが確定した売上が見えず、ロックがあっても二重販売する。MySQLは最初の読み取り時点でスナップショットを
  取るので同じコードで正しく動いてしまい、しかも単体テストはDBをモックしているので、長い間どこでも検出されなかった。
  TiDBを実機で立てて確認済み（修正前: 在庫1個を2台で同時に会計すると10回中10回とも両方売れた）。
  **会計まわりを変えたら `scripts/verify/`（race / idempotency）を必ずTiDBに対して流すこと**。MySQLで通っても本番の保証にならない
- `restock.create` は管理者限定（`posAdminProcedure`）。過去に一度 `posAuthenticatedProcedure` へ格下げされ、
  UI側の権限ゲート（`InventoryTab.tsx` の `isAdmin` 表示制御）だけに頼る状態になっていた実例があるため、
  **サーバー側の権限チェックとUI側の表示制御は必ず両方揃える**

## 当日の障害に備えた設計（変更時に注意）

障害時の対応手順は `docs/FES-POS障害対応手順書.pdf`（ソース `docs/runbook/index.html`）。
以下はその手順が前提にしている仕組みなので、壊すと手順書が嘘になる。

- **会計の重複防止キー（`transactions.clientRequestId`、UNIQUE）。** レジは会計ごとにキーを発行し、再送でも同じキーを
  使う（`POSRegister.tsx` の `checkoutIdRef`。カートが変わったら破棄）。サーバーは同じキーの会計があればそれを返す
  （`duplicate: true`）。確認は**在庫チェックより前**（最後の1個を売った会計の再送が「在庫不足」にならないように）。
  会場Wi-Fiで「確定したのに応答だけ消えた → もう一度押す」が二重記録になる問題への対処。
  **重複防止が効くのは同じ画面・同じカートでの再送だけ**。ページの読み込み直しや別端末での打ち直しは新しい会計になる
  （手順書でそう指示している）
- **全リクエストに15秒のタイムアウト**（`client/src/main.tsx` の `withDeadline`）。ないと、応答しないサーバーやDBに対して
  「処理中…」が永遠に続く。タイムアウト後の再送が安全なのは上の重複防止キーがあるから
- **接続状態の帯**（`ConnectionBanner.tsx`）。端末の圏外（`navigator.onLine`）とサーバー不通（ポーリングの失敗）を区別して
  表示する。ポーリングの `retry: 1` はこの帯を遅らせないため（既定の3回だと1分以上気づけない）
- **エラー文言。** 予期しない例外は `errorFormatter`（`server/_core/trpc.ts`）で一般的な日本語に置き換え、原因は
  `onError`（`server/_core/index.ts`）でサーバーログに出す。以前はDB障害時にSQL文がそのままトーストに出ていた。
  意図して投げる `TRPCError`（`cause` なし）の文言はそのまま。通信自体の失敗（`data` なし）はクライアントの
  `isConnectionError` が日本語にする
- **`GET /api/health`**（`server/health.ts`）。サーバー／DBのどちらが落ちているかを一目で判別するための公開URL。
  **詳細は合言葉を入れたことのある端末でだけ出る**（それ以外には `{"status":"ok"}`／503 `{"status":"unavailable"}` だけ）。
  `commit` にデプロイ中のコミット（Render の `RENDER_GIT_COMMIT`）を出す。手順書の切り分けフローがこれに依存している。
  起動直後（プロセス起動から3分以内）でDBの初回接続・`ensure*` がまだ終わっていないときは `"db":"starting"`（503）を返す。
  以前はここで `"db":"error"` になり、正常なのにDB障害に見えた（本番デプロイ直後に実際に起きた）。DB接続は `server.listen` 直後に開始する
- **gzip/brotli圧縮**（`compression`）。各端末は8秒ごとに全取引を取りに来るので、無圧縮だと取引1000件で1台あたり
  毎時約310MBになっていた（圧縮後5.8MB）。`activityLog.list` も同じ理由で管理者限定（画面も管理者専用）
- **シート（会計・釣り銭・商品・在庫の入力画面）は全部 `SheetOverlay.tsx` に載せる。** `<body>` に portal で出し、PCは画面中央、
  スマホは下から。**アプリの中に `position: fixed` の画面を直接置かないこと**：祖先に transform・filter・backdrop-filter
  （フェードインのアニメーションやガラスのパネル）があると、fixed がその祖先基準になり、会計画面がレジの枠の上のほうに
  ずれて出て、サイドバーとカートが暗くならなかった（実際に起きた）。背景（`.ws-scrim`、blur 18px）はシートの**親ではなく兄弟**にする：
  backdrop-filter は「filter を持つ一番近い祖先」の中しかぼかせないので、ぼかした背景の中にシートを入れるとシート自身の
  ガラス（blur 34px）が効かず、商品名が透けて読めた。背景は画面の外まで広げてある（`-inset-12`、端でぼかしが途切れないように）
- **CSSで `backdrop-filter` を書くときは `-webkit-backdrop-filter` を先、標準を後に書く。** 逆の順だと、ビルド時の圧縮
  （lightningcss）が後の `-webkit-` を上書きとみなして標準のほうを消し、**ChromeとAndroidではぼかしが一切かからなかった**
  （Safariだけ効いていた）。`.ws-card`・`.ws-glass-sheet`・`.ws-tile-panel` が長い間これだった。ビルド後の
  `dist/public/assets/*.css` に `backdrop-filter:` が残っているかで確かめられる
- `.ws-card` は `overflow: clip`（`hidden` は古いブラウザ用の予備）。`hidden` の箱は、中の入力欄にフォーカスしたときに
  ブラウザが横にスクロールさせることがあり、ログインページで中身が左にずれた（Androidの360px幅で、Turnstileの枠（最小300px）が
  カードからはみ出していた）。ログインページは幅400px以下で余白を減らし、カードの内側を300px以上にしてある
- **トーストは画面上部・不透明**（`App.tsx`、`sonner.tsx`、`--ws-toast-bg`）。下だとスマホで確定ボタンに重なる。
  `sonner.tsx` は存在しないshadcnの `--popover` を参照していて、背景が透明だった
- 履歴タブは最新50件ずつ表示（全件描画だと1000件でスマホが6秒固まった）。「全選択」も表示中の分だけ
- **カードを並べるグリッドは `grid grid-cols-1 md:grid-cols-2` と書く（`grid-cols-1` を省かない）。** 省くとスマホでは暗黙の列になり、
  幅が中身の最大幅で決まるので、日付指定の札や右のボタンがある在庫タブのカードが画面からはみ出し、ページ全体が横に広がった（実際に起きた）。
  `grid-cols-1` は `minmax(0, 1fr)` で画面幅に収まる
- **最後に開いていたタブを端末に覚える**（`POSApp.tsx`、localStorage の `pos_tab`）。読み込み直しでもそのタブに戻る。
  保存できない環境ではレジから。管理者専用のタブが覚えられていても、管理者でなければレジに戻す

## 受け渡し（会計と商品を渡す場所が別）

- **会計すると、その注文が「受け渡し」タブに数秒で出る**（`server/handover.ts`、`HandoverTab.tsx`）。レジは会計完了のトーストと
  カートの上（「前回 ○番」）に**その日の注文番号**を出し、お客さんに伝える。受け渡し係は番号と商品を見て渡し、「渡した」を押す。
  間違えたら「さっき渡した注文」から「戻す」（15分以内）。新しい注文はトースト・振動・（「音あり」にしたとき）ビープ音と枠の強調で知らせる。
  受け渡しの画面を開いている間は画面が消えないようにする（Wake Lock、対応ブラウザのみ）。タブには待ちの件数のバッジ
- **注文番号（`transactions.orderNo`）は日本時間の1日ごとに1から。** 会計のDBトランザクションの中で、`app_settings` の
  `order.seq`（`YYYY-MM-DD:N`）の行を `SELECT ... FOR UPDATE` して採番する（商品・決済の行ロックの後、全会計で同じ順）。
  **取引IDは番号に使えない**：TiDBはIDをサーバーごとにまとめて払い出すので飛ぶ（ローカルでも180001など）。拒否された会計は番号を使わない。
  再送（`duplicate`）は同じ番号を返す。全データリセットで1に戻る。`race.mjs` が「別々の商品を16台で同時に会計しても番号が重ならない」を確かめる
- **待ちかどうかは `transactions.handoverPending`（`DEFAULT FALSE`）。** 新しい会計だけ `true` で入れる。既存の行は既定値で false に
  なるので、導入時に過去の売上が全部「待ち」に出ることはない。`handedAt`/`handedBy` に誰がいつ渡したかが残る（1件ごとの操作ログは書かない。
  「すべて渡した」だけ `handover_all` で記録）。列は `ensureHandoverColumns` が起動時に足す（`drizzle-kit push` 不要）
- **受け渡し係のスマホは2秒ごとに問い合わせるが、DBは読まない**：サーバーは答えをメモリに持ち、会計・取消・削除・リセット・渡した／戻すの
  ときだけ（`handoverChanged()`）読み直す（最長30秒で自然に読み直す）。単一インスタンス前提（レート制限と同じ）。
  **会計・取消・削除を行う手続きを増やしたら `handoverChanged()` を呼ぶこと**（呼ばないと最長30秒、受け渡しに出ない・消えない）
- 待ちに出るのは**今日（日本時間）の、取消していない**注文だけ。1日目に渡し忘れた注文は2日目には出ない
- 紙で営業した分をあとから入力すると、それも「待ち」に出る。入力が終わったら受け渡し画面の「すべて渡した」を押す（手順書4章）

## 練習（準備時間に本番のシステムでレジを練習する）

- **商品タブの一番上の「練習」カード（管理者）。** 「練習用の商品を追加」で ¥100 の【練習】商品を3つ（1つは在庫3で売切・在庫不足を試せる）
  入れ、レジ・受け渡し・釣り銭を本番と同じ画面で練習し、終わったら「練習を片付ける」（`server/routers.ts` の `practice.*`、`db.cleanupPractice`）
- 練習用の商品は `products.practice = true`（`ensureHandoverColumns` が起動時に列を足す。`drizzle-kit push` 不要）。追加のときに
  名前が「【練習】」で始まる既存の商品も練習用に指定する（手で作った分を拾う）。2回押しても増えない
- **片付けは1つのDBトランザクション**：練習用の商品を `FOR UPDATE` → 注文番号の行を `FOR UPDATE`（会計と同じ順。READ COMMITTED）→
  **練習用の商品が1つでも入った会計を取消していなくても削除**（本番の商品と混ざった会計も丸ごと）→ その補充 → 画面で選んだ現金の記録
  （練習用の商品を作った時刻より前のものはIDを送られても消さない）→ 商品。今日の注文番号は**残っている今日の会計の最大の番号に戻す**
  （上げることはない）。操作ログは消さず、片付けたことを `practice_cleanup` で残す。`handoverChanged()` を呼ぶ
- 「取引の削除は取消済みのものだけ」の唯一の例外。練習用の商品は本物のお客さんが買わないので、それを含む会計は練習と決まっている。
  **本番の商品だけの会計には触れない**。全データリセット（商品もすべて消える）を練習の後片付けに使わせないために作った
- 本物の釣り銭を登録した後に片付けるときは、画面の一覧でその記録のチェックを外す（既定は全部チェック）
- `scripts/verify/practice.mjs` がTiDBで確かめる（練習中の会計と片付けの競合、混ざった会計、在庫・注文番号・受け渡しの復元、現金の記録の範囲）

## 会計の整合性（崩してはいけない規則）

- **取引の削除は取消済みのものだけ**（`transaction.delete` / `deleteMany`、SQLの条件にも `voided = true` を入れてある）。
  以前は取消していない売上をそのまま削除でき、売上合計からお金が消え、現金売上ならレジの「あるはずの現金」も減って
  締めで過剰に見えた。取消（ログに残る）→削除（ログに品目と金額を残す）の2段階。一括削除は1件でも未取消があれば全体を拒否。
  画面も取消済みの行にしか削除ボタン・スワイプ削除・選択を出さない
- 同じ取引の二重取消は拒否（ログが二重にならない）
- **営業中（釣り銭登録後・締め前）に新しい釣り銭は登録できない**。登録すると、それより前の現金売上が「あるはずの現金」から
  外れて締めが不足になる。間違えた釣り銭は管理者が記録を削除してから登録し直す。締めた後の回収も拒否
- 会計記録・PINの削除は、存在しないものを消そうとするとNOT_FOUND（以前は何も消えないのに「削除」がログに残った）。
  会計記録の削除ログは保存されている記録の種類・項目名・金額から書く（リクエストの種類を信用しない）
- 預かり金額の入力は数字のみ（小数を入れると画面は四捨五入、サーバーは切り捨てで、お釣りが1円ずれた）
- セッションは使っている間は自動更新（残り12時間を切ったら再発行、PINの指紋は引き継ぐ）。以前は前日16時にログインした
  端末が当日16時に会計の途中でログイン画面に飛ばされ、カートが消えた
- **会計まわりを変えたら `scripts/verify/reconcile.mjs` もTiDBに対して流す**。1日分の営業（ランダムな会計・再送・在庫切れ・
  取消・削除・補充・釣り銭・回収・締め）を実際のAPIで行い、各取引の合計とお釣り・売上合計・在庫・あるべき現金・締めの差額・
  操作ログ・権限が、スクリプトが独自に付けた帳簿と全部一致するかを確かめる

## 商品画像（絵文字の代わりに写真を出す）

- 商品管理（管理者のみ）で写真を選ぶと、**端末側で256pxの正方形に切り抜き・縮小してから**アップロードする
  （`client/src/lib/productImage.ts`。スマホの写真1.3MB → 約22KBのWebP）。サーバー側でも形式（JPEG/PNG/WebPの
  先頭バイト）とサイズ上限200KBを検査する（`server/productImage.ts` の `parseImageDataUrl`）。**SVGは許可しないこと**
  （スクリプトを含められ、自サイトのオリジンから配信するため）
- 画像本体は**別テーブル `product_images`** に置き、`products` には内容ハッシュ `imageHash` だけを持つ。
  商品一覧は全端末が8秒ごとに取りに来るので、ここに画像を入れると通信量が元に戻る（圧縮で直した問題の再発）。
  会計の `SELECT ... FOR UPDATE` にも画像が乗らない
- 配信は `GET /api/product-images/:id?v=<imageHash>`（POSセッション必須）。URLにハッシュが入っているので
  `immutable` で永久キャッシュでき、**各端末は1枚につき1回しかダウンロードしない**（実測: 商品管理→レジ→ポーリング2回で1回）。
  写真を変えるとハッシュが変わり＝URLが変わるので、古い写真が残ることはない
- 画像が無い・読み込めないときは絵文字を表示する（`ProductIcon.tsx`）。絵文字は必須のまま残している
  （取引の記録 `transactions.items` と操作ログは絵文字のスナップショットで、画像は入らない）
- 列とテーブルは `ensureProductImages` が起動時に作る。`drizzle-kit push` は不要

## レジの現金（釣り銭・回収・締め・両替・返却）と釣り銭の目安

参考にした記事（イベント出店の釣り銭準備／文化祭の現金管理）の「持ち出し金を記録する」「売上が貯まったら本部へ移す」
「合わなくても無理に合わせず差額を記録する」「端数の出ない値段にする」を機能にしたもの。計算は全部 `shared/cash.ts`。

- 台帳は `cash_events`（`float` 釣り銭／`collect` 本部へ回収／`count` 締め／`return` 釣り銭の返却／`exchange` 両替）。レジの現金は店で1つという前提
  （スマホが何台でも現金の箱は1つ）。**1日の区切りは最新の `float`**。2日目の朝にまた釣り銭を登録すれば新しい日になる
- 「レジにあるはずの現金」＝ 釣り銭 ＋ その後の**現金**売上（取消・キャッシュレスは除く）− 回収 − 返却（両替は合計が変わらないので入らない）。
  `computeDrawer` をサーバー（締めの記録）と画面の両方が使う。締めの `expected` は**サーバーがDBから計算して凍結**する
  （クライアントの値は最大1ポーリング古い。後で取引が取り消されても、その時点の差額が残る）
- **釣り銭の登録・締め・釣り銭の返却は管理者か会計係**（`cashManagerProcedure`。会計係は `app_settings` の `cash.managers`、
  管理者がPIN管理の「会計係」カードで指定、`cash.setManagers`、ログに残る）。**回収と両替は誰でも**。画面も同じ条件でボタンを出す
  （`posSession.me` の `canManageCash`）。以前は誰でもでき、営業中に締め→新しい釣り銭を記録されると前の売上が照合から外れた（監査F-11）。
  **締めは1日1回**（締めた後の締めは拒否。数え直すなら管理者が締めの記録を削除してから）。全部操作ログに残り、**削除だけ管理者限定**。
  回収は「あるはずの現金」を超える額を拒否する（0を1つ多く打つ誤記の防止）
- 回収のお知らせ：釣り銭を除いた売上がしきい値（既定3万円、`app_settings` の `cash.collectThreshold`、管理者が売上タブで変更、0でオフ）
  を超えるとレジ画面に帯を出す。全端末が `cash.list` をポーリングしている
- 「全データリセット」は `cash_events` も消す（練習の記録）。しきい値は設定なので残す
- **釣り銭の目安（`planChange`）はモンテカルロ**：商品の売れ方で客を作り、支払い方で払わせ、その時点の箱の中身から大きい順
  （無ければ小さい硬貨で代用）にお釣りを出し、出せなかった分を「最初から必要だった釣り銭」とする。400日分試して、合計額が
  80パーセンタイル付近の日の平均を切りのいい枚数に切り上げる。**金種ごとに最悪値を取って足すと1.5倍に膨らむ**
  （最悪の日が金種ごとに違うため）ので、日単位で選ぶこと。乱数はシード固定（同じ入力なら同じ結果）
- **支払い方は「来るお客さん」（`PAYMENT_MIX`）と値段で決まる。** 画面で「生徒だけ（校内公開）」か「一般公開」を選ぶ。
  値段が硬貨1枚で払える会計（¥100）のとき、生徒はちょうど55%・500円玉25%・千円札20%（5千円・1万円札なし）、
  一般はちょうど45%・500円玉22%・千円札29%・5千円3%・1万円1%。ちょうど払える人は、払うのに要る硬貨・札が1枚増えるごとに
  0.85倍に減る（`paymentMixFor`。¥300なら3枚、¥480なら8枚）。**以前は値段に関係なく千円札45%・5千円と1万円で10%に固定していて、
  全商品¥100の店（このクラス）に1日8万〜15万円の釣り銭を出していた**（¥100の会計を毎回¥900のお釣りとして数えていたため）
- 締めの後は、箱に残っているお金（`computeCoins` の推定。締めで数えた枚数からその後の返却を引いたもの）を `onHand` として渡し、
  **それを箱に入れたまま始めた場合に足す分**を出す（2日目の朝に1日目のお金を持ち越す使い方）。釣り銭として登録するのは
  箱のお金＋足す分。同じ秒に記録された締めと返却は記録順（id順）に反映する
- 50円・100円単位でない値段は、商品管理のフォームと一覧、目安カードで「10円玉が必要」と注意する（`awkwardCoinFor`）
- **釣り銭の返却（`cash.returnFloat`）。** 釣り銭には用意した人（`cash_events.party`、任意。担任など）を記録し、文化祭の最後の締めの後に
  「釣り銭を返す」で返した額を記録する。**釣り銭の額を超える返却と、あるはずの現金を超える返却は拒否**。分けて返してもよい。
  締めの後の画面に「全額返却済み」か「返却済み／釣り銭」を出し、締めで不足していれば「不足分をどう補うかはクラスで決める」と表示する
  （システムは自動で埋め合わせない）。2日目も同じお金を使うなら返さずに次の日の釣り銭として登録する（用意した人の名前は前回の値が入る）。
  締めの後の**回収は今も拒否**（`reconcile.mjs` の「no collection after 締め」）。締め後にできるのは返却だけ
- **両替（`cash.exchange`）。** 出したお金と受け取ったお金を金種ごとに入れ、合計が一致しないと拒否。`breakdown` には
  **差分（出た分はマイナス、入った分はプラス）**を保存する。合計は変わらないので「あるはずの現金」には影響しない。締めの後は拒否
- **箱の中の硬貨の推定（`computeCoins`）。** 最新の釣り銭の金種から始めて、時刻順に「会計ごとに客のお金を入れる（預かり金額を
  最少枚数に分解。千円を500円玉2枚で払われても千円札1枚と数える）→お釣りを大きい金種から出す（無ければ小さい硬貨で代用）」、
  回収・返却は大きい金種から出す、両替は記録どおり、締めは数えた枚数で置き換える。**推定であって実数ではない**（締めが正）。
  お釣り用に用意した金種が釣り銭の1/5（最低2枚）以下になると、全端末のレジ画面に赤い帯を出す（締めた後は出さない）。
  会計画面はお釣りの渡し方（例：500円玉×1・100円玉×4）を、この推定から客のお金を足した箱で数えて表示し、
  出せない分があれば「¥○分足りない見込み」と出す（`changeToGive`）。釣り銭の目安（`planChange`）も同じ数え方（`countOutChange`）を使う
- `cash_events.party` は `ensureCashTables` が起動時に足す（`drizzle-kit push` 不要）

## キャッシュレス決済（決済代行サービスとのAPI連携の準備）

決済代行業者との契約はまだしていないが、決まった時点で環境変数を設定するだけ（またはプロバイダ
1ファイルを書くだけ）で動くよう、抽象化レイヤー・DB・UI・Webhook受け口・在庫引当まで実装済み。
**詳細な手順書は `docs/cashless-payment.md`。**

- **`PAYMENT_PROVIDER` が未設定なら現金のみ**で、支払い方法の選択UI自体が出ない。
  本番（Render）は未設定なので、レジの見た目・操作は導入前と完全に同じ
- **決済代行サービスは連携方式が2種類あり、混同すると準備が無駄になる**（契約前に要確認）:
  - **サーバーAPI型**（Stripe / GMO / SBペイメント等のオンライン決済系）— こちらのサーバーが
    決済会社のAPIを叩き、Webhookで結果を受ける。署名検証があるので入金の裏付けが暗号的に取れる。
    → `providers/<名前>.ts` を書いて `registry.ts` に登録する
  - **端末アプリ連携型**（Airペイ / Square / stera / PAYGATE 等の対面カードリーダー系）—
    **サーバーAPIもWebhookも存在しない。** POSアプリがURLスキームで決済会社のアプリを起動し、
    結果はレジ端末が自己申告する。→ `PAYMENT_PROVIDER=terminal` ＋ URLスキームを環境変数に
    設定するだけ。コードを書く必要がない
- 決済会社に聞くべきこと: ①連携方式はどちらか ②外部POS向けの連携仕様書をもらえるか
  （対面系は自社POSとしか連携しない場合がある）③対応OS（**Airペイは iPad/iPhone 前提**。
  このプロジェクトはAndroidアプリ＋iOS PWAなので影響する）
- **連携が取れなくても詰まない。** `PAYMENT_PROVIDER=manual` なら、決済端末をレジの隣で
  単独運用し、承認済み伝票を見て管理者が確定する形で運用できる。売上・在庫・精算の扱いは
  連携時と完全に同じで、確定操作だけが人間になる
- `server/payments/providers/mock.ts` が全メソッドを実装した見本になっている（HMAC署名検証を含む）。
  サーバーAPI型を書くときはこれをコピーして中身を差し替えるのが早い
- **`PAYMENT_PROVIDER=mock` は本番では起動時にthrowする**（入金が無いのに「支払い完了」として
  売上を記録してしまうため）。`PAYMENT_PROVIDER` に未知の値、`terminal` なのに
  `PAYMENT_TERMINAL_LAUNCH_URL` 未設定の場合も起動時にthrowする
  （文化祭当日にレジの前で気付くより、デプロイ時に落ちたほうがいい）

### 在庫引当（キャッシュレスで在庫管理が壊れないための仕組み）

現金会計は一瞬で終わるが、キャッシュレスは数秒〜1分かかる。その間に隣のレジが最後の1個を
売ってしまうと、**支払い済みなのに商品が無い**（＝返金対応）という文化祭で最悪の事態になる。

- 決済を開始すると、その決済がカート内容（`payments.items`）を保持して**在庫を確保する**
- 引当は決済が完了・失敗・取消・時間切れになると**自動的に消える**。
  **引当テーブルを別に作らないこと** — 二重管理になると決済失敗時に在庫が戻らない不整合が出る
- 上限15分（`server/stock.ts` の `RESERVATION_TTL_MS`）。決済会社の有効期限が短ければそちら優先
- **在庫の定義は `server/stock.ts` の `computeStock()` 1箇所だけ。**
  事前チェック（決済開始時）・確定チェック（`transaction.create` のDBトランザクション内）・
  レジの残数表示の3つが必ず同じ関数を使う。ここを分岐させると
  「決済は通ったのに会計で弾かれる」が起きる
- 確定時は `excludePaymentId` で**自分の引当を除外する**（自分が確保した在庫で自分が弾かれる）

### 日付を指定した在庫（2日目の分を前もって登録する）

- 補充（`restocks`）に**売り始める日 `availableOn`**（日本時間の `YYYY-MM-DD`、文字列）を付けられる。その日の0時までは在庫に数えない
  （レジに出ない・会計はサーバーが「在庫不足」で断る）。**前の日の売れ残りはそのまま持ち越す**（在庫＝初期＋売り始めた補充−販売）
- 判定は `shared/stockSchedule.ts` の `isRestockAvailable` / `jstDate` 1か所。`computeStock`（サーバー）と
  `POSApp.tsx` の在庫計算（画面）の**両方がこれを使う**。画面は「今日」を1分ごとに更新するので、0時に何もしなくても切り替わる
- 登録は商品の新規追加フォーム（「日付を指定して追加する在庫」）か、在庫タブの「日付指定」（管理者）。今日の日付なら普通の補充と同じ。
  過去・60日より先・存在しない日付は拒否。**売り始める前なら取り消せる**（`restock.cancelScheduled`、管理者、操作ログに残る）。
  売り始めた在庫は取り消せない（それを前提に売った記録があるため）
- 列は `ensureTimestampColumns` が起動時に足す（`drizzle-kit push` 不要）。`reconcile.mjs` が「明日の在庫は今日は売れない」をTiDBで確かめる

### 会計まわりで崩してはいけない点

- **金額はクライアントから受け取らない。** `payment.createIntent` はカート（商品IDと数量）だけを受け取り、
  `server/payments/service.ts` の `priceCart` が商品マスタから再計算する。`transaction.create` と同じ方針
- **`transaction.create` はキャッシュレスの場合、`status === "completed"` かつ `transactionId` が未設定の
  決済しか消費しない。** その確認は既存の在庫TOCTOU対策（`createTransactionSerialized`）と
  **同じDBトランザクション内の `SELECT ... FOR UPDATE`** でやっている。この構造を崩さないこと。
  1回の支払いで2件の売上を作れてしまう
- **キャッシュレスの取引は `received = total` / `changeAmount = 0` をサーバー側で強制する。**
  レジ現金の照合はこの2列でやるので、現金が動いていない取引がここに数字を入れるとレジが合わなくなる。
  ダッシュボードの「レジ内にあるべき現金」もこれが前提
- **`server/payments/webhookRoute.ts` は `express.json()` より前に登録すること**（`server/_core/index.ts`）。
  署名は生のバイト列に対して検証するため、JSONパーサに先に食われると検証が通らなくなる。
  順序の入れ替えは事故になる
- `settlePaymentStatus` は `pending`/`authorized` からしか状態を動かさない。プロバイダはWebhookを再送するし
  順序も保証しないため、遅れて届いた `pending` が `completed` を巻き戻さないようにしている
- **決済金額だけでなく商品内容（カート）も一致しなければ拒否する**（`sameCart`）。
  金額だけの照合では、同額の別商品にすり替わったときに**別の商品の在庫が減る**
- 手動確認（`payment.confirmManual`）は**管理者限定**。APIの裏付けなしに人の判断だけで入金を計上するため、
  操作ログに警告色で残る。`restock.create` と同じく、サーバー側の権限チェックとUI側の表示制御は両方揃える
- **端末アプリ連携型（`terminal`）の承認報告には伝票番号（承認番号）を必須にする。**
  この方式はサーバー間通信が無く結果はレジ端末の自己申告なので、暗号的な裏付けが原理的に取れない。
  そのかわり伝票番号と報告者を記録し、閉店後に決済会社の入金明細と1行ずつ照合できるようにしてある
  （伝票番号は `transactions.paymentRef` にも複写され、取引明細CSVに出る）。
  `payment.reportTerminalResult` を管理者限定に**していない**のは、カードリーダー運用では
  全ての会計で発生する操作であり、管理者が1日レジに立つ羽目になるため。
  `confirmManual`（例外的操作 → 管理者限定）との違いはここ

## モーション設計（HarmonyOS方針）

最新HarmonyOS（ArkUI）のモーション値を実測ベースで移植している。詳細は以下のファイル参照:

- `client/src/index.css` の `/* ===== HarmonyOS (ArkUI) motion system ===== */` 以下 —
  ArkUIの標準イージング5種（cubic-bezier）と、物理定数（springMotion 130/19、interpolatingSpring 225/30）から
  生成した `linear()` スプリングイージング。**この `linear()` 文字列は手打ちしない**。
  `spring→linear()` ジェネレータで生成すること（会話ログにNode.jsスクリプトあり）
- `client/src/lib/dissolve.ts` — 削除時の「粉々に散って消える」演出。**個別のDOM要素（破片チップ）を`transform`+
  `opacity`だけでバラバラの方向に飛ばす**方式（`spawnChips`）。実際のHarmonyOS（ArkUI）も`Particle`コンポーネントで
  個々の粒子に位置・速度・方向を持たせる実装であり、方式として一致している
  （参考: https://developer.huawei.com/consumer/en/doc/harmonyos-references/ts-particle-animation ）。
  **初代実装はCSS `mask-image` + SVG `feTurbulence`ノイズフィルタで「侵食」を表現していたが、実機（vivo端末の
  Android WebView）で完全に描画されない（見た目は変わらずただ縮んで消えるだけ）ことが画面録画で判明したため
  破棄した。** `mask-image`をSVGフィルタと組み合わせる構成はWebViewごとの対応差が大きく、原因切り分けも困難。
  `transform`/`opacity`はどのレンダリングエンジンでも確実に合成されるため、今後この手の「消える演出」を追加する
  場合も、まずこの2プロパティだけで組めないか検討すること。`prefers-reduced-motion` では破片なしの単純フェードに
  劣化する
- `client/src/components/pos/SwipeToDelete.tsx` — スマホの通知風スワイプ削除。**タッチのみ反応**（PCマウスは従来の
  確認ダイアログ付きゴミ箱ボタンのまま）。取引履歴は復元不能なデータのため `commitFraction={0.55}` `allowFlick={false}`
  で長い意図的なドラッグのみ確定するよう厳しくしてある。商品管理は標準（`0.4`、フリック可）
- **リスト行には2種類のCSS機構が`transform`を奪い合う**。(1) `.ws-card`の`transition`（ホバー効果用）、
  (2) 全行に付く`.ws-fade`の**`animation: ws-fade-in 0.45s ... both`**（表示時のふわっと出現演出）。
  どちらもJSでドラッグ中に`el.style.transform`を書き換えるコードと衝突する。(1)は`transition: none`を
  インラインで設定すれば止まる（インラインstyleがクラスのtransitionに優先するため）が、**(2)は事情が違う**：
  CSSの`animation`は`fill-mode: forwards/both`で終了後も、**インラインstyleより優先度が高いカスケード層**に
  居座り続けるため、`el.style.transform`を後からいくら書いても無視される（`transition: none`と同じ理屈では
  絶対に止まらない）。実機の画面録画で「ドラッグ中は指を大きく動かしても行が一切動かず、指を離した瞬間に
  WAAPIアニメーション（`springBack`/`dissolveOut`、こちらはCSSアニメーションより優先度が高い）が動いて
  初めて真の位置へジャンプする」という症状で発覚した。対処は`el.style.animation = "none"`で**アニメーション
  自体を止める**こと（値を上書きするのではなく機構を殺す）。ドラッグ開始時に`transition`と`animation`の
  両方を`none`にし、`clearVisual()`で両方とも空文字に戻す
- ドラッグ終了時（`onPointerUp`/`onPointerCancel`）は、`reset()`が`cancelAnimationFrame`で保留中の描画フレームを
  破棄する**前**に、その時点の`dx`を同期的に`el.style.transform`へ書き込むこと。破棄されたフレームが実は最新の
  `dx`を反映するはずだったフレームだと、`springBack`/`dissolveOut`が新しいWAAPIアニメーションの開始キーフレームに
  真の`dx`を使うため、DOM上の古い値から一瞬スナップするごく小さな「引っ掛かり」になる
- framer-motion（現在は依存から削除済み）の `AnimatePresence`/`usePresence` による退場アニメーションは**一度試して実機で
  機能しなかった**（原因未特定）。以降、リストの退場演出は `dissolveOut()` のような命令的（WAAPI直接操作）な方式に
  統一している。retryする場合は必ず実機（または本物のブラウザでの`getAnimations()`チェック等）で動作確認すること
- **アニメーションの実機検証は、必ず`animation.currentTime`を明示的に書き換えて`getComputedStyle`で確認する。**
  このプロジェクトのブラウザプレビューツールはスクリーンショットが安定してタイムアウトする制約があるため、
  時間経過を待ってからスクリーンショットで見た目確認……という手順は機能しない。`el.getAnimations()[0].currentTime
  = 500`のように直接シークしてから`getComputedStyle(el).transform`/`.opacity`を読むことで、実際に個々の要素が
  異なる軌道で動いているかを数値で確認できる

## Androidアプリ（Capacitor）

文化祭という短期イベント用途・Apple製品を所有していないという制約から、iOSネイティブ化は見送り、
**Androidのみ** Capacitorでネイティブラップし、APKを直接配布（Google Play審査なし）する方針にした。

- `capacitor.config.ts` の `server.url` は**ビルド時の環境変数 `POS_APP_URL`**（例 `https://fes-pos-xxxx.onrender.com`）。未設定ならエラーで止まる
  （ほかのクラス・年度のアドレスを指したAPKを作らないように）。WebViewが
  本番Renderをそのまま表示するだけで、**アプリ側のコードは一切変更していない**（tRPCクライアントの相対URL
  `/api/trpc` もそのまま機能する）。デメリットは起動のたびにネット接続が必須なこと ＝ 現状のブラウザ版と同条件
- **APKにアプリのコードは入れない**（`webDir: "android-shell"`、中身は空のページ1枚）。以前は `dist/public`（ビルドしたアプリ一式）が
  APKに同梱されていて、WebViewは使わないのに、APKを展開すれば誰でも読めた（名簿をサーバーに移す前にビルドしたAPKなら全員の氏名も）。
  **それより前に配ったAPKは作り直して配り直すこと**
- Render側を更新すれば、アプリ側は再ビルド・再配布なしに次回起動時から反映される
- appId: `com.keikousai.fespos` / appName: `FES POS`
- ビルド手順（Windows・PowerShell前提）:
  1. （不要になった。APKに入るのは `android-shell/` だけで、`vite build` の成果物は入れない）
  2. `$env:POS_APP_URL = "https://fes-pos-xxxx.onrender.com"`（このアプリのアドレス）→ `corepack pnpm@10.4.1 exec cap sync android`（`android-shell` とネイティブ側の設定をプロジェクトに反映。
     webDir を変えた直後の1回は必須。古い `android/app/src/main/assets/public` が置き換わる）
  3. `cd android`
  4. `$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"`
     （`java` がPATHに無いため、Android Studio同梱のJBRを明示的に指定する）
  5. `$env:ANDROID_HOME = "C:\Users\<ユーザー名>\AppData\Local\Android\Sdk"`
  6. `.\gradlew.bat assembleDebug` → `android/app/build/outputs/apk/debug/app-debug.apk` が生成される
- `android/gradle.properties` に `android.overridePathCheck=true` を追加済み。リポジトリを日本語を含むパス（OneDrive の「ドキュメント」など）に
  置いたとき、Android Gradle Pluginの非ASCIIパスチェックでビルドが失敗する対策
- `android/local.properties`（SDKパスを書いたマシン固有ファイル）は `.gitignore` 済み。他のマシンでビルドする
  場合は `sdk.dir=<そのマシンのAndroid SDKパス>` を書いた同名ファイルを自分で作る必要がある
- 現在のAPKは**デバッグ署名**。サイドローディング配布には問題ないが、Google Play公開には別途リリース署名が必要
- アイコン・スプラッシュ画面はCapacitor初期テンプレートのまま未変更

## iOS対応（PWA方式）

iPhone実機・Mac・Apple Developer Program（年間$99）のいずれも無いため、iOSはネイティブアプリ化せず
**PWA（ホーム画面に追加）で対応**する方針にした。Android同様APK配布という選択肢も検討したが、iOS版APKに
相当するもの（審査なしサイドローディング）は存在せず、無料でやるにはFree Apple ID + Sideloadly/AltStoreで
7日ごとの再署名が必要になり、40人規模の配布には非現実的と判断したため。

- 「ホーム画面に追加」に必要なのは `client/public/manifest.webmanifest`（静的ファイル、`client/index.html` から `<link rel="manifest">`）
  とアイコンだけ。**Service Workerは使っていない**（上の「セキュリティ上の設計判断」参照。以前は `vite-plugin-pwa` が
  `sw.js` を生成していたが、古いアプリが端末に残り続ける事故を起こしたので削除した）。
  文化祭中にバグ修正をpushすることが十分あり得るため、**「昨日のキャッシュのまま動き続ける」事故を避けるのが最優先**。
  Service Workerが無いので、ページは毎回サーバーから、JS/CSSは新しいハッシュ名のファイルとして取り直される。
  在庫・価格などのAPIレスポンスをキャッシュする仕組みは絶対に追加しないこと（実店舗のPOSで古い在庫数を見せることになる）
- アイコンはAndroidと同じ`client/public/icon-192.png` / `icon-512.png`（faviconと同じレジスターの絵柄）を流用。
  `manifest`の`background_color`/`theme_color`もAndroidアイコンの紺色（`#051733`）に合わせてある
- iOS Safariは端末・バージョンによってWeb App Manifestの`display`を完全には尊重しないため、
  `client/index.html`に`apple-mobile-web-app-capable`等の独自metaタグも併記している（manifestと二重管理、
  どちらか一方を消さないこと）
- インストール手順はSafariの「共有」→「ホーム画面に追加」のみ。ストア登録・Mac・審査は一切不要

## 後輩・ほかのクラスが使うために（テンプレート化）

**セットアップ手順書：`docs/FES-POSセットアップ手順書.pdf`**（ソース `docs/setup/index.html`、画像 `docs/setup/images/`）。
ITに詳しくない人が、GitHub（テンプレートから自分のリポジトリ）→ TiDB Cloud（Starter・Tokyo、接続先を組み立てる）→
Render（Blueprint）→ 管理者の最初のPIN → メンバーの承認 → お店の準備 → 次の年、の順に進められるように書いてある。

- **`render.yaml`（Render Blueprint）**：New → Blueprint でリポジトリを選ぶと、Web Service（free・singapore・`/api/health`）が作られ、
  `DATABASE_URL`・`POS_MEMBERS`・`POS_ADMIN_IDS`・`POS_ACCESS_CODE`・`POS_SHOP_NAME` を画面で聞かれる（`sync: false`）。
  `JWT_SECRET` と `POS_ADMIN_RECOVERY_CODE` は Render が作る（`generateValue`）。ビルドは `npx --yes pnpm@10.4.1 install --frozen-lockfile && … run build`
  （Renderにpnpmが無くても動く。`NODE_ENV=production` はビルドに付けない：devDependenciesが入らずビルドできない）、起動は `npm run start`。
  **このビルド・起動の手順は、リポジトリを丸ごとコピーした別のディレクトリで実際に流して確かめた**（Render自体はこの開発環境から触れない）
- **新しいお店の管理者は、復旧コードで最初のPINを決める**（承認できる人がまだいないため）。Renderが作った `POS_ADMIN_RECOVERY_CODE` を
  Environment からコピーしてログインページの「管理者の復旧コードを使う」へ。リンクの下に「管理者が最初にPINを決めるとき・PINを忘れたとき」と書いてある
  （リンクはどの番号のページにも出すので、管理者の番号は明かさない）
- **年度替えは、接続先の最後のデータベース名を変えるだけ**（`/fespos` → `/fespos2027`）。新しい空のDBが自動で作られ、去年の売上・PIN
  （同じ番号の先輩のPIN）は前のDBに残る。名簿・管理者・合言葉・店の名前も変える。手順書10章
- **収支報告書の行事名・団体名・借入金は会計タブで設定**（`accounting.settings` / `saveSettings`、管理者、`app_settings` の `report.*`、
  操作ログ `report_settings`）。以前は画面に「経高祭」「¥40,000」「令和8年10月」と書いてあった。日付は今日（日本時間）から令和で出す。
  借入金の既定は40,000円。団体名の初期値は `POS_SHOP_NAME`
- 検証スクリプト（`race` / `idempotency` / `practice`）は `DB_NAME` でデータベース名を変えられる（既定 `fespos`）。
  空のDBから起動したサーバーに対して4本とも通ることを確かめた（ログイン用のPINだけ先に入れる：推測されやすいPINは新しく設定できないため）
- 手順書・説明書のPDFは Playwright（Chromium）の印刷で作る。日本語フォントは Noto Sans CJK JP を使うこと
  （この開発環境では `LANG=ja_JP` にすると中国語の WenQuanYi が選ばれ、太字も無くなる。fontconfig で Noto を優先させて撮った）。
  画面写真は見本の名簿（見本 一郎 など）で撮り、本物の名前・売上を写さない

## 新しく使う人へ

- 用意の手順は `docs/FES-POSセットアップ手順書.pdf`（ソース `docs/setup/`）。メンバーに配る操作説明書と、当日の障害対応手順書も `docs/` にある
- 本番の前に、**スマホ2台以上での通し練習**（同時に会計・取消・受け渡し）と、障害対応手順書の5章（事前の準備）をやること
- 会計まわり（`transaction.create` / 在庫 / 現金）を変えたら、ローカルの TiDB に対して `scripts/verify/` を流すこと（上記）

### 完了済み: `localStorage` へのJWT平文保存の見直し

Manusのiframeプレビューは今後使わないと確定したため、POS session token（JWT）は **httpOnly cookieのみに一本化**した。
- `server/posAuth.ts` — `x-pos-session` ヘッダによるトークン抽出経路を削除。`pos_session` cookieのみを見る
- `server/routers.ts` — `posSession.login` のレスポンスから生JWT（`token`フィールド）を削除。cookieは
  `setPosSessionCookie` で従来通りサーバー側から発行
- `client/src/main.tsx` — `localStorage` からトークンを読んで `x-pos-session` ヘッダに載せる処理を削除。
  `credentials: "include"` によりcookieが自動送信される。移行期に残る古い `pos_token` は起動時に一度だけ削除
- `pos_token` の保存・参照を全廃。その後、ログイン自体もサーバーのページ（`/`）に移り、`pos_operator`
  （localStorageの「ログイン済み」印）も廃止した（上の「入れるかどうかは全部サーバーがcookieで決める」参照）
