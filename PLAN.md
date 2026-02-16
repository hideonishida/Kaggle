# Kindle Cloud Reader 高画質スクリーンショット Chrome拡張機能 - 実装計画

## ファイル構成

```
kindle-screenshot-extension/
├── manifest.json          # Manifest V3 設定
├── popup/
│   ├── popup.html         # ポップアップUI
│   ├── popup.css          # スタイル
│   └── popup.js           # ポップアップロジック
├── background/
│   └── service-worker.js  # バックグラウンド処理（撮影ループ・PDF生成）
├── content/
│   └── content.js         # コンテンツスクリプト（ページ操作・待機ロジック）
├── lib/
│   └── jspdf.umd.min.js  # jsPDF ライブラリ（ローカル同梱）
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## アーキテクチャ概要

```
[Popup UI] --メッセージ--> [Service Worker (background)]
                                |
                     chrome.tabs.setZoom (ズーム変更)
                     chrome.tabs.captureVisibleTab (撮影)
                                |
                           <--メッセージ-->
                                |
                          [Content Script]
                           ページめくり (Arrow Key)
                           読み込み完了検知
                           現在ページ番号取得
```

### 役割分担

| コンポーネント | 責務 |
|---|---|
| **popup.js** | UI表示、パラメータ入力、開始/停止指示をService Workerに送信、進捗表示 |
| **service-worker.js** | 撮影ループの制御、`chrome.tabs.setZoom`/`captureVisibleTab`の実行、画像データ蓄積、jsPDFによるPDF生成・ダウンロード |
| **content.js** | Kindle Cloud Readerページ内での操作（キーイベント送信によるページめくり、画像読み込み完了の検知、ページ情報の取得） |

## 実装ステップ

### Step 1: プロジェクト基盤セットアップ

- `manifest.json` を作成（Manifest V3）
  - `permissions`: `activeTab`, `tabs`, `scripting`, `downloads`
  - `host_permissions`: `https://read.amazon.com/*`, `https://read.amazon.co.jp/*` 等
  - `action`: popup指定
  - `background.service_worker`: service-worker.js
  - `content_scripts`: read.amazon.* にマッチ
- アイコン用プレースホルダー画像を作成
- jsPDFライブラリをダウンロードして `lib/` に配置

### Step 2: ポップアップUI実装

**popup.html / popup.css / popup.js**

- 入力フィールド:
  - 開始ページ番号（デフォルト: 1）
  - 終了ページ番号（デフォルト: 10）
  - 高画質倍率（select: 1.5x / 2.0x / 2.5x / 3.0x、デフォルト: 2.0）
  - 撮影間隔（ミリ秒、デフォルト: 2000）
- ボタン:
  - 「撮影開始」ボタン
  - 「停止」ボタン
- 進捗表示:
  - 「現在 X / Y ページ撮影完了」テキスト
  - プログレスバー
- ロジック:
  - 「撮影開始」押下時に `chrome.runtime.sendMessage` でService Workerにパラメータを送信
  - Service Workerからの進捗メッセージを受信してUIを更新
  - Popupが閉じても撮影は継続する（Service Workerで管理）

### Step 3: Content Script実装

**content/content.js**

Kindle Cloud Readerのページ内で動作するスクリプト。

#### 3a. ページめくり機能
- `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', ... }))` で次ページへ進む
- `ArrowLeft` で前ページへ戻る
- **注意**: `isTrusted: false` で動作しない場合の代替策として、右端エリアのクリックイベントも用意する
  - 既知セレクタ `#kindleReader_pageTurnAreaRight` を試行
  - フォールバック: ビューポート右端20%エリアへのクリックイベントをシミュレーション

#### 3b. 画像読み込み完了検知（スマート待機）
- **MutationObserver** でDOM変更を監視
- **Canvas/Image要素の完了チェック**:
  - `document.querySelectorAll('canvas')` で全canvasの描画完了を確認
  - `document.querySelectorAll('img')` で全画像の `complete` プロパティを確認
- **ネットワークアイドル検知**: ページめくり後、一定時間（500ms）新規リクエストがなければ「読み込み完了」とみなす
  - `PerformanceObserver` で `resource` エントリを監視
- **最終フォールバック**: 上記がうまく機能しない場合は設定された固定待機時間（デフォルト2000ms）を使用
- メッセージリスナーでService Workerからのコマンドを受信:
  - `turnPage`: ページめくり実行 → 読み込み完了後に応答
  - `getPageInfo`: 現在のページ情報を返す

#### 3c. ページ番号の取得
- Kindle Cloud Readerのフッター/プログレスバーから現在位置を取得する試み
- 取得できない場合はService Worker側のカウンターで管理

### Step 4: Service Worker（撮影ループ）実装

**background/service-worker.js**

#### 4a. 撮影ループの主要フロー
```
受信: { action: 'startCapture', startPage, endPage, zoomLevel, interval }

1. 現在のアクティブタブを取得
2. Content Scriptが注入済みか確認（なければ chrome.scripting.executeScript で注入）
3. 撮影ページカウンターを初期化
4. ループ開始（startPage → endPage）:
   a. Content Scriptに 'turnPage' メッセージ送信
   b. Content Scriptからの「読み込み完了」応答を待つ
   c. chrome.tabs.setZoom(tabId, zoomLevel) でズームイン
   d. 安定化のため短時間待機（300ms）
   e. chrome.tabs.captureVisibleTab(windowId, { format: 'png' }) で撮影
   f. chrome.tabs.setZoom(tabId, 1.0) でズーム復元
   g. 撮影データ（data URL）を配列に蓄積
   h. Popupに進捗を通知
5. ループ完了後、PDF生成処理を呼び出す
```

#### 4b. 状態管理
- `captureState` オブジェクトで以下を管理:
  - `isRunning`: 実行中フラグ
  - `currentPage`: 現在撮影中のページ
  - `totalPages`: 総ページ数
  - `images`: 撮影済みdata URL配列
  - `tabId`: 対象タブID
  - `settings`: ユーザー設定値
- 「停止」指示を受けた場合は `isRunning = false` でループを中断

#### 4c. エラーハンドリング
- 撮影失敗時: リトライ（最大3回）
- ズーム変更失敗時: ズームなしで撮影を続行
- タブが閉じられた場合: 撮影を中断、取得済みデータでPDF生成を提案

### Step 5: PDF生成・ダウンロード

**service-worker.js 内**

- jsPDFを `importScripts('./lib/jspdf.umd.min.js')` で読み込み
- 撮影完了後、全画像データからPDFを生成:
  ```
  1. 最初の画像のサイズを取得（Image オブジェクトで読み込み）
     ※ Service Worker内ではImageが使えないため、OffscreenDocumentを使用
  2. jsPDFインスタンスを画像サイズに合わせて作成
  3. 各画像を1ページずつ追加
  4. Blob URL生成 → chrome.downloads.download でダウンロード
  ```
- **OffscreenDocument**: Service Worker内で画像のデコード/サイズ取得が必要な場合に使用
  - `offscreen/offscreen.html` + `offscreen/offscreen.js` を追加
  - 画像のwidth/heightを取得するためにImageオブジェクトを利用

### Step 6: 追加ファイル（OffscreenDocument）

```
kindle-screenshot-extension/
├── offscreen/
│   ├── offscreen.html     # Offscreen Document
│   └── offscreen.js       # 画像処理・PDF生成の実処理
```

- Service WorkerではDOM APIが使えないため、画像サイズ取得とjsPDFでのPDF組み立てをOffscreen Documentに委譲する
- Service Worker → Offscreen Document へメッセージで画像データを渡す
- Offscreen Document内でjsPDFを使いPDFを生成し、BlobをダウンロードURLに変換
- 生成完了をService Workerに通知 → `chrome.downloads.download` でダウンロード

## 最終ファイル構成（修正版）

```
kindle-screenshot-extension/
├── manifest.json
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── background/
│   └── service-worker.js
├── content/
│   └── content.js
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js
├── lib/
│   └── jspdf.umd.min.js
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 実装順序まとめ

| ステップ | 内容 | 成果物 |
|---|---|---|
| 1 | プロジェクト基盤 | manifest.json, アイコン, jsPDFライブラリ配置 |
| 2 | ポップアップUI | popup.html, popup.css, popup.js |
| 3 | Content Script | content.js（ページめくり・待機ロジック） |
| 4 | 撮影ループ | service-worker.js（ズーム→撮影→復元のループ） |
| 5 | PDF生成 | offscreen.html, offscreen.js（jsPDFでPDF生成） |
| 6 | 統合テスト・調整 | 全体結合、エッジケース対応 |

## 重要な技術的注意点

1. **`chrome.tabs.captureVisibleTab` の制約**: ウィンドウの可視領域のみをキャプチャする。ズームインすると解像度は上がるが、ページの一部しか写らない可能性がある。
   - **対策**: ズーム倍率を上げすぎないか、またはズーム後にスクロールして複数回キャプチャ→合成する仕組みを将来的に検討。ただしKindle Cloud Readerはページ単位表示のため、ズーム時にページ全体がビューポートに収まるかの確認が必要。
   - **もう一つのアプローチ**: `devicePixelRatio` を活用して、`captureVisibleTab` が自動的に高解像度で撮影するかを検証。Retinaディスプレイ相当の解像度が得られる場合はズーム不要の可能性もある。

2. **Kindle Cloud ReaderのDOM変動**: AmazonはDOMを頻繁に変更するため、セレクタベースの操作は壊れやすい。キーボードイベントによるページめくりを優先し、DOM依存を最小限にする。

3. **Service Workerのライフサイクル**: Manifest V3のService Workerは非アクティブ時に停止される（通常30秒〜5分）。長時間の撮影ループでは `chrome.alarms` や定期的なメッセージングでService Workerを維持する必要がある。

4. **法的注意**: この拡張機能は個人的な学習・バックアップ目的を想定。著作権法およびAmazonの利用規約に留意すること。
