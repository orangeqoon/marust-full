# marust コマンド

`marust.cmd` は、このフォルダの `marust.js` を `node` で起動する。スクリプトの場所は `%~dp0`（この cmd ファイル自身のフォルダ）から決める。ファイルの中に絶対パスは書いていない。

動かす前に、marust の窓口が起動していて、一度ペアリングしてあること。Node は PATH から見つかること。

```text
marust.cmd pair
```

引数は `node marust.js` と同じ。`go` / `halt` / `emergency-stop` は `--yes` が無いと実行しない。

# 汎用の呼び出し（`call`）

```text
marust.cmd call <メソッド名> [JSON か key=値 ...]
marust.cmd call hub.getState
marust.cmd call destination.start id=youtube-main
marust.cmd call plugin.logs '{"id":"demo","n":20}'
```

窓口のメソッドを名前で呼ぶ。プラグインが足したメソッドも CLI を直さずに呼べる（名前は `describe` で見る）。CLI は名前を調べず、知らない名前は窓口が断る。結果は常に JSON で 1 行に出る。`key=値` の値は、JSON として読めれば数・真偽・配列など、読めなければ文字列。承認が要るものは、ほかのコマンドと同じく丸ストのウィンドウで承認する。

# Stream Deck

専用プラグインは無い。Stream Deck の「システム」→「開く」を使う。

- アプリ / ファイル: `marust.cmd`。Stream Deck の画面で、このリポジトリの `cli/marust.cmd` を選ぶ。選んだパスは Stream Deck 側の設定にだけ残る。
- 引数: 下の例を、ボタンごとに 1 つ入れる。

```text
go youtube-main --title "朝の配信" --yes
go youtube-main twitch-main --title "朝の配信" --category "Just Chatting" --yes
halt youtube-main --yes
emergency-stop --yes
session pause
session resume
start youtube-main
stop youtube-main
preflight youtube-main
status
```

Stream Deck の作業フォルダが `cli/` でなくても、cmd が自分の隣の `marust.js` を起動する。

# code-map（関数の地図）

`node cli/code-map.js <ファイルかフォルダ> [--min n] [--depth n] [--big [n]] [--json] [--all]`（`npm run map -- <ファイル>`）。大きい .js の関数・クラス・メソッドを「開始行-終了行」つきで一覧にする。丸ごと読む前に場所を見るための開発用の道具で、Node の標準だけで動く（自前の字句解析のため、取りこぼす書き方はファイル先頭のコメントに書いてある）。
