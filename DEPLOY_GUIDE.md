# 🚀 Cloud Run デプロイ完全ガイド
## AI News Deep Reader を本番公開するまでの全手順

> **対象**: 初めて Cloud Run にデプロイする方  
> **所要時間**: 約15〜30分（初回のみ）

---

## 📋 STEP 0: 事前確認（準備物チェック）

デプロイを始める前に、以下が手元にあるか確認してください。

| 確認項目 | 確認方法 |
|---------|---------|
| ✅ Google Cloud アカウント | [console.cloud.google.com](https://console.cloud.google.com) にログインできるか |
| ✅ プロジェクト ID | GCP コンソール左上に表示される文字列（例: `my-project-123456`） |
| ✅ Gemini API Key | [aistudio.google.com](https://aistudio.google.com) で取得済みか |
| ✅ Google Cloud CLI (`gcloud`) | ターミナルで `gcloud version` と打ってバージョンが出るか |

### 🔧 `gcloud` CLI が入っていない場合

1. [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install) を開く
2. Windows 用インストーラーをダウンロードして実行
3. インストール後、PowerShell を**再起動**して `gcloud version` で確認

---

## 🔐 STEP 1: Google Cloud にログイン

PowerShell を開いて以下を実行：

```powershell
gcloud auth login
```

▶ ブラウザが自動で開くので、Google アカウントでログインしてください。  
▶ 「認証に成功しました」と表示されれば OK。

次に、使いたいプロジェクトを設定します：

```powershell
# 「YOUR_PROJECT_ID」を自分のプロジェクトIDに書き換えてください
gcloud config set project YOUR_PROJECT_ID
```

> **💡 プロジェクト ID はどこ？**  
> [GCP コンソール](https://console.cloud.google.com) を開いたとき、左上の「プロジェクトを選択」に表示される英数字の文字列です（例: `my-news-app-123456`）。

---

## 🔌 STEP 2: 必要な API を有効化

Cloud Run を使うために、2つの機能を Google Cloud 側でオンにする必要があります。

```powershell
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
```

▶ 1〜2分かかる場合があります。「Operation finished successfully」と出ればOK。

---

## 📁 STEP 3: プロジェクトフォルダに移動

```powershell
cd C:\Users\giman\Desktop\Antigravity-Sandbox\drafts\news-deep-dive
```

移動できたか確認（`server.ts` や `Dockerfile` が表示されれば正しい場所）：

```powershell
ls
```

---

## 🔑 STEP 4: Gemini API Key を安全に登録（Secret Manager）

`.env` ファイルに書いた API キーはコンテナには含まれません（セキュリティのため除外済み）。  
代わりに Cloud Run の「シークレット」機能を使って安全に渡します。

```powershell
# Secret Manager API を有効化
gcloud services enable secretmanager.googleapis.com
```

次に API キーを登録します。`YOUR_GEMINI_API_KEY` を実際のキー（`AIzaSy...` で始まる文字列）に書き換えて実行：

```powershell
echo "AIzaSyDZhEY0F24s7dDl8TbOXVKlyabuRXe-3Vw" | gcloud secrets create GEMINI_API_KEY --data-file=-
```

> **⚠️ 注意**  
> もし「シークレットが既に存在する」エラーが出たら、代わりにこちらを使ってください：  
> ```powershell
> echo "YOUR_GEMINI_API_KEY" | gcloud secrets versions add GEMINI_API_KEY --data-file=-
> ```

---

## 🏗️ STEP 5: デプロイ実行（ここがメイン！）

```powershell
gcloud run deploy news-deep-dive `
  --source . `
  --region asia-northeast1 `
  --allow-unauthenticated `
  --set-secrets "GEMINI_API_KEY=GEMINI_API_KEY:latest"
```

**各オプションの意味：**

| オプション | 意味 |
|-----------|------|
| `--source .` | 今いるフォルダのコードをそのままビルドしてデプロイ |
| `--region asia-northeast1` | 東京リージョン（日本から速い） |
| `--allow-unauthenticated` | 誰でも URL にアクセスできる（公開設定） |
| `` --set-secrets "..."`` | STEP 4 で登録したAPIキーをコンテナに渡す |

▶ 「Allow unauthenticated invocations?」と聞かれたら `y` を入力して Enter。  
▶ ビルドに **3〜5分** かかります。コーヒーでも飲みながら待ちましょう ☕  
▶ 最後に `Service URL: https://...` と表示されれば**デプロイ成功**です！

---

## ✅ STEP 6: 動作確認

デプロイ成功後に表示された URL（以下 `[URL]`）で確認してください。

### ブラウザで開いて確認

| アクセス先 | 期待される結果 | 何を確認するか |
|-----------|-------------|--------------|
| `[URL]/ping` | `pong` と表示 | サーバーが起動しているか |
| `[URL]/api/health` | `{"status":"ok","env":"production",...}` | 本番モードで動いているか |
| `[URL]/` | アプリの画面が開く | フロントエンドが正常表示されるか |

`/ping` → `pong` が確認できれば、以前の 404 問題は完全に解決しています 🎉

---

## 🆘 まだ問題がある場合

ログを確認して原因を特定してください：

```powershell
gcloud run logs read --service=news-deep-dive --region=asia-northeast1 --limit=100
```

ログの内容をそのままコピーして教えてください。一緒に原因を特定します。

---

## 🔄 コードを修正したら？再デプロイは簡単！

修正後は STEP 5 のコマンドをもう一度実行するだけです。  
（フォルダに移動してからコマンドを実行）

---

## 💡 用語メモ（わからない言葉があったら読む）

| 用語 | わかりやすい説明 |
|------|---------------|
| **Cloud Run** | Google のサービス。アプリをインターネット上で24時間自動で動かしてくれる場所 |
| **コンテナ / Docker** | アプリを「箱」に詰めて、どんな環境でも同じように動かす技術 |
| **Dockerfile** | その「箱」の作り方レシピ（今回は自動生成済み） |
| **リージョン** | サーバーの地理的な場所。`asia-northeast1` = 東京 |
| **Secret Manager** | API キーなどの秘密情報を安全に保管する Google の金庫 |
| **`gcloud`** | Google Cloud を操作するためのコマンドラインツール |

---

*📅 対象プロジェクト: AI News Deep Dive / 作成: 2026-03-28*
