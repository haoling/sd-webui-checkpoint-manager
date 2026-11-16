# Checkpoint Manager (sd-webui-checkpoint-manager)

AUTOMATIC1111 WebUI の Extra Networks「Checkpoints」タブに、次の機能を追加します。

- 各カード左上のチェックボックスで複数選択 (Shift+クリックで範囲選択、全選択/全解除)
- **📁 移動**: 選択した checkpoint を `models/stable-diffusion` のサブフォルダへ移動 (新規フォルダ作成可)。
  同名のプレビュー画像 / `.yaml` / `.json` なども一緒に移動
- **🗑 削除**: 既定は `models/stable-diffusion-trash` へ退避 (戻せる)。「完全に削除」も選べる
- **▶ 選択したCheckpointで連続生成**: 今の txt2img / img2img の設定をそのまま使い、選択した checkpoint で順に生成。
  Seed が -1 の場合も最初に決まった値を全 checkpoint で共通に使うので、モデル比較に使えます

## インストール
`extensions/` にこのフォルダを置いて WebUI を再起動 (または Extensions タブ → Install from URL)。

## 使い方
1. txt2img / img2img のプロンプト等を設定する
2. Checkpoints タブで比較したいモデルにチェックを入れる
3. 「▶ 選択したCheckpointで連続生成」を押す
   (生成フォーム下の「Checkpoint Manager」アコーディオンでも、対象と有効/無効を確認・手動指定できます)

## 注意
- 現在ロード中の checkpoint は移動・削除できません。生成中も操作不可です
- X/Y/Z plot など下部のスクリプトを選択中は連続生成が無効になります
- Extra Networks の Tree View 表示ではチェックボックスは出ません (カード表示で使用)
- 移動・削除 API (`/ckptmgr/*`) は `--gradio-auth` 使用時はログイン済みブラウザのみ許可します。
  認証なしで `--listen` する環境では、ネットワーク上の誰でもファイル操作できる点に注意してください
- 動作確認は A1111 v1.10 系のソースに対して行っています (Forge 等は未確認)
