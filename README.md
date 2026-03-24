## 家電回収・返却管理システム（MVP）

AQUA返品票専用の家電回収・返却管理アプリです。  
iPadでOCR確認登録、PCで一覧管理・回収処理・出力・LINE送信を行います。

## Getting Started

1) 依存関係をインストール

```bash
npm install
```

2) 環境変数を設定

```bash
cp .env.example .env.local
```

3) Supabaseに初期スキーマを適用

`supabase/schema.sql` を Supabase SQL Editor で実行してください。

4) 開発サーバー起動

```bash
npm run dev
```

ブラウザで `http://localhost:3000` を開きます。

## 主なディレクトリ

- 要件資料: `../appliance-return-system-spec.md`
- Supabaseスキーマ: `supabase/schema.sql`
- 画面: `src/app`
- Supabaseクライアント: `src/lib/supabase/client.ts`

## 現在の実装状態

- [x] Next.js初期構成
- [x] Supabase初期SQL
- [x] ログイン画面（メール/パスワード）
- [x] 管理ダッシュボード雛形
- [ ] OCR取込API
- [ ] 回収処理・出力API
- [ ] LINE自動送信
