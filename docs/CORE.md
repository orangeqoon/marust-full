# 丸ストの 3 つの単位と 4 つの層

丸ストは「変わらない核」と「全部プラグイン」でできています。システムは 3 つの単位（OBS の部品・エンジンをつなぐもの・核）からなり、フォルダと対応します。機能を作る・直す人は、**自分のプラグインのフォルダ 1 つ**を見れば足ります。核やエンジンを直す人だけ、下の表の該当する単位を見てください。

```
 ┌────────────────────────────────────────────────────────────────────┐
 │ 単位 3  核（丸ストの根もと）          host/core/                    │
 │   配信エンジンと複数のサイトをつなぐ分かれ道。配信先ごとの         │
 │   開始・停止、全部出す・全部止める、送信中・金庫・イベントバス     │
 ├───────────────────────────▲────────────────────────────────────────┤
 │ 単位 2  エンジンをつなぐもの          host/core/engine/             │
 │   配信先の作成・開始・停止・送信中。OBS の部品との橋               │
 ├───────────────────────────▼────────────────────────────────────────┤
 │ 単位 1  OBS のプラグインの部分      streaming/obs-multi-rtmp/       │
 │   元の obs-multi-rtmp ＋ 薄い口（別リポジトリ。GPL-2.0）           │
 └────────────────────────────────────────────────────────────────────┘
        ▲ 挿す口（ctx・役割・イベント）
        │
   host/layer1/・ui/    核の土台（窓口・承認・プラグイン登録・画面の枠）
   plugins/            一層目・二層目・三層目のセット（exe の横）
   二層目・三層目       管理・改善（host/layer1/plugin-layers.json で決まる）
   marust-plugins/      みんなのプラグイン（便利にするもの。一覧）
```

## 4 つの層と 3 つの単位

丸ストは、変わらない核と、セットの中の分類である一層目・二層目・三層目からできています（[ADR 0007](../adr/0007-core-is-what-does-not-change.md)）。ビルドするのは核だけ。セットは exe の横の `plugins/` に置きます。このうち「核」の層がエンジンをつなぐもの（単位 2）と根もとの核（単位 3）から成り、OBS 側の部品（単位 1）と連携して配信を動かします。プラグインが何層目になるかはフォルダではなく `host/layer1/plugin-layers.json` の一覧で決まります。

| 単位・層 | 場所 | 中身 |
| :--- | :--- | :--- |
| 1 OBS のプラグインの部分 | `obs-multi-rtmp/`（隣の別リポジトリ） | 元の obs-multi-rtmp に、WebSocket の口・スナップショット・「全部止める」ドックを**新しいファイル**で足したもの。元のファイルへの変更は 60 行以内（※OBS 側の部品であり丸ストの核ではありません） |
| 2 エンジンをつなぐもの | `host/core/engine/` | `index.js`（エンジン登録表）・`obs-local.js`（OBS ローカルのエンジン）・`obs-connection.js`（OBS WebSocket の接続）・`obs-stream-control.js`・`observed-bridge.js`・`broadcast.js`・`emergency-button.js`・`preflight.js` |
| 3 核（丸ストの根もと） | `host/core/` | `state-store.js`（状態保存）・`events.js`・`event-bus.js`・`safe-runner.js`・`vault.js`（金庫）・`secret-provider.js`・`log-writer.js`・`core-bridge.js` ほか |
| 核の土台（単位 3 に含む） | `host/layer1/`・`ui/`・起動の `electron-main.js` | `gateway/`（窓口）・`api/`・`plugin-registry.js`（読み込み）・`clients.js`・`approvals.js`・`audit.js`・ペアリング・画面の枠と最低限の表示。フォルダ名は残すが、一層目のプラグインではない |
| （一層目: 基本） | `plugins/ui-standard/`・`plugins/sites/*`・テーマ・`update-check` | `ui-standard/shell/` が画面の本体役（初回の画面・パネル・メニュー・ガイド・言葉）。サイトの名簿や更新の確認もプラグイン |
| （二層目: 管理） | `host/layer1/plugin-layers.json` の `layer2` | サイトへ書きにいく管理のプラグイン（`backup`・`bulk-title`・`chat-inlet`・`comment-send`・`hotkeys`・`kukulu-port`・`kukulu-sleep`・`set-youtube`・`site-login`・`uplink-estimate`） |
| （三層目: 改善） | 一覧に無いセット・`plugins-author/`・自分で足したプラグイン | 層の一覧に無いセットのプラグイン（`ai-connect`・`session`・`diagnostics`・`notify-discord`・`signal-monitor` など）、自分で足したプラグイン（`<STATE_DIR>/plugins`）。隣の `marust-plugins/plugins/` はソース起動・作者版ではセットとして読む。作者用プラグイン（`plugins-author/`。`author-modes`、コメント受信 `chat-*` など） |

## 改造するときに見る場所
- **機能（配信先・題名・コメントなど）**: `plugins/<id>/` か、みんなのプラグインの `plugins/<id>/`。manifest の名乗り（`category`・`for`・`tags`・`tier`）で一覧に集まります。作り方は `PLUGIN-API.md`。
- **別のエンジンに替える**: 単位 2 だけ（`host/core/engine/`）。プラグインは `ctx.engine` の口しか見ません。
- **核・金庫を直す**: 単位 3（`host/core/`）。秘密と門に触る所なので、直したら `npm run test:security` を通してください。
- **窓口・API・画面の枠を直す**: 核の土台（`host/layer1/`・`ui/`）。
- **パネル・初回の画面・メニュー・ガイドを直す**: セットの画面の本体役（`plugins/ui-standard/shell/`）。

## 守っていること（試験が数で見張る）
- 核はプラグインの名前を知らない。プラグインは名乗る（`test/fixtures/core-boundary.json` の `x`）。
- プラグイン同士は直接 `require` しない。つながりは役割（`stream.slot@1` など）とイベントだけ。
- 約束は `types/plugin-api.d.ts` と `PLUGIN-API.md` の 1 か所。役割ごとの約束の試験（`test/contracts/`）に通れば、同じ役割の別のプラグインに差し替えられる。
- 内蔵を 1 つ抜いても、本体とほかのプラグインの試験が通る。

