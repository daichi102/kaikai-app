"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseAnonClient } from "@/lib/supabase/client";

const ID_LOGIN_EMAIL_DOMAIN = "kaikai.local";

function toAuthEmail(loginId: string): string {
  const normalized = loginId.trim().toLowerCase();
  if (normalized.includes("@")) {
    return normalized;
  }

  return `${normalized}@${ID_LOGIN_EMAIL_DOMAIN}`;
}

export default function LoginPage() {
  const router = useRouter();
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const supabase = createSupabaseAnonClient();
      const email = toAuthEmail(loginId);
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        setError("ログインに失敗しました。IDまたはパスワードを確認してください。");
        return;
      }

      router.push("/admin");
    } catch {
      setError("環境変数または接続設定を確認してください。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main>
      <div className="card" style={{ maxWidth: 420, margin: "40px auto" }}>
        <h1 style={{ marginTop: 0 }}>家電回収・返却管理</h1>
        <p style={{ color: "#6b7280" }}>管理者/現場アカウントでログインしてください。</p>

        <form onSubmit={handleSubmit} className="grid">
          <div>
            <label htmlFor="loginId">ログインID</label>
            <input
              id="loginId"
              type="text"
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              placeholder="例: Admin_122345"
              required
            />
          </div>

          <div>
            <label htmlFor="password">パスワード</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error ? <p style={{ color: "#b91c1c", margin: 0 }}>{error}</p> : null}

          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? "ログイン中..." : "ログイン"}
          </button>
        </form>
      </div>
    </main>
  );
}
