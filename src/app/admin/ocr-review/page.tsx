"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraSupported, setCameraSupported] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [saved, setSaved] = useState(false);

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

  useEffect(() => {
    setCameraSupported(typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia));
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

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

  const startCamera = async () => {
    try {
      setError("");
      setSuccess("");
      setCameraError("");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 960 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.playsInline = true;
        await new Promise<void>((resolve) => {
          const onReady = () => {
            videoRef.current?.removeEventListener("loadedmetadata", onReady);
            resolve();
          };
          videoRef.current?.addEventListener("loadedmetadata", onReady);
        });
        await videoRef.current.play();
      }
      setCameraActive(true);
    } catch {
      setCameraError("カメラを起動できませんでした。権限を許可し、HTTPSで開いてください。");
      setCameraActive(false);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraActive(false);
    setCameraError("");
  };

  const captureFromCamera = async () => {
    if (!videoRef.current || !canvasRef.current) {
      setError("カメラが初期化されていません。");
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) {
      setError("フレームを取得できませんでした。");
      return;
    }

    // 画面中央の4:3枠を切り出して周辺の写り込みを減らす
    const targetAspect = 4 / 3;
    let targetW = vw * 0.9;
    let targetH = targetW / targetAspect;
    if (targetH > vh * 0.9) {
      targetH = vh * 0.9;
      targetW = targetH * targetAspect;
    }
    const sx = (vw - targetW) / 2;
    const sy = (vh - targetH) / 2;

    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("キャンバス初期化に失敗しました。");
      return;
    }
    ctx.drawImage(video, sx, sy, targetW, targetH, 0, 0, targetW, targetH);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) {
      setError("画像の生成に失敗しました。");
      return;
    }
    const file = new File([blob], "capture.jpg", { type: "image/jpeg" });
    setImageFile(file);
    setError("");
    setSuccess("フレームを取り込みました。OCR抽出を実行できます。");
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
      setSaved(true);
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
          <div style={{ display: "grid", gap: 8 }}>
            <label htmlFor="image">票画像</label>
            <input
              id="image"
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFileChange}
              required
              style={{ display: "none" }}
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn secondary" type="button" onClick={() => fileInputRef.current?.click()}>
                ファイルを選択
              </button>
              {cameraSupported ? (
                <>
                  <button className="btn" type="button" onClick={startCamera} disabled={cameraActive}>
                    カメラを起動
                  </button>
                  <button className="btn secondary" type="button" onClick={stopCamera} disabled={!cameraActive}>
                    カメラ停止
                  </button>
                </>
              ) : null}
              <span style={{ alignSelf: "center", color: "#6b7280", fontSize: 12 }}>
                枠に合わせて撮影すると精度が上がります
              </span>
            </div>
            {cameraError ? (
              <p style={{ color: "#b91c1c", margin: 0 }}>{cameraError}</p>
            ) : null}

            {cameraActive ? (
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ position: "relative", width: "100%", aspectRatio: "4 / 3" }}>
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 8, background: "#000" }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      inset: "8%",
                      border: "3px solid rgba(15, 23, 42, 0.6)",
                      borderRadius: 10,
                      pointerEvents: "none",
                      boxShadow: "0 0 0 2000px rgba(0,0,0,0.25)",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      bottom: 8,
                      left: 12,
                      right: 12,
                      color: "#f8fafc",
                      textShadow: "0 1px 4px rgba(0,0,0,0.8)",
                      fontWeight: 600,
                      fontSize: 13,
                    }}
                  >
                    枠に票を水平に収めてください（4:3）
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn" type="button" onClick={captureFromCamera}>
                    この枠で取り込む
                  </button>
                  <button className="btn secondary" type="button" onClick={stopCamera}>
                    キャンセル
                  </button>
                </div>
                <canvas ref={canvasRef} style={{ display: "none" }} />
              </div>
            ) : (
              <div
                style={{
                  position: "relative",
                  width: "100%",
                  aspectRatio: "4 / 3",
                  border: "2px dashed #0f172a",
                  borderRadius: 8,
                  background:
                    "linear-gradient(135deg, #f8fafc 25%, #ffffff 25%, #ffffff 50%, #f8fafc 50%, #f8fafc 75%, #ffffff 75%, #ffffff 100%)",
                  backgroundSize: "32px 32px",
                  display: "grid",
                  placeItems: "center",
                  color: "#0f172a",
                  fontWeight: 600,
                  textAlign: "center",
                  padding: 12,
                }}
              >
                <div>
                  票全体がこの枠に収まるように合わせて撮影してください
                  <div style={{ fontSize: 12, fontWeight: 400, color: "#6b7280", marginTop: 4 }}>
                    影・反射を避け、水平に。4辺が見切れないようにしてください。
                  </div>
                </div>
                <div
                  style={{
                    position: "absolute",
                    inset: "8%",
                    border: "3px solid rgba(15, 23, 42, 0.35)",
                    borderRadius: 6,
                    pointerEvents: "none",
                  }}
                />
              </div>
            )}
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

        {saved ? (
          <button
            className="btn"
            type="button"
            style={{ background: "#047857" }}
            onClick={() => {
              const a = document.createElement("a");
              a.href = "/api/export/excel";
              a.click();
            }}
          >
            Excel出力
          </button>
        ) : null}
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>OCR生テキスト</h2>
        <textarea value={rawText} readOnly rows={10} />
      </section>
    </main>
  );
}
