"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSupabaseAnonClient } from "@/lib/supabase/client";

export default function AdminPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    const verifyAccess = async () => {
      try {
        const supabase = createSupabaseAnonClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          router.replace("/login");
          return;
        }

        const { data: profile, error } = await supabase
          .from("user_profiles")
          .select("role")
          .eq("id", user.id)
          .maybeSingle();

        if (error || profile?.role !== "admin") {
          await supabase.auth.signOut();
          router.replace("/login");
          return;
        }

        setAuthorized(true);
      } finally {
        setChecking(false);
      }
    };

    void verifyAccess();
  }, [router]);

  if (checking) {
    return (
      <main>
        <div className="card" style={{ maxWidth: 420, margin: "40px auto" }}>
          <p style={{ margin: 0 }}>認証確認中...</p>
        </div>
      </main>
    );
  }

  if (!authorized) {
    return null;
  }

  return (
    <main className="grid">
      <section className="card">
        <h1 style={{ marginTop: 0 }}>管理ダッシュボード</h1>
        <p style={{ marginBottom: 0, color: "#6b7280" }}>
          AQUA返品票の登録状況、通知対象、回収状況を確認します。
        </p>
        <div style={{ marginTop: 16, display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Link href="/admin/ocr-review" className="btn" style={{ textDecoration: "none" }}>
            OCR取込・確認画面へ
          </Link>
          <button
            className="btn"
            style={{ background: "#047857" }}
            onClick={() => {
              const a = document.createElement("a");
              a.href = "/api/export/excel";
              a.click();
            }}
          >
            Excel出力
          </button>
        </div>
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
