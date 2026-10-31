# SOMA BVH → VRM プレイヤー

MotionBricks（SOMA）形式の BVH モーションを、ブラウザ上で VRM モデルに
着せて再生する静的 Web アプリ。

- 生成（Python / ONNX）はこのアプリの外。アプリは「BVH → VRM 再生」担当。
- VRM ファイルはブラウザ内で読み込むだけで、どこにもアップロードされない。
- サーバー不要。静的ファイル一式なので GitHub Pages にそのまま置ける。
- 動作確認済み（2026-10-31）: ヘッドレス Chrome + pixiv 公式サンプル VRM で、
  対応ボーン22本の転送・アニメーション再生・UI操作を確認。`preview.png` 参照。

## 使い方

1. ページを開くと `motion/sample_wave.bvh` が読み込まれる。
   これは完全オリジナルのサンプル（自作スケルトン + サイン波の手続きモーション、
   生成スクリプトは `tools/make_sample_wave.py`）。足踏みしながら手を振るループ。
2. VRM ファイルを選ぶ（または画面へドラッグ&ドロップ）→ モデルが動き出す。
3. BVH ファイルを選べば、別のモーションにも差し替えられる。
   - 対応 BVH は SOMA 関節名を持つ BVH（位置チャンネルはオフセット置換方式 =
     MotionBricks 形式）。手元の BVH を読み込ませる分には公開にはならない。
4. 操作: 再生/一時停止、シーク、速度、BVH 骨格の重ね表示、モデル回転（向き合わせ）。
   URL に `?vrm=<URL>` を付けると、その VRM を自動で読み込む（CORS 許可先のみ）。

## モーションデータのライセンス注意（重要）

MotionBricks の同梱サンプルモーション（BVH/CSV）は
**NVIDIA Sample Data Evaluation License** の対象で、評価・テスト目的の
内部利用のみ許可され、**データそのものと、その派生データの第三者への
配布は禁止**されている。

- 同梱サンプルを context/target にして AI 生成したモーションも派生物にあたるため、
  **公開リポジトリや Web には置かないこと**。ローカルでの検証利用は問題ない。
- 公開してよいのは、自作モーションや、権利を持つモーションだけ。
  このリポジトリのサンプルが完全オリジナルなのはこのため。

## GitHub Pages への置き方

1. このフォルダの中身を GitHub リポジトリに push する。
   ```
   index.html  app.js  bvh.js  vendor/  motion/sample_wave.bvh  tools/  .nojekyll
   ```
   ライブラリ（three.js 0.160 / @pixiv/three-vrm 2.1.2）は `vendor/` に同梱済みで、
   CDN に依存しない（オフラインでも動く）。
2. リポジトリの Settings → Pages → Build and deployment で
   Source = 「Deploy from a branch」、Branch = main / root を選ぶ。
3. 数分で `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開される。

差し替えたい BVH は `motion/` に入れて push すればよい（ライセンス注意を参照）。

## 仕組み

- `bvh.js` … three.js に依存しない BVH プレイヤー（パース + FK + 補間）。
  three.js 標準の BVHLoader は「位置チャンネル + OFFSET」を加算する方式で、
  MotionBricks 形式（位置チャンネルが絶対値）では Hips の高さが二重になるため自作した。
  Node で単体テスト可能（Python 版 FK とフレーム単位で一致することを確認済み）。
- リターゲット … 「幾何フレーム」方式。各関節について、関節位置の幾何から
  その場のフレーム（Y = 骨の向き、X = 体の左右方向から直交化）を毎フレーム作り、
  VRM の正規化ヒューマノイドリグ（three-vrm）の静止姿勢で同じように作ったフレームと
  対応づけて回転を転送する。腕が「下がった状態で振れる」のような絶対姿勢が転送できる。
  ※ モーション側のバインドポーズが寝た姿勢のような骨格（MotionBricks BVH 等）でも、
  幾何からフレームを作るので「横たわり→起立」の回転が混入しない。
- ルート（Hips）の移動は、BVH の先頭フレームからの移動量を転送する。
- 対応ボーン: hips / spine / chest / upperChest（任意）/ neck / head、
  両腕（shoulder〜hand）、両脚（upperLeg〜toes）。指・目・顎は未対応。

## 既知の制限

- 各骨の軸まわりのツイスト（前腕のひねり等）は、フレームを体の軸から作るため近似になる。
- ループの継ぎ目が合っていない BVH では、再生の繋ぎ目で少し飛ぶことがある。
- プレビュー画像 `preview.png` は動作確認用で、モデルは pixiv の
  three-vrm 公式サンプル（VRM1_Constraint_Twist_Sample）。モデル自体は同梱していない。
