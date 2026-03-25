"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSupabaseAnonClient } from "@/lib/supabase/client";
import type { OcrExtractedDraft } from "@/types/ocr";

const CATEGORY_OPTIONS: Array<{ value: OcrExtractedDraft["appliance_category"]; label: string }> = [
  { value: "washing_machine_vertical", label: "縦型洗濯機" },
  { value: "washing_machine_drum", label: "ドラム洗濯機" },
  { value: "refrigerator_400_or_less", label: "冷蔵庫400以下" },
  { value: "refrigerator_over_400", label: "冷蔵庫400以上" },
  { value: "microwave", label: "電子レンジ" },
  { value: "other", label: "その他" },
];

const INITIAL_DRAFT: OcrExtractedDraft = {
  sto_number: "",
  approval_number: "",
  work_order_number: "",
  vendor_name: null,
  model_number: "",
  serial_number: "",
  request_type: "",
  symptom: null,
  inspection_level: null,
  return_destination: null,
  product_name: null,
  request_department: null,
  customer_name: null,
  appliance_category: "microwave",
  appliance_category_other: null,
};

type ExtractApiResult = {
  ok: boolean;
  extracted?: OcrExtractedDraft;
  rawText?: string;
  error?: string;
};

function toNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export default function OcrReviewPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<OcrExtractedDraft>(INITIAL_DRAFT);
  const [rawText, setRawText] = useState("");

  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

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

        const { data: profile, error: profileError } = await supabase
          .from("user_profiles")
          .select("role")
          .eq("id", user.id)
          .maybeSingle();

        if (profileError || profile?.role !== "admin") {
          await supabase.auth.signOut();
          router.replace("/login");
          return;
        }

        setUserId(user.id);
        setAuthorized(true);
      } finally {
        setChecking(false);
      }
    };

    void verifyAccess();
  }, [router]);

  const hasRequiredFields = useMemo(() => {
    return Boolean(
      draft.sto_number.trim() &&
        draft.approval_number.trim() &&
        draft.work_order_number.trim() &&
        draft.model_number.trim() &&
        draft.serial_number.trim() &&
        draft.request_type.trim(),
    );
  }, [draft]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setImageFile(file);
    setError("");
    setSuccess("");
  };

  const handleExtract = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!imageFile) {
      setError("画像ファイルを選択してください。");
      return;
    }

    setExtracting(true);
    setError("");
    setSuccess("");

    try {
      const formData = new FormData();
      formData.append("image", imageFile);

      const response = await fetch("/api/ocr/extract", {
        method: "POST",
        body: formData,
      });

      const result = (await response.json()) as ExtractApiResult;

      if (!response.ok || !result.ok || !result.extracted) {
        setError(result.error ?? "OCR抽出に失敗しました。");
        return;
      }

      setDraft(result.extracted);
      setRawText(result.rawText ?? "");
      setSuccess("OCR抽出が完了しました。内容を確認して保存してください。");
    } catch {
      setError("OCR抽出中にエラーが発生しました。");
    } finally {
      setExtracting(false);
    }
  };

  const handleFieldChange = (field: keyof OcrExtractedDraft, value: string) => {
    setDraft((prev) => ({
      ...prev,
      [field]:
        field === "vendor_name" ||
        field === "symptom" ||
        field === "inspection_level" ||
        field === "return_destination" ||
        field === "product_name" ||
        field === "request_department" ||
        field === "customer_name" ||
        field === "appliance_category_other"
          ? toNullable(value)
          : value,
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const response = await fetch("/api/ocr/draft", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...draft,
          vendor_name: null,
          product_name: null,
          customer_name: null,
          inspection_level: null,
          image_path: imageFile?.name ?? null,
          registered_by: userId,
        }),
      });

      const result = (await response.json()) as { ok: boolean; error?: string; id?: string };

      if (!response.ok || !result.ok) {
        setError(result.error ?? "下書き保存に失敗しました。");
        return;
      }

      setSuccess(`下書きを保存しました（ID: ${result.id}）。`);
      setImageFile(null);
      setRawText("");
    } catch {
      setError("下書き保存中にエラーが発生しました。");
    } finally {
      setSaving(false);
    }
  };

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
        <h1 style={{ marginTop: 0 }}>OCR取込・確認</h1>
        <p style={{ color: "#6b7280", marginBottom: 16 }}>
          票画像をアップロードして抽出後、必要項目を修正して下書き保存します。
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/admin" className="btn secondary" style={{ textDecoration: "none" }}>
            管理画面へ戻る
          </Link>
        </div>
      </section>

      <section className="card">
        <form className="grid" onSubmit={handleExtract}>
          <div>
            <label htmlFor="image">票画像</label>
            <input id="image" type="file" accept="image/*" onChange={handleFileChange} required />
          </div>
          <button className="btn" type="submit" disabled={extracting || !imageFile}>
            {extracting ? "OCR抽出中..." : "OCR抽出"}
          </button>
        </form>
      </section>

      <section className="card grid">
        <h2 style={{ margin: 0 }}>抽出結果（編集可）</h2>

        <div className="grid grid-3">
          <div>
            <label htmlFor="sto_number">STO番号 *</label>
            <input
              id="sto_number"
              value={draft.sto_number}
              onChange={(e) => handleFieldChange("sto_number", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="approval_number">承認番号 *</label>
            <input
              id="approval_number"
              value={draft.approval_number}
              onChange={(e) => handleFieldChange("approval_number", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="work_order_number">作業依頼番号 *</label>
            <input
              id="work_order_number"
              value={draft.work_order_number}
              onChange={(e) => handleFieldChange("work_order_number", e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-3">
          <div>
            <label htmlFor="model_number">型式/型番 *</label>
            <input
              id="model_number"
              value={draft.model_number}
              onChange={(e) => handleFieldChange("model_number", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="serial_number">製造番号 *</label>
            <input
              id="serial_number"
              value={draft.serial_number}
              onChange={(e) => handleFieldChange("serial_number", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="request_type">申請区分 *</label>
            <input
              id="request_type"
              value={draft.request_type}
              onChange={(e) => handleFieldChange("request_type", e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-3">
          <div>
            <label htmlFor="appliance_category">家電カテゴリ</label>
            <select
              id="appliance_category"
              value={draft.appliance_category}
              onChange={(e) => {
                const category = e.target.value as OcrExtractedDraft["appliance_category"];
                setDraft((prev) => ({
                  ...prev,
                  appliance_category: category,
                  appliance_category_other: category === "other" ? prev.appliance_category_other : null,
                }));
              }}
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {draft.appliance_category === "other" ? (
            <div>
              <label htmlFor="appliance_category_other">その他カテゴリ</label>
              <input
                id="appliance_category_other"
                value={draft.appliance_category_other ?? ""}
                onChange={(e) => handleFieldChange("appliance_category_other", e.target.value)}
                placeholder="カテゴリ名を入力"
              />
            </div>
          ) : null}
        </div>

        <div className="grid grid-3">
          <div>
            <label htmlFor="request_department">依頼部署</label>
            <input
              id="request_department"
              value={draft.request_department ?? ""}
              onChange={(e) => handleFieldChange("request_department", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="return_destination">返却先</label>
            <input
              id="return_destination"
              value={draft.return_destination ?? ""}
              onChange={(e) => handleFieldChange("return_destination", e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-3">
          <div style={{ gridColumn: "1 / -1" }}>
            <label htmlFor="symptom">症状</label>
            <textarea
              id="symptom"
              rows={3}
              value={draft.symptom ?? ""}
              onChange={(e) => handleFieldChange("symptom", e.target.value)}
            />
          </div>
        </div>

        {error ? <p style={{ color: "#b91c1c", margin: 0 }}>{error}</p> : null}
        {success ? <p style={{ color: "#065f46", margin: 0 }}>{success}</p> : null}

        <button className="btn" type="button" onClick={handleSave} disabled={saving || !hasRequiredFields}>
          {saving ? "保存中..." : "下書き保存"}
        </button>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>OCR生テキスト</h2>
        <textarea value={rawText} readOnly rows={10} />
      </section>
    </main>
  );
}
