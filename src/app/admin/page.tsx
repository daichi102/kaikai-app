export default function AdminPage() {
  return (
    <main className="grid">
      <section className="card">
        <h1 style={{ marginTop: 0 }}>管理ダッシュボード</h1>
        <p style={{ marginBottom: 0, color: "#6b7280" }}>
          AQUA返品票の登録状況、通知対象、回収状況を確認します。
        </p>
      </section>

      <section className="grid grid-3">
        <article className="card">
          <p className="metric-label">保管中（洗濯機）</p>
          <p className="metric-value">0 / 27</p>
        </article>
        <article className="card">
          <p className="metric-label">保管中（冷蔵庫）</p>
          <p className="metric-value">0 / 19</p>
        </article>
        <article className="card">
          <p className="metric-label">保管中（電子レンジ）</p>
          <p className="metric-value">0 / 通知なし</p>
        </article>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>次ステップ（開発優先順）</h2>
        <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
          <li>OCR取込と確認画面</li>
          <li>一覧管理とステータス管理</li>
          <li>通知ロジック</li>
          <li>回収処理と10列固定出力</li>
          <li>LINE固定グループ送信</li>
        </ol>
      </section>
    </main>
  );
}
