# marust 全入り版

標準・開発用・communityプラグインを同梱する構成です。開発機能は初回に有効になります。

## ダウンロードと起動

1. [Releases](https://github.com/orangeqoon/marust-full/releases) から `marust-full-0.2.6.zip` をダウンロードして展開します。
2. `start-full.cmd` を実行するか、`marust.exe` を直接起動します。
3. 初回設定は通常のMarustユーザーstateへ保存されます。最小版と全入り版は同じstateを使い、既存設定は各版の初期値より優先されます。配布物にユーザーstateや認証情報は含みません。

## 初回設定

- `devMode=true`, `uiLevel=advanced` を初回のみ既定値として適用します。既存設定があれば保持します。
- 開発向け機能の表示・読み込みは初期状態で有効です。配信先のlive modeや権限・認証情報を自動で有効化しません。
- OBS Multi-RTMP、ブラウザ拡張、わんコメ連携は別配布です。

## ソース

このリポジトリは丸スト 全入り版 のソースです。収録プラグイン: 37 件。アプリの更新・機能一覧リンクはこのリポジトリを参照します。

## 検証上の注意

`npm run check` とセキュリティ試験、edition defaults / x0 / x5 のfocused testは通過しています。フルsuiteは最終HEADでは再実行しておらず、先行snapshotでは175/186でした。残る個別確認はr10（隔離fixture制約）、p1（隣接author app欠落）、r15/r16/r8（今回変更外のassert不一致）です。実UI視覚確認、別PC、plugin entrypoint起動は未実施です。利用上の注意を確認してから起動してください。

See [LICENSE](LICENSE).

## ソースからのビルド

Node.js 18以降を用意し、`npm ci` のあと `npm run build` を実行します。editionのプラグイン数と初回既定値はこのリポジトリの package.json から読み込みます。OBS追加DLLはこのbuildに含めません。

Windowsの未署名アプリです。ダウンロード時にSmartScreenが警告する場合があります。配布元とSHA-256を確認してから実行してください。

全入り版には作者権利者の確認に基づきMITで提供するcommunity 7プラグインを含みます。詳細は [NOTICE-community-MIT.txt](NOTICE-community-MIT.txt) を参照してください。



