# Assist Camera

Vercel 公開を前提にしたスマホ向け高機能カメラ Web アプリです。Vite + React + TypeScript の静的 SPA として動き、顔検出・顔追跡・登録済み人物との照合・録画・撮影アシストを端末内で処理します。

## セットアップ

```bash
npm install
npm run dev
npm run build
npm run preview
```

カメラは HTTPS または localhost でのみ起動します。

## 実装済み

- 写真 / 動画 / 捜索 / 設定モード
- MediaPipe Face Detector / Face Landmarker を Web Worker で実行
- 最大 8 人までの検出設計、初期は通常モード 5 人
- trackId 付き顔追跡、IoU / 中心距離 / サイズ差 / ランドマーク / 特徴量類似度による対応付け
- One Euro Filter、EMA、速度予測、lost frame tolerance
- object-fit: cover、CSS 表示サイズ、ズーム、フロントカメラ反転を考慮した顔枠座標変換
- 1 人ロックオン、複数ロック、顔タップメニュー
- 動作モード: 省電力 / 通常 / 最大
- 動画画質: 軽量 / 標準 / 高画質 / 最大
- 録画、録画確認、ダウンロード、履歴メタデータ
- 端末内 IndexedDB への登録済み人物DB
- DB照合は登録済み人物に対してのみ実行
- 未登録人物の自動名前表示なし
- 顔分析は明るさ、ブレ、顔向き、ピント、登録品質、追跡安定度に限定
- 開発者モード: FPS、推論時間、worker latency、trackId、confidence、IoU、lost frame count、座標変換ログ
- PWA manifest / Service Worker / Vercel headers

## モデル配置

静的配信されるモデルと WASM は以下に置いています。

- `public/models/blaze_face_short_range.tflite`
- `public/models/face_landmarker.task`
- `public/wasm/*`

## プライバシー設計

画像、動画フレーム、顔特徴量、登録人物情報はサーバーへ送信しません。Vercel は静的ファイル配信のみです。顔照合は「登録済み人物との類似信頼度」であり、未登録人物を特定する表示、年齢・性別・感情・民族性・健康状態などの推定は実装していません。

## Vercel

`vercel.json` で Vite の `dist` 出力、SPA rewrite、WASM とモデルの長期キャッシュ、カメラ向け Permissions-Policy、CSP を設定済みです。
