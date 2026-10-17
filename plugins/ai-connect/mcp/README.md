# marust の MCP サーバー

AI のクライアント（Claude Code など）が stdio で起動する窓口です。marust には、この PC の native 利用者として WebSocket でつなぎます。書き込みは、marust のウィンドウで人が承認するまで実行しません。

プロトコルは JSON-RPC 2.0 を 1 行に 1 メッセージです。`initialize`、`tools/list`、`tools/call` に答えます。ログは stderr だけに出し、stdout には MCP のメッセージ以外を書きません。

## Claude Code への登録

marust のフォルダ（この `mcp` の一つ上）で実行します。パスは、そのフォルダから見た相対です。

```
claude mcp add marust -- node ./mcp/server.js
```

別の作業フォルダから登録するときは、`./mcp/server.js` を、そのフォルダから見た相対パスに読み替えます。絶対パスは書きません。

## ペアリング

1. marust のウィンドウを開きます。ブラウザのタブでは「AI（MCP）をつなぐ」は出ません（接続端末の管理はウィンドウ専用です）。
2. 「接続端末」で「AI（MCP）をつなぐ」を押します。6 桁のコードが出ます。権限は read と write だけで、承認が必須です。非常停止は付きません。
3. marust のフォルダで `node plugins/ai-connect/mcp/server.js pair` を実行し、コードを入れます。引数で渡すときは `node plugins/ai-connect/mcp/server.js pair 123456` です。
4. トークンは `state/services/marust-mcp.json` に保存されます。画面にも、ログにも、コマンドの出力にも出ません。

つなぐ先は `ws://127.0.0.1:18770/ws` です。Origin は付けず、`Authorization: Bearer` だけを送ります。待ち受けポートを変えて試すときは `--port` か環境変数 `MARUST_MCP_PORT` です。Host は許可リストに合わせ、`127.0.0.1:18770` のままです。

まだペアリングしていないときは、道具の代わりに `node plugins/ai-connect/mcp/server.js pair でペアリングしてください` と返します。

## できること

- 状態の読み取り（配信先、セッション、エンジンの状態、承認待ちの一覧、配信前チェックなど）
- 書き込み（配信先の開始と停止、セッション、レイアウトなど）。呼ぶと承認待ちになり、marust のウィンドウで承認・却下・期限切れ（最大 2 分）になってから結果が返ります。結果の文には「marust のウィンドウで承認待ち」と、承認された・却下された・期限切れのどれかを入れます

道具の名前は `marust_` に、メソッド名の `.` を `_` にしたものです。引数の形は `api.describe` の params から作ります。説明は日本語と英語の 1 行で、書き込みには「承認待ちになります」と書きます。一覧は起動時と 60 秒ごとに取り直します。

## できないこと

- 非常停止（`engine.emergencyStop`）。権限にも入れていません
- 秘密（`secrets.*`）
- 端末の管理（`clients.*`）
- 承認の承認と却下（`approval.approve` / `approval.deny`）
- 配信キーの差し替え（`engine.setKey`）
- ウィンドウ専用の操作
- LAN への公開

AI からこれらの名前で呼んでも、marust には送らず断りです。
