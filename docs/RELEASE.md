# 配り方（v1）

> 2026-10-15 ユーザー確認済み: 公開先は `orangeqoon/marust`、新しい履歴、本体 MIT・改造 OBS プラグイン GPL-2.0 の別配布。署名・winget・YouTube/Twitch 公開アプリ登録は v1 のあと。一般公開そのものの許可は §6-6 のとおり別に確認する。

## 1. 置き場: GitHub Releases に zip を 1 つ
1. `streaming/marust` で `npm run build`（**配る版**）。`dist/marust-win32-x64/` ができる。**exe の中（`resources/app`）は核だけ**で、プラグインのセットは **exe の横の `plugins/`**（`dist/marust-win32-x64/plugins/`）に置かれる（`node cli/pack-plugins.js --set` が最後に作る。`plugins-author/`・みんなのプラグインは入らない）。
2. 作者の日常は全入り版を `cli/start-author.cmd`（`MARUST_SET_DIR` で `plugins-author` を足す）で起動する。作者用の配り物（`build:author`・`dist-author`）は無い。
3. `dist/marust-win32-x64` を `marust-<版>-win32-x64.zip` に固める。中身:
   - `marust.exe` ほかアプリ一式と、その横の `plugins/`（セット）
   - OBS 用の改造プラグイン（`obs-multi-rtmp.dll` と `data\locale` の 2 つ）は**別の zip**（`marust-obs-plugin-<版>.zip`）。アプリの zip には混ぜない（丸ストが OBS に自動で入れない決まりのため。`plugins/ui-standard/shell/guide/obs-plugin.html` が入れ方を案内する）。
4. Release の本文には、版・変更点・次の「SmartScreen の案内」を載せる。タグは `v0.2.0` の形（「更新を確かめる」が読む）。

## 1.5 更新の手順（計画 C・C2-4。2026-10-14）
核（exe）は変わらないもの、セット（`plugins/`）は変わりやすいもの。更新は 2 通り:
- **セットだけ変わった更新**: 新しい版の `plugins/` を、利用者の exe の横の `plugins/` と**まるごと入れ替えて**、丸ストを立ち上げ直す。exe はそのまま。入れ替えるとき古い `plugins/` は消してから置く（古いプラグインが残らないように）。置く中身は `node cli/pack-plugins.js --set <出力フォルダ>` で作れる。
- **核が変わった更新**（つなぎ口の版 `PLUGIN_API_VERSION` が上がった・`host/`・入口・トレイが変わった）: exe ごと配る（zip を丸ごと入れ替え）。核が変わる更新なのに**セットだけ**入れ替えると、新しい口を要るプラグイン（`coreApi` が核の版より大きいもの）は読み込まれず、ログと `plugins.list` の `reason`（`core-api-too-new`）に出る。
- 自動の差し替えは作らない。利用者が「更新を確かめる」→ Release のページを開く → 自分で入れ替える（§3）。配る版の中身（`plugins/`）を起動時に確かめる仕組みも作らない（ADR 0007）。
- `plugins/` を消した・壊したときは、丸ストは**核だけで起動**する（プラグインの行が空になる。リポジトリの置き場は探しに行かない）。入れ直して立ち上げ直せば戻る。
- 利用者が足したもの（`<STATE_DIR>/plugins`）は更新の対象外（そのまま残る）。同じ id がセットにあればセットが勝つ。

## 2. 署名なしで配る（SmartScreen の案内）
署名していない exe は、初めて動かすとき Windows が「WindowsによってPCが保護されました」と出すことがある。README と Release の本文に次を書く:
- 「詳細情報」→「実行」で起動できる。
- zip を右クリック →「プロパティ」→「ブロックの解除」にチェック、でも出なくなる。
- 配布元は Release のページだけ。ほかの場所で拾った exe は使わない。
- 署名の購入は v1 のあとに作者が判断する。

## 3. ヘルプ「更新を確かめる」
- 押したときだけ、`https://api.github.com/repos/<owner>/<repo>/releases/latest` を 1 回読む（`host/update-check.js`・API `update.check`）。**自動ではつながない**。送るのは User-Agent と Accept だけ。
- 読む先は `package.json` の **`marustReleasesRepo`**（`"owner/repo"`）。**`orangeqoon/marust`**（2026-10-15 確定）。公開前は GitHub にページがまだ無いため、更新を取得できない。
- 新しい版があれば確認のあと、使っているブラウザで Release のページを開く。丸ストが自分で入れ替えることはしない。

## 4. 確定した公開方針（2026-10-15 ユーザー承認）
| 項目 | 状態 |
| :--- | :--- |
| 公開リポジトリの名前（`marustReleasesRepo`） | `orangeqoon/marust`。新しい履歴で用意 |
| 署名（コード署名証明書） | v1 のあと |
| winget への登録 | v1 のあと |
| YouTube・Twitch の公開アプリ登録 | v1 のあと |
| 本体／OBS プラグインのライセンス | MIT／GPL-2.0。OBS の zip と対応ソースは別に配る |

## 5. 出す前の確認
`npm run check`・`npm test`・`test:e2e`・`test:security` が通る → `npm run build` → `dist/marust-win32-x64/resources/app` に `plugins/`・`plugins-author/` が無く、横の `plugins/` にセットがある・`README.en.md`・`plugins/sites/*/lib/oauth.js`・`host/tips.js`・`host/update-check.js` がある → 配る版の exe を**別の PC（または `MARUST_STATE` を別にした）で起動**して、はじめの案内が出ることを見る。

## 6. 公開リポジトリへの書き出し（N4。まだ公開していない）
1. 先に `streaming/marust` の変更を**コミットしておく**（書き出しは作業ツリーのファイルをコピーするため、追跡中のファイルに未コミットの変更があると断る）。
2. `npm run export:public -- <空のフォルダ>`（`cli/export-public.js`）。**git が追跡しているものだけ**を許可リスト（`allowed`）に通して書き出す。履歴は持ち出さない。入れないもの: `plugins-author/`・`docs/history/`・`docs/reviews/`・引き継ぎや計画の文書・`AGENTS.md`/`CLAUDE.md`（どの階層でも）・秘密になりうる名前（`.env`・cookie・token・認証情報・`*.pem` など）・公開リポジトリだけでは動かない試験（`EXPORT_SKIP_TESTS` に名前で列挙）。`README.md`・`README.en.md`・`LICENSE`・`.gitignore` は `docs/public/` のものを置き、`package.json` は公開用（MIT・作者の PC 用の試験の入口なし）に直す。
3. 書き出しの最後に**秘密・作者のパスの検査**が走る（作者の絶対パス・各種トークン・秘密鍵・webhook・作者のメール。バイナリ以外の全ファイル）。1 件でもあれば直してからやり直す。あとから単独で: `node cli/export-public.js --scan <フォルダ>`。
4. 書き出したフォルダで `npm install` → `npm test`・`npm run check` が通ることを確かめる（このリポジトリでは `NODE_PATH` で本体の `node_modules` を指して試す。クリーンな clone で足りないファイルを見つける大事な手順。`plugins/sites/*/lib/oauth.js` が git の無視に落ちていたのはこれで見つかった）。
5. **公開の直前に、書き出したフォルダで `git init && git add -A && git status` を見て、意図しないファイルが無いことを人の目で 1 回見る。**
6. **公開（新しい git リポジトリを作って push）は、ユーザーが「公開してよい」と言ってから。**公開したら `package.json` の `marustReleasesRepo` に `owner/repo`、`plugins/ui-standard/shell/guide/obs-plugin.html` の配布場所の URL を入れる。
7. ライセンス（`docs/public/LICENSE` は MIT）・リポジトリ名・「履歴を出さない」は 2026-10-15 にユーザーが承認済み。改造 OBS プラグイン（GPL-2.0）は別に配る。ブラウザ拡張（`browser_extensions/marust_extension`）とわんコメの橋（`onecomme_plugins/onecomme-plugin-marust`）は `streaming/marust` の外にあるため、この書き出しには入らない（公開するかはユーザーが決める）。
