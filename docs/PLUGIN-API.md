# プラグイン API

> **状態**: 正本（計画 L・4 層構造）。構造の正本は `docs/ARCHITECTURE.md`。
> 見本は `plugins-author/sample-v2/`。ここにある関数名・戻り値・パスが正。実装と違う説明はしない。

## 名乗り（manifest の新しい欄。計画 X）
本体はプラグインの名前を知らず、プラグインが名乗ったものを並べる。型は `types/plugin-api.d.ts`、検査は `host/layer1/manifest-claims.js`・`host/core/owners.js`。
| 欄 | 中身 |
| :--- | :--- |
| `category` | 種類 1 つ。`destination` `title` `comment` `slot` `login` `look` `layout` `tool` `connect` `dev` `set`（旧 `feature.group` の置き換え。`kind` は読み込み方の分類で別の欄） |
| `for` | 効くサイトの id の配列。全部なら `["*"]`。「機能」「プラグインの管理」の「サイトごと」とホームのサイトの枠に使う |
| `tags` | 検索用の自由な語 |
| `owns` | `{ events, parentActions }`。イベント／親の窓の操作の持ち主（内蔵だけ有効。先に名乗ったものが勝つ） |
| `panels[].aliases／dock／dockOrder／menu` | 昔の配置の id・初めの配置で開く段階・上のメニューの行（`in: view／file／none`） |
| `feature.needs` | `login:<サイト>`・`site:<サイト>`（入っていなければ読み込まず「入っていない」と出す）・`obs` |
| `feature.tip／tipAliases` | 3 回配信したあとの紹介の文と昔の id |
| `site.order／autoSlot` | サイトを並べる順・自動枠取りの部品を持つか |
| `needs: ["title.reserved"]／["keys"]` | 予約の自動送信／キーの口（セットのうち最初の 1 つだけ。自分で足したものは持てない） |
| `provides` の新しい役割 | `site.login@1` `tips.source@1` `storage.locator@1`（`test/contracts/` に約束の試験） |
| `kind: "set"` | セット（データだけ。`set: { label, members }`）。`features.sets`／`features.setSet` で入／切 |
| `isDefault` | テーマの「標準」の印（内蔵だけ） |
`ctx.api`（`register`・`call`）・`ctx.peers` は内蔵だけ。役割ごとの約束は `test/contracts/index.js`、「1 つ抜き」は `test/x5-contracts.test.js`。

## AI の回し方（V0.5。丸ストの再起動もビルドも要らない）

1. 開発者モードをオンにする。**ペアリングは要らない**（開発者モードのあいだ、丸ストが CLI と MCP の合言葉を自動で用意する。画面の「AI をつなぐ」に状態が出る）。CLI は `node cli/marust.js <コマンド>`（`npm run marust -- <コマンド>` でも同じ）。以下の `marust plugin reload` などは、この形で打つ。
2. `npm run new-plugin -- <id>`（または外のプラグインの置き場に置く）。
3. **初回だけ**、ユーザーが画面でそのプラグインを入れる（shadow か live）。legacy のままでは読み込まれない（AI はモードを変えられない）。
4. ファイルを直す → `plugin.reload` → `plugin.status`・`plugin.logs` で確かめる → 直す…（CLI なら `marust plugin reload <id>` / `logs <id> --n 50` / `status <id>`）。
5. 画面のパネルは自動で読み直される（開いているそのプラグインの分だけ）。CSS だけなら `ui.reload` の `theme`。
6. `host/` を直したときだけ `app.restart`（承認が 1 回要る。`marust restart --yes`）。配信中でも reload も restart もできる（映像は OBS が出すので止まらない）。**例外**: OBS の開始・停止を握る自動枠取り（`slot-*`）は、配信中の reload が `streaming-slot` で断られる（`reloadAll` は飛ばす）。
7. 型の検査（任意）: プラグインの `index.js` の先頭にこの 2 行を書くと、`ctx` の名前の打ち間違いを `npm run check` が見つける。
   ```js
   // @ts-check
   /** @param {import('../../types/plugin-api').PluginContext} ctx */
   exports.load = function (ctx) { /* … */ };
   ```
   `import` のパスは、`plugins/<id>/index.js` なら `../../types/plugin-api`、`plugins/sites/<サイト>/` なら `../../../types/plugin-api`。外の置き場（state の plugins）に置いたプラグインは `npm run check` の対象外（`tsconfig.json` の `include` にない）。

| 答え・エラー | 意味 |
| :--- | :--- |
| `result: 'ok'` | 読み直せた（`plugin.status` の `lastError` は null） |
| `result: 'error'` と `error.message` / `error.where` | 失敗。`where` はプラグインのフォルダからの相対パス:行（例 `index.js:12`）。パスは `<plugin>` に伏せてある |
| `message: 'legacy-not-loaded'`（`result: 'skip'`） | 外から入れたプラグインが legacy のまま。ユーザーに「画面でこのプラグインを入れて」と頼む |
| `busy` | 別の読み直しが動いている。少し待ってもう一度 |
| `dev-only` | 開発者モードでない。ユーザーにオンにしてもらう |
| `streaming-slot` | 配信中に、OBS を握る自動枠取りを読み直そうとした。配信が終わってからにする |
| `unknown-id` | その id のプラグインも、置き場のフォルダも無い（`plugin.logs`・`plugin.status` も同じ） |

配信中は、全部を読み直す `plugins.reloadAll` より `plugin.reload <id>` を使う（`reloadAll` はコメントの見張りなども一度止めて戻す）。画面の `ui.reload all` も窓ごと読み直すので、配信中は `plugin:<id>` か `theme` を使う。

## ctx.api.register（V1。内蔵プラグインだけ）

プラグインが自分の API（`<名前空間>.<名前>`）を出せる。外から入れたプラグインはまだ使えない（`ctx.api` が無い）。権限・承認・監査・開発者モードの門は本体のまま（`host/layer1/api.js` の `dispatch`）。

1. manifest に名前空間を宣言する: `"api": { "namespaces": ["shadow"] }`（1〜5 個。`[a-z][a-zA-Z0-9]*`。本体の名前空間 `hub` `engine` `plugin` `api` `hotkeys` `settings` など 28 個（`host/layer1/plugin-api-check.js` の `CORE_NAMESPACES`）は使えない。違反は警告してその欄ごと捨てる）。
2. `load(ctx)` の中で登録する（`start` が終わると `register-closed`）:
   ```js
   ctx.api.register('shadow.report', (params, info) => ({ ok: true }), {
     access: 'read',                      // 'read' か 'write' だけ
     description: '200 文字まで',
     params: { days: { type: 'number', min: 1, max: 30, integer: true, rangeError: 'bad-days' } },
     windowOnly: false                    // true にしてよい（狭める方向）
   });
   ```
   同期で `{ ok: true }` か `{ ok: false, error }` が返る。`error`: `register-closed` / `undeclared-namespace` / `bad-method`（ドットはちょうど 1 つ）/ `reserved` / `bad-access` / `bad-option` / `bad-params` / `bad-handler` / `taken`。
3. **付けられない欄**: `devOnly`・`noApproval`・`permission` など。付けると `bad-option`。`devOnly` は manifest の `audience`（`dev`・`author` なら開発者モードだけ）から本体が決め、`noApproval` は常に false（承認の外し方は本体だけが決める）。`emergency`・`chat-write`・`ext-write` も出せない。
4. `params` の規則は `type required min max integer enum item error typeError rangeError lengthError emptyError trimEmpty` だけ（20 個まで）。検査は呼ぶ前に本体が行う。ハンドラには複製を渡す。`info` は `{ kind, clientId }` だけ（凍結）。
5. 答えは `{ ok: boolean, … }`。物でない・`ok` が真偽でないと `bad-result`、15 秒で返らないと `timeout`、秘密の欄は本体が消す。投げると `failed` で、`plugin.logs` に `api-error <メソッド> <文>`。
6. 表に入るのは `running` になったとき。止める・読み直す・読み込み失敗で外れる（読み直しの間は `unknown-method`）。同じメソッド・同じ名前空間を別のプラグインが先に持っていれば、後の方は入れず `plugin.logs` に `api-taken <メソッド>`。
7. `api.describe` の各行に `owner`（本体は空、プラグインはその id）が付く。MCP・CLI は直さずに道具として出る。

見本: `plugins/dev-shadow/`（`shadow.report`）。

8. **機能のプラグイン**（manifest に `feature` があるもの。bulk-title・comment-send・uplink-estimate など）が出した API は、そのプラグインを切っている（legacy）あいだ表から消える（`unknown-method`・`api.describe` にも出ない）。入れ直すと戻る（V2）。見るのは設定上のモード（`orchestrator.modeSetting`。「全部 legacy に固定」では隠さない）。
9. **本体の行を印で隠す**（V3）: 本体の表の行に任意の欄 `featurePlugin: '<プラグイン id>'` を付けると、そのプラグインが legacy のあいだ、その行も同じように消える（`hotkeys.list`・`hotkeys.save` が `featurePlugin: 'hotkeys'`）。1 回の `api.describe` の中では、プラグインごとにモードを 1 回だけ読む。プラグインが出した行は今までどおり `modeGated`（機能のプラグインなら自動）。

見本（V3）: `plugins/uplink-estimate/`（`uplink.estimate`・`uplink.setSettings`・`uplink.last`。本体の `engine.targetRates` を `ctx.api.call` で読み、設定は `ctx.dataDir/settings.json`。旧い画面の設定ファイルの値は初回の load で 1 回だけ写す）。

### destination.setKey（計画 L）
配信先の id で受け、その配信先のエンジンの行へキーを書く（`{ id, key, server? }`）。権限 `write`。送信中（`streaming`）・メイン出力（`main-output`）・結び付きなし（`no-engine`）は断る。秘密は返事・ログに残さない。

### Rumble の枠の action: prepareSlot（計画 L）
Rumble の枠（`slot-rumble`）の write action。モードが live のとき枠を取り、自分のサイト（rumble）の配信先へ `destination.setKey` でキーを書く。返事は `{ ok, destinationId, reused, keyTail }`（秘密の値は返さない）。

### 本体の読むだけの口 engine.targetRates（V3）
使う予定の配信先ごとの `{ id, name, enabled, kbps, source }` だけを返す（配信中は OBS の実測、そうでなければ設定の値。キー・URL は返さない）。権限 `read`・windowOnly でない・`api.calls` に書けば内蔵プラグインが呼べる。読めない → `{ ok: false, error: 'not-connected' }`、エンジンが無い → `unavailable`。

### 層（layers）
プラグインは内側から順に一層目・二層目・三層目に分かれる（`host/layer1/plugin-layers.json`）。出どころは `source: 'set'` と `source: 'user'`。自分で足したもの、およびセットのうち `community` の印が付いたものは常に三層目。ほかのセットは一覧にあればその層、無ければ三層目。
- **一層目（拡張）**: サイトの名簿のプラグイン（`plugins/sites/*`）、テーマ 2 つ（`theme-default`, `theme-light-large`）、更新の確認（`update-check`）。
- **二層目（管理）**: `host/layer1/plugin-layers.json` の `layer2` 一覧にあるもの。題名の一斉送信（`bulk-title`）、ホットキー（`hotkeys`）、回線の余裕（`uplink-estimate`）、設定の書き出しと戻し（`backup`）、コメント送信（`comment-send`）、わんコメの橋（`chat-inlet`）、`kukulu-port`、`kukulu-sleep`、`set-youtube`、`site-login`。
- **三層目（改善）**: 一覧に無いセットのプラグイン（`ai-connect`、`session`、`diagnostics`、`notify-discord`、`signal-monitor`、`dev-shadow` など）、作者用プラグイン（`plugins-author/`、`author-modes` など。出どころは `set`）、自分で足したもの（`source: 'user'`）。
- **層ごとの違い**:
  - 三層目は配信を始める呼び出し（`broadcast.start`、`engine.start`、`destination.start`、`destination.setMain { use: true }`、`obs.streamControl({ action: 'start' })`）を `layer3-no-start` で断られる。配信を止める呼び出しは通る。
  - 「全部止める」の最中は、どの層からも配信の開始（`broadcast.start` や `obs.streamControl({ action: 'start' })`）が `stopping` で断られる。

### 段階（tier。V5）
manifest の `tier`（`basic`＝どの段階でも読む／`standard`＝中級から／`advanced`＝上級から）。**今の段階より上のプラグインは、`require` も `load` も `start` もしない**（`status: accepted`・`reason: tier-not-loaded`。画面で隠すだけではない）。
- 既定（`tier` が無い・変な値）: サイトのプラグイン（`plugins/sites/`）と `feature.level` が `standard` のものは `standard`、それ以外は `advanced`。**外から入れたものは、manifest に何と書いても必ず `advanced`**。
- 段階は ui-settings の `uiLevel`。無いときは、開発者モードか作者用の配り物（`plugins-author/` がある）なら上級、そうでなければ初級（`resolveUiLevel`）。読み込みの判断に使う段階は、起動時と `registry.applyTier()` の時点のもの。
- 段階を変える（`ui.setSettings { uiLevel }`。ウィンドウだけ）と、上のものは `destroy`・`stop` で止め、読めるようになったものを読む。設定と鍵は消さない。**配信中・配信中か分からないときでも変えられる（V6）**: そのとき OBS の開始・停止を握る自動枠取り（`slot-*`）だけ今のまま（`registry.applyTier({ keepObs: true })`。`deferred` で返る）で、配信が終わったあと（画面が `ui.getSettings` を読むとき・次の段階変更・次の起動）に追いつく。ほかの読み直しの最中は `busy` で断る（段階は元に戻す）。
- **開発者プラグイン（`audience: dev`）は段階ではなく開発者モードで読む**（オンなら初級でも読む・オフなら上級でも読まない。`devmode.set` で入れ替わる。V6）。
- 印だけのプラグイン（下）は、段階で読み込まないあいだ、切ってある（legacy）のと同じに扱う（本体の行は `unknown-method`・`featureOn` は false）。
- `npm run new-plugin` で作ったものは外から入れる扱いなので上級から。

### `ctx.redact(text)`（V6）
秘密らしい値を伏せた文字列にする（本体のログと同じ規則）。本体の `safe-runner` を `require` せずに使うための口。

### `ctx.log`・`ctx.audit`・`ctx.events`（K2）
内蔵プラグインが本体のファイル（`host/`・`lib/`）を `require` しないための口。**内蔵プラグインは本体のファイルへの相対 `require` を持たない**（試験 `test/v5-dist.test.js` の `APP_REQUIRE_CEILING` が 0）。
- `ctx.log.appendJsonl(name, row, options?)`: 日付ごとの JSONL 追記（20 MB で次の番号へ・書く前に伏せる）。書く先は核が決める（そのプラグインの `dataDir`）。`name` は `[A-Za-z0-9_-]{1,64}`。`..`・パス区切りは `false`。
- `ctx.audit.fields`（`localIso`・`clipField`・`summarizeSites`）: 監査の行の形は核が 1 か所で決める。`ctx.audit.append(record)`: 本体の記録（`logs/marust` の `shadow`）へ 1 行。**`provides` に `title.fanout@1` を持つ内蔵・作者用だけ**（ほかは `false`）。`options` は `now` だけ通す（`maxBytes` は核が決める）。見本: `plugins/bulk-title/lib/fanout.js`。
- `ctx.events.NAMES`: イベント名の一覧（凍結）。
- K2 より前の本体には `ctx.log`・`ctx.audit`・`ctx.events` が無い（K5 で束を配るとき、manifest の「要る本体の版」と結ぶ）。
- 自動枠取りの部品（`rollover` ほか）は各サイトのプラグインの `lib/` にある。`rollover.js` は youtube と niconico で同じ中身（試験 `r21-autocast-lib` が見張る）。

### K3 で足した口（内蔵プラグインだけ。深く凍結。足す型は K2 の答えどおり）
- `ctx.app`: `{ version, releasesRepo }`（凍結・読むだけ）。見本: `plugins/update-check/`。
- `ctx.destinations.aggregate()`: 配信先の集計 `{ ready, known, streaming, emergency, anyOutputLive }`。`ctx.destinations.legacySession()`: 旧い置き場のセッションの写し（内蔵の `session` だけ。初回の移しかえ用で、K5 までに外す）。
- `ctx.keys`: キーの口 `{ reload, save, list, release }`。**セットのうち `needs: ["keys"]` を書いた最初の 1 つだけ**（自分で足したものは書けても持てない）。キーの検査（形・method・件数・大きさ・表にある名前か）と押下の実行（窓と同じ権限・全部止めるの 1 回押し）は核（`host/layer1/keys-port.js`）。プラグインは権限の identity を持たない。設定の置き場は `data/marust/hotkeys.json` のまま（バックアップ・引っ越しが同じファイルを読むため）。
- `ctx.external.open(url)`: 使っているブラウザで開く。内蔵で `needs: ["external.open"]` を書いたものだけ。`https:` で、manifest の `external.hosts` に書いた名前のときだけ（違えば `bad-url` で reject）。見本: `plugins/site-login/`。
- `ctx.pluginStates`: `{ isRunning(id), modeOf(id) }`（読みだけ。内蔵の `chat-inlet` だけ）。
- `ctx.api.register` が使える名前空間から `auth`・`sites`・`session`・`tips`・`update`・`diagnostics`・`hotkeys` を外した（その API は内蔵プラグインが出す）。manifest `api.modeGated: true` を書くと、そのプラグインが切（legacy）のあいだ、出した API は無いものとして扱われる（`feature` を持たないプラグイン用）。
- **口を差し替えるプラグイン**: `provides` に `session.store@1`（`instance.controller`）・`chat.inlet@1`（`instance.inlet`）を持つ **セット（`source: 'set'`）の running で、切でないもの 1 つだけ**を、核が選ぶ（`registry.port(provide, name)`）。自分で足したものは選ばれない。2 つ以上あれば使わず `plugin.logs` に 1 行。
- **持ち主のあるイベント**: `session.*` は `session`、`chat.message` は `chat-inlet`、`feature.toggled` は核。持ち主以外の `source` が出すと捨てる（登録簿が `source` を `rec.id` で付けるので、プラグインは名乗れない）。
- **親の窓だけが実行する操作**（manifest `ui.parentActions`。持ち主は `host/layer1/plugin-surface.js` の `PARENT_ACTION_OWNERS` で固定）: `modes.change`・`modes.setMany`・`modes.setDefault`・`hub.forceLegacy`（`dev-shadow`。開発者モードのときだけ）・`ai.pair`（`ai-connect`）。iframe は `window.marust.parent(name, params)` で頼むだけ。確認の窓（live の id 入力・まとめて live の一覧）は親が自分の言葉で作る（`plugins/ui-standard/shell/core/parent-actions.js`）。

### 起動前フック（manifest の `boot`。V6）
`"boot": "boot.js"`（プラグインのフォルダの中の .js）を持つ内蔵・作者用のプラグインは、**プラグインの読み込み（`loadAll`）より前に 1 回**、`boot.js` の `run(ctx)` が呼ばれる（段階・開発者モード・モードに関係なく。外から入れたものは動かさない。失敗しても起動は止まらず、`plugin.logs` に `boot-failed`）。起動時の一度きりの移しかえ用（見本: `plugins-author/dev-legacy-migrate/`）。同期の口だけ。**本体のファイルは `require` しない**（本体が変わっても動くように、`ctx` が約束）。
- `ctx.modes.read()`（`{ ok, missing, writable, data }`）・`ctx.modes.write(next, tag)`（書く前に `<modes>.<tag>.bak` を作る。作れなければ書かない）・`ctx.settings.view()`・`ctx.markers.has/place(name)`（済み印 `data/marust/<name>.json`）・`ctx.rows()`（見つけたプラグインの `id`・`modeKey`・`legacyId`・`status`）・`ctx.announce({ method, paramNames, migrated })`（`modes.changed` を 1 回・監査に 1 行）・`ctx.log`。実装は `host/layer1/boot-context.js`。

### 印だけのプラグイン（V3。`timer-link`・`hotkeys`。V4 で `backup`）

> V4 の `backup`: 本体の `settings.export`・`settings.exportToFile`・`settings.preview`・`settings.import` の 4 行に `featurePlugin: 'backup'`。切ると 4 つとも `unknown-method`（集める・反映するのは一層目の `host/layer1/settings-export.js` のまま）。**引っ越し（`migration.*`）は本体の機能で、切れない**（`featurePlugin` を付けない）。画面のバックアップの部分だけが、`settings.preview` の `unknown-method` で 1 行（`STR.backupOff`）になる（パネルごとは隠さない）。
>
> V4 の `gcal`: `calendar.loginStatus`（read・windowOnly。答え `{ ok, state, defaultRedirect }`）を `ctx.api.register` で出す。`gcal` は `feature` を持たないので、legacy でも読み込まれていれば呼べる。金庫は自分の `google.oauth` を `ctx.secrets.get` で読む（値は返さない）。読めない（無い・復号できない）ときは `state: 'none'`、`not-found` 以外の失敗は `plugin.logs` にコードだけ残る。
中身が無く（`load/start/stop/destroy` は何もしない・`health()` は `{ ok: true }`）、manifest の `feature` で「機能」の一覧に出て、入れる（live）・切る（legacy）だけを担う。**本体の仕事は本体に残す**: タイマーを始めたとき題名を全サイトへ送る係と確認の門（`host/layer1/fanout-gate.js`）、キーの登録（`globalShortcut`）・押したときの権限・全部止めるの 1 回押し（`host/layer1/keys-port.js`）。本体は `electron-main.js` の `featureOn(id)`（設定上のモードが legacy でなければ真）を見て、切っていれば送らない・登録しない。プラグインに `hub.fanout` を呼ばせない（`ctx.api.call` は名前で断る）。
- 切ると: タイマーを始めても題名は送られない（`timer-fanout` の理由 `off`）・ホットキーは 1 つも登録されない（登録済みも外す。設定ファイルは残す。全部止めるのキーも効かない）。
- ホットキーの割り当てのメソッドが表に無い（その機能を切っている）ときは、捨てずに「切ってある」行（`off: true`）として残し、保存でも消さない。モードが変わった・プラグインを読み直したときは登録を作り直す。`hub.fanout` に `confirmed`・`allowedLiveIds` は割り当てられない。

## ctx.api.call（V2。内蔵プラグインだけ）

内蔵プラグインが本体の API を呼ぶ口。manifest に `"api": { "calls": ["hub.getState", …] }`（呼ぶ名前。完全一致・30 個まで・`<名前空間>.<名前>`）と書いた名前だけ呼べる。`ctx.api.call(method, params)` は Promise。
- 本体の `dispatch` を `{ kind: 'plugin', clientId: 'plugin:<id>', requiresApproval: false }` で通す（引数の検査・開発者モードの門・監査はそのまま。書き込みは監査に `plugin:<id>` で残る）。権限は `read`・`write` だけ。
- **呼べない**: `clients` `approval` `modes` `devmode` `plugins` `plugin` の名前空間・名前で断る `hub.fanout`（本物へ送る確認の門を飛ばさせない。題名を送りたいときは bulk-title を通す）・`hub.forceLegacy`・`app.restart`（V2 の評価で追加）・windowOnly の行・`secrets` `vault` の行は窓口だけ（windowOnly）なのでプラグインからは今までどおり呼べない。`engine.setKey` は呼べる（L8g）が、送信中（live・connecting・reconnecting）の配信先は `streaming`、メイン出力は `main-output` で断る。プラグインが出した行（自分を含む。プラグインどうしの呼び合いはしない）・read/write 以外の権限の行。manifest に書いても、呼べない名前は読み込みのときに警告して捨てる。
- 答えの `error`: `not-declared`（api.calls に無い）/ `forbidden` / `unknown-method` / `plugin-stopped`（止めたあと）/ 本体のメソッドの `error`。

## ctx.peers（V2。内蔵プラグインだけ）

内蔵プラグインが**サイトのプラグインの決まったメソッドだけ**を呼ぶ口（題名・コメントを送る bulk-title・comment-send 用）。機能のプラグインどうしは呼べない。
- manifest: `"peers": { "methods": [...] }`。書けるのは `updateMetadata` `updateStream` `updateTitle` `updateCategory` `isConfigured` `suggestCategories` `sendComment` の 7 つだけ（`host/layer1/plugin-api-check.js` の `PEER_METHODS`）。外から入れたもの・一覧に無い名前・重複・空は警告してその欄ごと捨てる。宣言が無ければ `list()` は空・`run()` は `peer-denied`。
- `ctx.peers.list()` → 動いている全プラグイン（自分を除く）の `{ id, mode, manifestVersion, provides, fanout }`（インスタンス・パス・秘密は渡さない）。
- `await ctx.peers.run(id, method, args, { queue: 'fanout' })` → `{ id, result: 'ok'|'error'|'timeout'|'skip', elapsedMs, message, value? }`。役目に合わない相手（`updateMetadata`・`suggestCategories` は `stream.site@1` の v2、`sendComment` は `chat.sink@1`、`update*` は manifest `fanout.method` が同じ v1）・自分・動いていない相手・`queue` が `'fanout'` 以外は `peer-denied`。
- **書くメソッド**（`update*`・`sendComment`）は本体が呼ぶ時にモードを取り直す: legacy は `skip legacy-mode`（呼ばない）、shadow は最後の引数（物）の `dryRun` を `true` に上書き（`update*` は `mode: 'shadow'` も）。読むメソッドはモードを見ない。`sendComment` は 12 秒で時間切れ（相手の manifest の `timeouts` が先）。
- `queue: 'fanout'` を付けると、相手ごとの順番待ち（前の待ちは `superseded`・時間切れのあと動いている間は `plugin-stuck`）に入る。`value` は `ok` のときだけ JSON で複製して渡す。

`plugin.logs` は 1 つのプラグインにつき最新 200 行（1 行 500 文字まで）。絶対パスと秘密は伏せてある。

プラグインは `load(ctx)` → `start(ctx)` → （停止時）`destroy(ctx)` → `stop(ctx)` の順で呼ばれる。この 4 つには**同じ ctx オブジェクト**を渡す。`reload` のあと次の `load` は新しい ctx である。

`runtime: "inproc"` の manifest v2 は、`kind` が `ui` や `integration` でも起動する。`kind: "ui"` のまま起動しないのは **v1**（今の `plugins/timer`）だけ。`child` / `external` は一覧に残し、まだ起動しない（`listed-not-started` / `runtime-not-supported-yet`）。

v1 の ctx には、これまで通り `core` / `logger` / `emit` / `pluginDir` / `manifest` がある。新しい項目を使わなくても動く。`emit(name, payload)` はレジストリ内の配列に積むだけで、**イベントバスには流さない**。バスへ出すのは `ctx.bus.publish` だけ。

## はじめに: ひな形から作る（R14）

```
npm run new-plugin -- <id>          # 最小のプラグイン
npm run new-plugin -- <サイト> --site   # サイトを足すプラグイン（plugins/sites/<サイト>/ に作る。中の役目の id は site-<サイト>）
```

普通のプラグインは `plugins/<id>/`（`manifest.json`・`index.js`・`ui/panel.html`・`ui/panel.js`）と `test/<id>.test.js`、`--site` は `plugins/sites/<サイト>/`（`manifest.json`・`site.js`・`ui/panel.html`・`ui/panel.js`）と `test/site-<サイト>.test.js` ができます。同じ名前があれば何も上書きせず止まります。作ったテストは `npm test` が自動で流します（作った直後に通ります）。`manifest` は v2・`audience: public`・`stability: experimental`（試験中）・既定 `legacy`（送らない）です。

### 最小のプラグイン
manifest の要点: `provides: ["ui.panel@1"]`、`defaultMode: "legacy"`、`actions.getStatus: "read"`、`panels` に画面 1 枚。`index.js` は `load` / `start` / `stop` / `destroy` / `health` と、パネルが読む `getStatus` だけ。秘密を使うときは manifest の `secrets` に名前を書き、`ctx.secrets.get(名前)` で読む（画面・ログ・戻り値には出さない）。

### サイトを足すプラグイン
`--site` のひな形は、manifest の最上段に **`site`（サイトの説明）** が付き、`roles.site`（`site.js`）の `provides` に `stream.site@1` が入ります（R16: 1 つのサイトは `plugins/sites/<サイト>/` の 1 つの manifest。題名は `roles.site`、コメント送信を足すなら `roles.sink`（`sink.js`）、自動枠取りは `roles.slot`（`slot.js`）を足す。役目の id は `<役目>-<サイト>`、モードのキーは `<サイト>:<役目>`）。`site.id`・`site.name`・`site.tier`（追加サイトは `extra`）・`site.ingest`（送り先 URL の候補）・`site.keyHelpUrl`（キーのある場所。https）・`site.tosUrl`（規約）・`site.login`（`none` / `oauth` / `cookie` / `config`）を、**調べて出典つきで**書きます（推測で書かない）。追加サイトは最初は全部「試験中」です。

`site.js` の `updateMetadata(input, meta)` が、題名とカテゴリを送る場所です（legacy は何もしない・shadow は外へ出さない・live だけが送る。ひな形の live は `not-implemented` を返すので、そのサイトの API を呼ぶ処理を書きます）。**コメントの受信（`chat.source`）は作りません。受信はわんコメです。丸ストが行うのは送信だけです。** 本物のサイトにはテストでつながず、偽の `fetch` を使います。

---

## ① プラグインの道具箱 ctx

| 項目 | 形 |
| :--- | :--- |
| `ctx.id` | 自分の id（文字列） |
| `ctx.manifest` | manifest の読み取り専用コピー。書き換えても本体の manifest は変わらない |
| `ctx.pluginDir` | 自分のプラグインフォルダ |
| `ctx.core` | 互換のために残す。Cookie や鍵のファイルは読まない |
| `ctx.logger(level, message)` | これまで通り。メッセージ中の秘密は伏せる |
| `ctx.mode()` | `'legacy'` / `'shadow'` / `'live'`。モードファイルの実効値。未設定なら manifest の `defaultMode`、それも無ければ `'legacy'` |
| `ctx.dataDir` | `STATE_DIR/data/marust/plugins/<id>/`。**読んだときに**無ければ作る。他のプラグインのパスは渡さない |
| `ctx.bus.publish(name, payload, info)` | 下記 |
| `ctx.bus.subscribe(pattern, handler)` | 下記 |
| `ctx.sessions` | 下記 ③ |
| `ctx.secrets` | 下記 ④（`get` / `has` / `set`） |
| `ctx.overlay.publish(name, values)` | 下記 ⑥ |
| `ctx.obs` | 下記「ctx.obs」。manifest の `needs` に `obs.read` を書いたプラグインだけ。**読むだけ** |

### ctx.bus.publish(name, payload, info)

- `source` は常に自分の id。`info.source` は無視する。
- `info.correlationId` があればそれを載せる。無ければ `''`。
- 戻り値は配った受け手の数（バスが無いときは `0`）。
- 知らないイベント名でも捨てない（バスが warn する）。
- **セッションの正は `source === 'sessions'` のイベントだけ**。プラグインが出した `session.*` は状態を変えない。カレンダー等は `source` を見る。

### ctx.bus.subscribe(pattern, handler)

- manifest の `subscribes` が覆うパターンだけ購読できる。
- 覆う、とは「宣言と同じ」か「宣言の `接頭辞*` より狭い」こと。`session.*` なら `session.*` と `session.started` は可。`*` や `stream.*` は不可。
- パターン自体が既知のイベント名か、既知イベントに合う `*` でなければ不可。
- 拒否したときは warn し、**`null` を返す**。購読は付かない。
- 成功したときは解除関数を返す。`reload` で本体が解除する。
- `handler(name, payload, meta)`。`meta` は `{ id, version, occurredAt, source, correlationId, pluginId }`。
- `subscribes` が空でないプラグインは、これまで通り `onEvent(name, payload, meta)` の export が必須。`ctx.bus.subscribe` はその追加である。両方あれば両方呼ばれる。

### ctx.obs

manifest の `needs` に `"obs.read"` を書いたプラグインだけに渡る。書いていないプラグインの `ctx.obs` は `undefined`。本体が `createRegistry({ obsRead })` を渡しているときだけで、渡っていないとき（テストや OBS 無しの起動）は宣言があっても `ctx.obs` は無い。

渡るのはこの 2 つだけ。**読むだけ。書き込みの口は無い**（`call` も `StartStream` も `StopStream` も無い。シーン切り替えも無い）。

| 関数 | 戻り |
| :--- | :--- |
| `ctx.obs.getStreamStatus()` | Promise。OBS の `GetStreamStatus` の結果をそのまま返す。未接続・失敗は `null` |
| `ctx.obs.isStreaming()` | Promise。`GetStreamStatus` の `outputActive === true` のときだけ `true`。未接続や失敗は `false` |

**配信全体の開始・停止だけの口**（R22、2026-10-07）: manifest の `needs` に `"obs.streamControl"` も書いたプラグインの `ctx.obs` には、さらに次が付く。`createRegistry({ obsControl })` が渡っているときだけ。

| 関数 | 戻り |
| :--- | :--- |
| `ctx.obs.streamControl({ action: 'start' \| 'stop' })` | Promise。`{ ok: true }` か `{ ok: false, error }`。`error`: `not-live`（そのプラグインが live でない）/ `obs-control-off`（画面の「OBS の操作」がオフ）/ `obs-not-connected` / `human-stopped`（`start` のとき。そのプラグインの `stop` より後に、人が全部止める・手動の停止をした。`host/core/engine/obs-stream-control.js`）/ `stopping`（全部止めるの最中）/ `layer3-no-start`（三層目）/ `bad-action` / `failed` |
| `ctx.obs.streamControl({ action: 'check' })` | OBS は動かさず、今この口が使えるかだけ返す（同じ `ok` / `error`）。切り替えの前に使う |

`call` や配信先の操作の口は無いまま。`host/core/engine/obs-connection.js` の `call` は `StartStream` / `StopStream` を拒否したままで、`controlStream('start'|'stop')` だけがそれを通す。使えるのは、そのプラグインが `live` で、かつ画面の「OBS の操作」（`obs-engine` が `live`）がオンのときだけ。`shadow` / `legacy` では OBS を止めも始めもしない。

本体側の受け口は `createRegistry({ obsRead })`。`obsRead(requestName)` は Promise を返し、本体は `GetStreamStatus` 以外を拒否する。さらに `host/core/engine/obs-connection.js` の `call` が読み取りだけを通すので、書き込みは 2 重に拒否される。

---

## ② イベントと状態

バスに載る外側の形は固定する。中身は `payload` だけ。

```text
{ name, version, id, occurredAt, source, correlationId, payload }
```

受け手の関数には、このオブジェクトを 1 つではなく `(name, payload, meta)` で渡す。`meta` が `version` / `id` / `occurredAt` / `source` / `correlationId` を持つ。`version` の既定は `1`。

| 名前 | 内容 |
| :--- | :--- |
| `session.started` / `session.paused` / `session.resumed` / `session.ended` / `session.retitled` | セッション |
| `stream.preflight.result` | 配信前チェック |
| `stream.starting` / `stream.started` / `stream.stopping` / `stream.stopped` | 配信全体 |
| `engine.target.changed` | 配信先ごとの状態 |
| `broadcast.started` / `broadcast.result` / `broadcast.stopped` | 配信開始・結果・停止 |
| `engine.emergencyStop` | 全部止める（停止要求） |
| `destination.observed` | 配信先の観測状態 |
| `chat.message` / `chat.sent` | コメント受信（わんコメ橋等）／コメント送信結果 |
| `auth.updated` | ログイン情報が更新された（値は含めない） |
| `viewer.count` | 同接 |
| `slot.acquired` | 自動枠取りの「今の枠」が変わった（`{ site, broadcastId \| liveId, liveChatId?, reason: 'created' \| 'reused' \| 'switched', previousId?, at }`。キーは含まない。引き継ぎでも出す）。コメントを将来受け取る部品が使う |
| `slot.switching` | 自動枠取りが枠の切り替え（OBS を止めて再開する約 10〜20 秒の暗転）を始めた／終えた（`{ site, phase: 'start' \| 'end', at }`）。回線の見張り（signal-monitor）は、この間の停止・再接続を「悪い」と数えない |
| `site.trouble` | サイトの困りごと（`{ site, job, kind, code, at }`。job は slot・title・comment、kind は login-expired・rate-limited・unreachable・failed。どのプラグインも出せるが、形が違うと断る。配信は止めない。ホームに 1 行） |
| `approval.resolved` | 承認の解決 |
| `hotkey.result` | ホットキー実行結果 |
| `feature.toggled` | 機能の入切切り替え（核が発行） |
| `stream.metadata.changed` | 題名・カテゴリの変更通知 |
| `signal.stateChanged` | 回線見張りの状態変化 |
| `modes.changed` | モードの変更通知 |
| `plugin.reloaded` | プラグインの再読み込み完了 |
| `ui.reloadRequested` / `ui.themeChanged` / `ui.shellChanged` | UI 再描画要求／テーマ変更／画面の本体役の変更 |

`subscribes` には、上の名前か、それに合う `接頭辞*`（例: `session.*`、`*`）だけ書ける。それ以外は warn して捨てる。プラグインは起動する。

---

## ③ セッション

`ctx.sessions.view()` は誰でも呼べる。戻りはセッションモジュールと同じ。

```text
{ active: boolean, title: string, state: string, elapsedMs: number }
```

動いているセッションが無いときは `{ active: false, title: '', state: 'none', elapsedMs: 0 }`。

`start(input)` / `pause()` / `resume()` / `end(input)` / `retitle(title)` は、`provides` に `session.controller@1` があるプラグインだけ。無いときはセッションを呼ばず `{ ok: false, error: 'not-controller' }`。

あるときはセッションモジュールの戻りをそのまま返す（`ok` と `reason`。例: `session-active` / `not-running` / `not-paused` / `no-session` / `source-not-enabled`）。

`start` の `input` は `{ title, category, plannedSec, source }`。`source` は `'timer'` か `'manual'`。それ以外は `'manual'` として始まる。`'obs'` は拒否する。

同時に動くセッションは 1 つ。本体が配線していないときは、コントローラでも `{ ok: false, error: 'unavailable' }`。

---

## ④ 秘密（Secret Provider）

秘密の守りは 3 つ（金庫にだけ保存・画面は末尾 4 文字・ログ等の出口で伏せる。ADR 0006）。プラグインは manifest の `secrets` で宣言した秘密を、層や出どころに関わらず値のまま `ctx.secrets.get(name)` で利用できる。

`ctx.secrets.get(name)` は常に Promise。

| 条件 | 戻り |
| :--- | :--- |
| `name` が文字列でない | `{ ok: false, error: 'bad-name' }` |
| それ以外 | Provider の `get` の結果（値）。manifest の `secrets` は「どのプラグインがどのキーを使うか」の表示と `set` の許可に使う |

### 存在確認（ctx.secrets.has）

`ctx.secrets.has(name)` → `Promise<{ ok, has: boolean }>`

金庫に名前の秘密があるかどうかを真偽値で確認する（どの層のプラグインも使用可）。値は返さない。

| 条件 | 戻り |
| :--- | :--- |
| `name` が文字列でない | `{ ok: false, error: 'bad-name' }` |
| 金庫にある | `{ ok: true, has: true }` |
| 金庫に無い | `{ ok: true, has: false }` |

### 秘密の保存（ctx.secrets.set）

`ctx.secrets.set(name, value)` → `Promise<{ ok: true } | { ok: false, error }>`

manifest の `secrets` に宣言した名前だけ保存できる。宣言の無い名前や文字列でない名前は `not-declared` で断られる。値はログや画面に出さず金庫にのみ書き込まれる。

| 条件 | 戻り |
| :--- | :--- |
| `name` が文字列でない、または manifest の `secrets` に宣言されていない | `{ ok: false, error: 'not-declared' }` |
| 金庫が利用できない | `{ ok: false, error: 'unavailable' }` |
| 保存成功 | `{ ok: true }` |
| 保存失敗 | `{ ok: false, error }` |

### AI に頼んで作るとき

AI にプラグインを作ってもらうときは、`ctx.secrets.get` で得た値（キー・トークン）をログ・画面・戻り値・エラー・チャットに出さないよう伝えてください。丸ストは出口で伏せますが、写した文字列や一部を切り出した値は伏せられません。ひな形（`npm run new-plugin`）が作る `AGENTS.md` が同じ約束を AI に伝えます。

---

## ⑤ プラグインの画面

### manifest

```json
"panels": [{ "name": "main", "title": "見本", "file": "ui/panel.html" }]
"actions": { "remember": "write" }
```

- `panels[].file` はプラグインフォルダからの相対パスで、`ui/` で始まり、拡張子は `html` / `js` / `css` / `svg` / `json` だけ。`..` は不可。
- `name` は `^[a-z][a-z0-9-]{0,31}$`。`title` は 1〜80 文字。
- `actions` は `{ "<名前>": "read" | "write" }`。名前は `^[A-Za-z][A-Za-z0-9]{0,40}$`。`emergency` は付けられない。配列にはしない。
- 壊れた項目は warn して捨て、プラグインは起動する。

### 配り方

`GET /plugins/<id>/ui/<ui の中の相対パス>`

例: manifest の `ui/panel.html` は `/plugins/sample-v2/ui/panel.html`。`panel.js` は同じ `ui/` に置けば `/plugins/sample-v2/ui/panel.js`。

- そのプラグインの `ui/` の外は 404。別プラグインのファイルも 404。拡張子が違うファイルも 404。
- Host ヘッダーは窓口の他と同じ（`127.0.0.1:18770` / `localhost:18770` 以外は 421）。
- パネル用 HTML の CSP（この文字列で固定）:

```text
default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self' data:; frame-ancestors 'self'
```

`connect-src 'none'` なので、パネルから窓口への fetch も WebSocket もできない。スクリプトは別ファイル（`script-src 'self'`。インラインは動かない）。

表示は W3 が `<iframe sandbox="allow-scripts">` で開く。`allow-same-origin` は付けない。

### postMessage

パネル → 本体:

```json
{ "type": "marust:call", "id": "1", "method": "timer.get", "params": {} }
```

- `id` は 1〜80 文字の文字列、または有限な数。
- `method` は 1〜120 文字。
- `params` はオブジェクト。省略時は `{}`。
- 知らないフィールドは無視する。

本体 → パネル:

```json
{ "type": "marust:result", "id": "1", "result": { "ok": true } }
{ "type": "marust:event", "name": "session.started", "payload": {} }
```

イベントは、そのプラグインの `subscribes` に合うものだけ。`payload` はイベントの payload であり、外側の封筒は付けない。

パネルが頼んでよい method（`host/layer1/panel-messages.js`）:

- 権限が `read` の method（`timer.get` など）。
- **自分の** `plugin.<自分の id>.<action>`（manifest の `read` / `write` のどちらか）。
- 他プラグインの action、`write` の本体 method、`emergency` は不可。拒否の返事は `{ type: "marust:result", id, result: { ok: false, error: "forbidden" } }`。

実際に `api.call` するときは、さらに**その画面クライアントの権限**を見る。パネルが write の action を頼んでも、クライアントが `write` を持っていなければ `forbidden`。W3 は `handlePanelCall(pluginId, message, permissionFor)` で形と許可を見てから、許可されたときだけ `api.call` し、`resultMessage(id, result)` を返す。イベントは `panelEventMessage(subscribes, name, payload)`（合わなければ `null`）。

iframe の生成は W3。Wave 0 は関数と配るところまで。

### actions

プラグインが export する:

```js
actions: {
  remember(params, ctx) {
    return { ok: true };
  }
}
```

manifest の `actions` にあり、かつ関数であるものだけ、`plugin.<id>.<名前>` として `api.call` の表に入る。第二引数は**プラグインの ctx**（窓口の呼び出し ctx ではない）。

| 呼び出し | 結果 |
| :--- | :--- |
| 宣言が `read` で、クライアントが `read` を持つ | 関数の戻り |
| 宣言が `write` で、クライアントが `write` を持つ | 関数の戻り |
| 権限が足りない | `{ ok: false, error: 'forbidden' }` |
| 宣言が無い、または関数が無い | 表に入らない（`unknown-method`） |

`ctx.permissions` を付けない `api.call` は、これまで通り read / write / emergency を全部持っているものとして扱う。

---

## 画面の差し込み口（V7。manifest の `ui`）

プラグインは manifest の `ui` で、本体の画面のどこに何を出すかを宣言する。形は `host/layer1/plugin-surface.js` の `normalizeUi` が検査し、おかしい項目は捨てて warn（プラグインは落とさない）。

| 口 | 中身 | 置かれる所 |
| :--- | :--- | :--- |
| `ui.panels` | 今の `panels` の別名（同じ名前は `panels` が先） | ドック |
| `ui.popup` | `[{ name, title, file }]`（名前 22 文字まで・10 個まで） | ドックの浮かせた窓（`openPopup`） |
| `ui.settings` | `{ title, file }` | ドックのパネル（`openSettings`） |
| `ui.menu` | `[{ label, method }]` か `[{ label, openPanel }]`（10 個まで）。`method` は `plugin.<自分の id>.*` だけ | メニューの「ツール」の下 |
| `ui.slots` | `[{ slot, title?, file }]`。穴は `home.top`・`home.siteCard.footer`（`UI_SLOTS`）。同じ穴を 2 つが使うときは、**登録簿の並びで後ろの方**を使い、画面に 1 行で知らせる（穴と持ち主の組ごとに 1 回） | ホームの決まった場所（iframe 1 つ。高さは `size`） |
| `ui.relay` | 窓の中継を許す method の並び（16 個まで） | 下の `marust:relay`。**内蔵と作者用だけ有効**（外から入れたものの宣言は無視） |

- ファイルは `ui/` の下。画面は sandbox の iframe（`allow-scripts` だけ）で、本体の DOM・金庫・トークンには触れない。外のブラウザは開けない（ポップアップの許可が無い）ので、説明ページへのリンクは本体のメニューに置く。
- 外から入れるプラグインの承認画面（`plugin.inspect`）には、`ui.slots` と `ui.menu` が「画面に出す場所」「メニューに足す」として出る。
- **切のあいだ**: `feature.activation` が `live` のプラグインが legacy（切）のあいだ、その画面・穴・メニューは一覧に出ず、開いていれば閉じる。

### 親との話し方（iframe → 親）

| メッセージ | 使い方 |
| :--- | :--- |
| `marust:call` | 読む API と、このプラグインの操作（`plugin.<id>.<名前>`）。書き込みは、操作（`actions`）で包む |
| `marust:relay` | `ui.relay` に書いた method だけを、**窓の端末として**親が呼ぶ。`windowOnly` の書き込み（`favorites.add` など）と、確認の門（`hub.fanout`）はここを通る（`confirmName`・`confirmed`・`allowedLiveIds`・`skipConfirm` は親が捨てる。`hub.fanout` が確認を求めたら、親が確認の窓を出して「はい」のときだけ親が確認の印を付けて呼び直す。iframe は何も付けられない）。操作で包むと `windowOnly` でなくなる（CLI・MCP からも呼べてしまう）ので、`windowOnly` のものは中継で通す |
| `marust:ui` `toast` | 文字だけの通知（親が `textContent` で出し、頭にプラグインの id を付ける） |
| `marust:ui` `confirm` | 親が確認の窓を出す（文字と 2 つのボタン。頭にプラグインの id が付く）。本番送信（`hub.fanout`）の確認はこれではなく、親が本体の文で出す |
| `marust:ui` `size` | 高さの申告（穴の iframe 用。ドックのパネルでは使わない） |

親 → iframe: `marust:result`・`marust:event`（購読した分）・`marust:event` `perm`（`{ read, write }`。見せ方だけ。本当の判定は本体）。各プラグインは `ui/bridge.js` に、この話し方をまとめた小さな橋（`window.marust.call / relay / toast / confirm / size / can / onPerm / onEvent`）を持つ（プラグインが単体で動くよう、共有せずコピー）。

例: `plugins/bulk-title`（題名。`hub.fanout` とお気に入りの書き込みは中継）・`plugins/comment-send`（コメント。送信は操作 `send`、`sites.setCommentSend` は中継）・`plugins/backup`（`settings.exportToFile`・`settings.import` は中継）。

---

## ⑥ オーバーレイ

### manifest

```json
"overlays": [
  { "name": "clock", "file": "overlay/clock.html", "fields": ["title", "note"] }
]
```

- `file` は `overlay/` 以下。拡張子はパネルと同じ。
- `fields` の名前は `^[A-Za-z][A-Za-z0-9]{0,40}$`。
- 名前に `key` `token` `secret` `password` `cookie` `auth` を**部分一致**で含む（大文字小文字を区別しない）項目が 1 つでもあれば、manifest 全体を拒否する。`status` は `skip`、`reason` は `forbidden-overlay-field`。起動しない。配らない。
- この判定は部分一致なので、`apiToken` も `monkey`（末尾が key）も拒否する。`title` / `note` / `remainingSec` / `mode` / `state` は通る。

### 配り方

| メソッドとパス | 中身 |
| :--- | :--- |
| `GET /overlay/<id>/<name>` | その overlay の HTML。認証なし |
| `GET /overlay/<id>/<name>/events` | SSE。認証なし |

- Host ヘッダーは他と同じ。
- `overlay/` の中の別ファイルは配らない。CSS と JS はその HTML に書く。
- オーバーレイ HTML の CSP:

```text
default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src http://127.0.0.1:18770 http://localhost:18770; img-src 'self' data:; frame-ancestors 'self'
```

`connect-src` に WebSocket は入れない。SSE（http）だけ。Cookie も WebSocket も使わない。

### 値

`ctx.overlay.publish(name, values)`:

- `name` が自分の overlay に無ければ `{ ok: false, error: 'unknown-overlay' }`。
- `fields` に無い項目は捨てる。
- 残してよいのは、200 文字までの文字列、有限な数値、真偽値だけ。オブジェクト・配列・`null`・長すぎる文字列は捨てる（切らない）。
- 受け付けた項目**だけ**が最新のスナップショットになる。前回の項目は残さない。毎回避す項目は全部入れる。
- 戻りは `{ ok: true, values: { ...受け付けたもの } }`。

SSE は `data: {"title":"..."}\n\n`。接続直後に最新のスナップショットを 1 回送る。まだ publish していなければ `{}`。その後の publish も同じ形で送る。

同時接続は **1 オーバーレイあたり 20**。21 本目は HTTP 429、`{ "ok": false, "error": "too-many" }`。切れた接続は枠を返す。

見られても困らない値だけを流す。キーや Cookie を fields に載せない（載せる名前は manifest の時点で拒否する）。

---

## ⑦ 配信エンジン（`stream.engine@1`）

`stream.engine` は OBS そのものではない。配信を実行するエンジンへの抽象的な口である。Core・画面・プラグインは OBS 固有の名前（vendor request 名、`obs-websocket`、シーン名など）を使わない。OBS の名前は `host/core/engine/obs-local.js` の中だけ。

今ある口（この Wave では関数を変えない）:

エンジン登録表 `host/core/engine/index.js`:

| 関数 | 意味 |
| :--- | :--- |
| `register(id, engine)` | id に実装を足す |
| `get(id)` / `list()` / `only()` | 取る |
| `emergencyStop(ctx)` | `capabilities().emergencyStop === true` のエンジンだけ `stopAll(ctx)` |

エンジン実装が持つ関数（今の `obs-local` が返しているもの）:

| 関数 | 意味 |
| :--- | :--- |
| `capabilities()` | `{ createTarget, setKey, perTargetQuality, emergencyStop, write }` |
| `listTargets()` | 出力の一覧 |
| `status()` | 接続と要約。中に `capabilities` を含む |
| `start(targetId)` | 出力を 1 つ開始 |
| `stop(targetId)` | 出力を 1 つ停止 |
| `stopAll(ctx)` | 全出力を止める（全部止める）。`ctx.correlationId` を載せてよい |
| `setEnabled(targetId, enabled)` | 有効 / 無効 |
| `setKey(targetId, settings, flags)` | `settings` は `{ server?, key? }`。`flags.restartIfActive` |
| `create(input)` | 出力を作る。`{ name, protocol, server, key }`。作った直後は無効 |
| `remove(targetId)` | 出力を消す |
| `linkDestination(input)` | marust の配信先とエンジンの出力を結ぶ。`{ destinationId, targetId, site?, accountId? }` |
| `unlinkDestination(destinationId)` | その結びつきを外す |

ARCHITECTURE の役割表にある `upsertTarget` は、今の実装では 1 関数にはなっていない。作成は `create`、有効化は `setEnabled`、キーは `setKey`。Wave 0 では足さない。

画面の method 名（`engine.start` など）は上の関数を `host/layer1/api.js` が包んだものである。プラグインは画面の method 名をエンジンの関数名と混同しない。

接続の開始（`connect`）や再同期は、この役割の操作ではなく、プロセス起動時の配線である。プラグインからは呼ばない。

---

## 口の宣言（`needs`。計画 C・D9・C5）

`needs` の門は通常の読み込みで渡す `makeCtx` の口が対象。manifest の `boot` は別契約で、`createBootContext` が起動用の modes・settings・markers・rows・announce などだけを渡す。セットだけが通常の load より前に一度実行でき、自分で足したプラグインの boot は実行しない。段階・モードから独立したモードの提供と移しかえのため、通常の `needs` は当てない。詳しくは `HANDOFF-DEV.md` §2 と `host/layer1/boot-context.js`。

プラグインは使う口を、今までどおり manifest の `needs` に名前で書く（能力の名前と同じ並び。別の欄は作らない）。名前は核の `CTX_PORT_NAMES`（`host/layer1/registry/ctx-ports.js`）とこの表で同じ。

`coreApi` が 2 のプラグインは、宣言した口だけに触れる。宣言の無い口に触ると `needs に "<名前>" がありません`（`code` は `needs-missing`）。自分のことを読むだけの口（`id`・`pluginDir`・`manifest`・`logger`・`redact`・`events.names`・`app`・`mode`）と `log` は宣言なしで常に渡る。書いていない・`coreApi` が 1 のプラグインは今までどおり口が渡り、宣言の無い口を使ったときだけ警告が 1 回出る（`needs-undeclared`）。宣言してあっても、核が渡す条件（`obs.read` と `obsRead`、`obs.streamControl` と `obsControl`、`keys` はセットのうち最初の 1 つ、`api` 欄、`external.open`、`chat.inlet@1`）が揃わなければ、その口は `undefined` で、`needs` のエラーにはならない。

`ctx.bus` と `ctx.api` と `ctx.obs` はメソッドごとの名前で断る（`events.emit` は `ctx.bus.publish`、`events.subscribe` は `ctx.bus.subscribe`、`api.register` と `api.call` も同様。`ctx.obs.getStreamStatus` と `ctx.obs.isStreaming` は `obs.read`、`ctx.obs.streamControl` は `obs.streamControl`）。`ctx.ui` を取るには `ui.panel`。

<!-- c5-ports -->
| 名前 | ctx の口 | 何ができるか |
| :--- | :--- | :--- |
| `id` | `ctx.id` | 自分の id。常に渡す |
| `core` | `ctx.core` | 互換のために残す核のオブジェクト |
| `pluginDir` | `ctx.pluginDir` | 自分のプラグインフォルダ。常に渡す |
| `manifest` | `ctx.manifest` | manifest の読み取り専用の写し。常に渡す |
| `storage` | `ctx.dataDir` | 自分のデータの置き場。ファイルを読む・書く |
| `logger` | `ctx.logger` | ログを 1 行出す。常に渡す |
| `redact` | `ctx.redact` | 秘密らしい文字列を伏せる。常に渡す |
| `log` | `ctx.log` | 日付ごとの JSONL 追記。宣言なしで常に渡す |
| `audit` | `ctx.audit` | 監査の行の形と、核の記録への追記 |
| `events.names` | `ctx.events` | イベント名の一覧。常に渡す |
| `app` | `ctx.app` | 丸ストの版と配布ページ（読むだけ）。常に渡す |
| `emit` | `ctx.emit` | 登録簿の中の配列に積む。バスには流さない |
| `mode` | `ctx.mode` | 今のモード（legacy / shadow / live）。常に渡す |
| `events.emit` | `ctx.bus.publish` | 合図をバスへ出す |
| `events.subscribe` | `ctx.bus.subscribe` | 合図をバスから受ける |
| `sessions` | `ctx.sessions` | 配信セッションの閲覧と操作 |
| `secrets` | `ctx.secrets` | 秘密の取得・有無・保存 |
| `overlay` | `ctx.overlay` | オーバーレイへ値を出す |
| `chat` | `ctx.chat` | コメントの取り込みと入り口の宣言 |
| `destinations` | `ctx.destinations` | 配信先の一覧と集計 |
| `obs.read` | `ctx.obs.getStreamStatus` / `ctx.obs.isStreaming` | OBS の配信状態を読む |
| `obs.streamControl` | `ctx.obs.streamControl` | 配信全体の開始・停止 |
| `api.register` | `ctx.api.register` | 窓口にメソッドを足す |
| `api.call` | `ctx.api.call` | 窓口のメソッドを呼ぶ |
| `peers` | `ctx.peers` | ほかのプラグインの決まったメソッド |
| `external.open` | `ctx.external` | ブラウザで https の URL を開く |
| `pluginStates` | `ctx.pluginStates` | ほかのプラグインが動いているかとモード |
| `keys` | `ctx.keys` | キー割り当ての読み書き |
| `ui.panel` | `ctx.ui.panel` | 画面のパネルを 1 枚足す |
<!-- /c5-ports -->

汎用の口は 6 つ。読むと書くは `storage`（`ctx.dataDir`。自分の置き場のファイルを読む・書く。別のファイル口は足していない）。合図を受けるは `events.subscribe`。合図を出すは `events.emit`。画面を足すは `ui.panel`（この段で足した口。`ctx.ui.panel(spec)` が生きている manifest の `panels` に 1 枚足す。おかしい形は `{ ok: false, error: 'bad-panel' }`、同じ名前は `'taken'`）。窓口にメソッドを足すは `api.register`。

## つなぎ口の版（`coreApi`。計画 C・D2）

核は「つなぎ口の版」`PLUGIN_API_VERSION`（整数。いまは 2。`host/layer1/registry/manifest.js`）を持つ。読める一番古い版は `PLUGIN_API_MIN`（いまは 1）。プラグインは manifest に要る版を `"coreApi": 2` のように書く。
- 書いていなければ 1 とみなす（口は今までどおり渡り、宣言の無い口は警告）。
- `coreApi` が 2 のときだけ、宣言した口以外を断る。
- 核より大きい数を書いたものは読み込まない: skip `core-api-too-new`。`PLUGIN_API_MIN` より小さい整数は skip `core-api-too-old`。整数でない・1 未満は skip `bad-core-api`。どれもログ（`skip <出どころ>/<id> <理由> coreApi=<値>`）と `plugins.list` の `reason` に出る。
- 核の版を上げるのは、今の口を壊す変更のときだけ。足すだけなら上げない。

## 外から入れるプラグインの制限

`<STATE_DIR>/plugins/<id>/` に置かれたもの（出どころ `user`。丸ストの画面から入れたものも、手でフォルダに置いたものも同じ）には、安全のための確かめがかかる（PLAN-plugin-core §7.3、L8d で出どころ別・力別の線引きを撤廃。ADR 0006）。**これは閉じ込める仕組みではない**。外部のコードは丸ストと同じ力で動く。三層目（外から入れたものを含む）の制限は「配信を始められない（layer3-no-start）」「全部止めるを邪魔できない（stopping）」「秘密は事故防止（L8a/L8b/L8f）」の原則に従う。

| 項目 | 外部での扱い | 破ったとき |
| :--- | :--- | :--- |
| manifest の版 | `manifestVersion: 2`・`runtime: "inproc"` だけ（v1 は受けない） | registry は skip `v1-not-allowed`、installer は `bad-manifest` |
| id | `^[a-z][a-z0-9-]{1,31}$`。`site-`/`sink-`/`slot-`/`chat-` で始まるもの・`default`・`obs-engine`・`sites` は使えない（installer と registry で同じ規則） | registry は skip `reserved-id`、installer は `bad-id` |
| セットと同じ id | セットが勝つ | registry は `id-collision-skipped`、installer は `id-reserved` |
| `ctx.core` | **渡す**（L8d で出どころ制限解除。全プラグインに同じ力を渡す） | - |
| `dataDirId` | 使えない（`ctx.dataDir` は必ず自分の id の置き場） | 黙って消す |
| `provides` | `session.controller@1`（タイマーの開始・終了）と `chat.source@1`（コメントの入り口）は申告できない。`stream.site@1`・`stream.lifecycle@1` は申告できる（モードと本人の id 入力で守る） | registry は落とすだけ、installer は `provides-not-allowed` |
| `needs` | `obs.streamControl`（配信全体の開始・停止）は渡る（L8d で制限解除）。ただし三層目は開始不可（`layer3-no-start`）、停止は可能。全部止めるの最中は開始不可（`stopping`） | start 呼び出し時に `layer3-no-start` または `stopping` |
| `secrets` | 名前の形（`[a-z0-9.-]`・80 文字まで）だけ。L8g: `ext.<id>.` の縛りは外した（`twitch.oauth` なども宣言できる）。`vault-store@1` の申告は引き続き不可 | 形が違えば registry は skip `secret-namespace`、installer も `secret-namespace` |
| `defaultMode` | 常に `legacy`。全体の既定・fanout ファイルにも従わない | 黙って `legacy` |
| サイトの形（`plugins/sites/`・`roles`） | 外部では読まない | installer は `site-format-not-allowed` |
| `main` | フォルダの中だけ（realpath で確かめる） | skip `main-escape` |
| 動かす | `legacy` のあいだは `require` も `load`/`start` もしない。shadow／live にできるのは `modes.set` で本人が id を入力したときだけ（`skipConfirm`・`confirmLive:false`・一括・ほかの API が自動で入れる確認は効かない） | `confirm-name`、ほかの API からは `external-needs-modes-set` |
| 入れる・更新・戻す・消す | 配信中は全部断る。live のあいだは更新・戻す・消すを断る。ファイルを動かす前に `legacy` を書き、書けなければ止める。入れるのは `inspect` で見せたのと同じ中身だけ（`install(source, { expectSha256 })`） | `streaming`・`live`・`mode-write-failed`・`changed-since-inspect`・`expect-sha256-required` |
| 版（`version`） | 英数字で始まり英数字で終わる（`1.` は不可） | `bad-version` |

丸ストの画面（上級 → プラグインの管理 → 作る）からも、同じ形のひな形を `<STATE_DIR>/plugins/<id>/` に作れる（`plugin.create`。すでにある id は何も書かずに断る・配信中は断る・作ったあとも legacy）。「AI に渡す依頼文をコピー」は上の表の要点を含む。案内は `plugins/ui-standard/shell/guide/make-plugin.html`。

## ⑧ 統合の決まり

Wave 1 の 4 体は、次の共有ファイルを編集しない。

- `package.json`
- `electron-main.js`
- `main.js`
- `plugins/ui-standard/shell/hub.js`
- `host/layer1/api.js`
- `host/layer1/gateway.js`
- `host/layer1/plugin-registry.js`

足したい配線は `docs/history/integration-notes/<担当>.md` に書く。実装は書かない。Claude が Wave 2 でつなぐ。

| 担当 | メモ | 触ってよい場所 |
| :--- | :--- | :--- |
| W1 | `docs/history/integration-notes/W1-timer.md` | `plugins/timer/`、`test/timer-*.test.js` |
| W2 | `docs/history/integration-notes/W2-gcal.md` | `plugins/gcal/`、`test/gcal-*.test.js` |
| W3 | `docs/history/integration-notes/W3-plugin-ui.md` | `host/layer1/panel-messages.js`、`ui/plugin-host.js`、`test/plugin-ui-*.test.js` |
| W4 | `docs/history/integration-notes/W4-vault.md` | `host/core/vault*.js`、`test/vault-*.test.js` |

W3 が使う関数は `handlePanelCall` / `resultMessage` / `panelEventMessage`（`host/layer1/panel-messages.js`）。配る経路は gateway がすでにある。ドックへの iframe 追加は `plugins/ui-standard/shell/hub.js` を触らずメモに書く。

W4 が満たす口は ④ の `get({ pluginId, name })`。`createRegistry({ secrets })` に渡す、とメモに書く。

実 OBS、本物の Google、既存 Cookie ファイルには触らない。`git commit` / `git push` はしない。

---

## manifest v2 の完全な例

`plugins-author/sample-v2/manifest.json` と同じもの。

```json
{
  "id": "sample-v2",
  "name": "見本 v2",
  "version": "0.1.0",
  "manifestVersion": 2,
  "runtime": "inproc",
  "main": "index.js",
  "kind": "ui",
  "provides": ["ui.panel@1"],
  "subscribes": ["session.*"],
  "secrets": ["sample.token"],
  "actions": { "remember": "write" },
  "panels": [{ "name": "main", "title": "見本", "file": "ui/panel.html" }],
  "overlays": [{ "name": "clock", "file": "overlay/clock.html", "fields": ["title", "note"] }],
  "requires": ["session.controller@1"],
  "defaultMode": "legacy"
}
```

`requires` は今は形のチェックと一覧表示だけ。満たしていなくても起動する。`defaultMode` は提案であり、`ctx.mode()` はモードファイルの実効値が優先する。

## 画面の本体役 shell（計画 C・C3）

ひとつしか持てない役。manifest は `manifestVersion: 2`、`kind: "shell"`、`coreApi: 2`。ホスト側の `main` と `ctx` は持たない。`shell` 欄に次を書く。

- `label`: 画面に出す名前。
- `scripts`: 必須。`shell/` の中の相対パスを、書いた順に実行する。
- `styles`: 同じ場所の CSS。
- `layout`: 既定の配置の JSON。
- `template`: 任意の HTML の断片。

各ファイルはプラグイン直下の `shell/` の中の相対パス。配る経路は `/plugins/<id>/shell/`（`/plugin/` も同じ）。絶対パス、`..`、決めた拡張子でないもの、フォルダの外の実ファイルは拒む。

核は `template` を `#shell-root` に置き、`styles` を読み、`scripts` を順番に読む。画面が初期化できたら `window.marustShell.ready()` を呼ぶ。非同期の初期化は、その完了のあとで `ready()` を呼ぶ。失敗したら `window.marustShell.fail()` を呼ぶ。`ready` の前の未処理の例外、資源の失敗、15 秒以内に `ready` を呼ばない場合も失敗。失敗すると、最初からページを読み直し、古い DOM・タイマー・購読を捨て、失敗した shell を一時的に外してセットの shell に戻る。セットの shell も読めなければ、核の最低限の表示（状態・全部止める・立ち上げ直す）を残す。

選び方（`host/layer1/shell-pick.js`）:

- `ui.getShell` は、選んでいる画面・一覧・理由を返す。`ui.setShell({ id })` で選ぶ（ウィンドウだけ。空の id はセットの既定）。
- 明示で選んだ id が読み込めていれば、出どころがセットでも自分で足したものでもそれを使う。
- 何も選んでいないとき、選んだものが無い・読めない・消えたときは、セットの shell に戻る（`isDefault` があればそれ、無ければ id が若いもの）。自分で足した shell は、明示で選んだときだけ使う。
- 失敗しても、保存した選択は消さない。`plugin reload` か `ui reload` で除外を消してやり直す。読み直しは開発者モードだけ。
- 核の `ui.restart` はウィンドウだけの再起動。開発者用の `app.restart` の認可は変えない。
