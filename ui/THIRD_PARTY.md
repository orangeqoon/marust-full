# 同梱している第三者のコード

## dockview

- パッケージ: `dockview`（公開 npm。素の JS）
- 版: 8.4.0
- ライセンス: MIT
- 出典: https://github.com/mathuo/dockview
- 画面は CDN から読まない。`node_modules/dockview/dist` を窓口の `/vendor/dockview/` で配る。
- `dependencies` に入っているので、`electron-packager`（`npm run build`）は本番依存として同梱する。

## ws

- パッケージ: `ws`
- ライセンス: MIT
- WebSocket サーバ。画面には出さない。
