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

type ProcessedImageResult = {
  file: File;
  warnings: string[];
};

function toNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("画像の読み込みに失敗しました。"));
    };
    image.src = objectUrl;
  });
}

function getScaledSize(width: number, height: number): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const minShortEdge = 1200;
  const maxLongEdge = 2200;

  let scale = 1;
  if (longEdge > maxLongEdge) {
    scale = maxLongEdge / longEdge;
  }
  if (shortEdge * scale < minShortEdge) {
    scale = minShortEdge / shortEdge;
  }

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function findContentBounds(imageData: ImageData): { x: number; y: number; width: number; height: number } {
  const { data, width, height } = imageData;
  let top = 0;
  let bottom = height - 1;
  let left = 0;
  let right = width - 1;

  const rowHasInk = (row: number): boolean => {
    for (let x = 0; x < width; x += 1) {
      const index = (row * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luma < 242) {
        return true;
      }
    }
    return false;
  };

  const colHasInk = (col: number): boolean => {
    for (let y = 0; y < height; y += 1) {
      const index = (y * width + col) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luma < 242) {
        return true;
      }
    }
    return false;
  };

  while (top < bottom && !rowHasInk(top)) {
    top += 1;
  }
  while (bottom > top && !rowHasInk(bottom)) {
    bottom -= 1;
  }
  while (left < right && !colHasInk(left)) {
    left += 1;
  }
  while (right > left && !colHasInk(right)) {
    right -= 1;
  }

  const marginX = Math.round((right - left + 1) * 0.03);
  const marginY = Math.round((bottom - top + 1) * 0.03);
  const x = Math.max(0, left - marginX);
  const y = Math.max(0, top - marginY);
  const cropWidth = Math.min(width - x, right - left + 1 + marginX * 2);
  const cropHeight = Math.min(height - y, bottom - top + 1 + marginY * 2);

  return {
    x,
    y,
    width: Math.max(1, cropWidth),
    height: Math.max(1, cropHeight),
  };
}

async function preprocessImageForOcr(file: File): Promise<ProcessedImageResult> {
  if (!file.type.startsWith("image/")) {
    throw new Error("画像ファイルを選択してください。");
  }

  const image = await loadImage(file);
  const scaled = getScaledSize(image.naturalWidth, image.naturalHeight);
  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = scaled.width;
  baseCanvas.height = scaled.height;
  const baseContext = baseCanvas.getContext("2d");
  if (!baseContext) {
    throw new Error("画像処理の初期化に失敗しました。");
  }
  baseContext.drawImage(image, 0, 0, scaled.width, scaled.height);

  const originalData = baseContext.getImageData(0, 0, scaled.width, scaled.height);
  const bounds = findContentBounds(originalData);

  const canvas = document.createElement("canvas");
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("画像処理の初期化に失敗しました。");
  }

  context.drawImage(baseCanvas, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;

  let luminanceSum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    luminanceSum += luma;
  }
  const averageLuminance = luminanceSum / (data.length / 4);
  const threshold = Math.max(105, Math.min(210, averageLuminance - 8));

  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const contrasted = Math.max(0, Math.min(255, (luma - 128) * 1.35 + 128));
    const value = contrasted > threshold ? 255 : 0;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }

  context.putImageData(imageData, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", 0.92);
  });
  if (!blob) {
    throw new Error("画像変換に失敗しました。");
  }

  const nameWithoutExt = file.name.replace(/\.[^.]+$/, "");
  const processedFile = new File([blob], `${nameWithoutExt}-scan.jpg`, { type: "image/jpeg" });

  const warnings: string[] = [];
  const pixelCount = image.naturalWidth * image.naturalHeight;
  if (pixelCount < 1_200_000) {
    warnings.push("解像度が低めです。文字が潰れる場合は近づいて再撮影してください。");
  }
  if (averageLuminance < 95) {
    warnings.push("画像が暗めです。照明を強くして影を避けると精度が上がります。");
  }

  return { file: processedFile, warnings };
}

export default function OcrReviewPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [originalImageFile, setOriginalImageFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState("");
  const [qualityWarnings, setQualityWarnings] = useState<string[]>([]);
  const [processingImage, setProcessingImage] = useState(false);
  const [draft, setDraft] = useState<OcrExtractedDraft>(INITIAL_DRAFT);
  const [rawText, setRawText] = useState("");

  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
    if (!imageFile) {
      setPreviewUrl(null);
      return;
    }

    const objectUrl = URL.createObjectURL(imageFile);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [imageFile]);

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

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setError("");
    setSuccess("");
    setQualityWarnings([]);

    if (!file) {
      setImageFile(null);
      setOriginalImageFile(null);
      setSelectedFileName("");
      return;
    }

    setOriginalImageFile(file);
    setSelectedFileName(file.name);
    setProcessingImage(true);

    try {
      const processed = await preprocessImageForOcr(file);
      setImageFile(processed.file);
      setQualityWarnings(processed.warnings);
      setSuccess("画像を読み込み、OCR向けに補正しました。抽出を実行できます。");
    } catch {
      setImageFile(file);
      setQualityWarnings([]);
      setError("画像補正に失敗したため、元画像でOCR抽出を行います。");
    } finally {
      setProcessingImage(false);
    }
  };

  const extractFromFile = async (file: File): Promise<ExtractApiResult & { statusOk: boolean }> => {
    const formData = new FormData();
    formData.append("image", file);

    const response = await fetch("/api/ocr/extract", {
      method: "POST",
      body: formData,
    });

    const result = (await response.json()) as ExtractApiResult;
    return {
      ...result,
      statusOk: response.ok,
    };
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
      let result = await extractFromFile(imageFile);

      if ((!result.statusOk || !result.ok || !result.extracted) && originalImageFile && originalImageFile !== imageFile) {
        const fallback = await extractFromFile(originalImageFile);
        if (fallback.statusOk && fallback.ok && fallback.extracted) {
          result = fallback;
          setSuccess("補正画像で抽出できなかったため、元画像で再抽出しました。内容を確認して保存してください。");
        }
      }

      if (!result.statusOk || !result.ok || !result.extracted) {
        setError(result.error ?? "OCR抽出に失敗しました。画像を撮り直して再実行してください。");
        return;
      }

      setDraft(result.extracted);
      setRawText(result.rawText ?? "");
      if (!success) {
        setSuccess("OCR抽出が完了しました。内容を確認して保存してください。");
      }
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
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button
                className="btn secondary"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={{ minHeight: 48, minWidth: 180 }}
              >
                カメラで撮影 / 画像選択
              </button>
              <span style={{ alignSelf: "center", color: "#6b7280", fontSize: 12 }}>
                端末標準カメラを使います（スマホ / iPad対応）
              </span>
            </div>

            {selectedFileName ? <p style={{ margin: 0, fontSize: 13 }}>選択中: {selectedFileName}</p> : null}
            {processingImage ? <p style={{ margin: 0, color: "#1d4ed8" }}>画像をスキャン用に最適化しています...</p> : null}

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
                overflow: "hidden",
              }}
            >
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="票画像プレビュー"
                  style={{ width: "100%", height: "100%", objectFit: "contain", background: "#fff" }}
                />
              ) : (
                <div>
                  票全体がこの枠に収まるように撮影してください
                  <div style={{ fontSize: 12, fontWeight: 400, color: "#6b7280", marginTop: 4 }}>
                    影・反射を避け、文字がぼけないように固定して撮影してください。
                  </div>
                </div>
              )}
            </div>

            {qualityWarnings.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 18, color: "#92400e", fontSize: 13 }}>
                {qualityWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <button className="btn" type="submit" disabled={extracting || processingImage || !imageFile} style={{ minHeight: 48 }}>
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
