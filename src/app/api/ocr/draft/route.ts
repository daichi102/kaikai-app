import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/client";
import type { ApplianceCategory } from "@/types/appliance";
import type { OcrExtractedDraft } from "@/types/ocr";

type DraftPayload = OcrExtractedDraft & {
  image_path?: string | null;
  registered_by?: string | null;
};

function toNullable(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeCategory(value: string): ApplianceCategory {
  if (value === "washing_machine" || value === "refrigerator" || value === "microwave") {
    return value;
  }
  return "microwave";
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizePayload(payload: Partial<DraftPayload>): DraftPayload {
  return {
    sto_number: toStringValue(payload.sto_number),
    approval_number: toStringValue(payload.approval_number),
    work_order_number: toStringValue(payload.work_order_number),
    vendor_name: toNullable(payload.vendor_name),
    model_number: toStringValue(payload.model_number),
    serial_number: toStringValue(payload.serial_number),
    request_type: toStringValue(payload.request_type),
    symptom: toNullable(payload.symptom),
    inspection_level: toNullable(payload.inspection_level),
    return_destination: toNullable(payload.return_destination),
    product_name: toNullable(payload.product_name),
    request_department: toNullable(payload.request_department),
    customer_name: toNullable(payload.customer_name),
    appliance_category: normalizeCategory(toStringValue(payload.appliance_category)),
    image_path: toNullable(payload.image_path),
    registered_by: toNullable(payload.registered_by),
  };
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Partial<DraftPayload>;
    const data = sanitizePayload(payload);

    if (
      !data.sto_number ||
      !data.approval_number ||
      !data.work_order_number ||
      !data.model_number ||
      !data.serial_number ||
      !data.request_type
    ) {
      return NextResponse.json(
        { ok: false, error: "必須項目が不足しています。確認して再送信してください。" },
        { status: 400 },
      );
    }

    const supabase = createSupabaseServiceClient();

    const { data: inserted, error } = await supabase
      .from("appliance_slips")
      .insert({
        slip_type: "AQUA返品票",
        sto_number: data.sto_number,
        approval_number: data.approval_number,
        work_order_number: data.work_order_number,
        vendor_name: data.vendor_name,
        model_number: data.model_number,
        serial_number: data.serial_number,
        request_type: data.request_type,
        symptom: data.symptom,
        inspection_level: data.inspection_level,
        return_destination: data.return_destination,
        product_name: data.product_name,
        request_department: data.request_department,
        customer_name: data.customer_name,
        appliance_category: data.appliance_category,
        status: "stored",
        ocr_needs_review: true,
        duplicate_warning: false,
        image_path: data.image_path,
        registered_by: data.registered_by,
      })
      .select("id")
      .single();

    if (error) {
      return NextResponse.json(
        {
          ok: false,
          error:
            error.code === "23505"
              ? "同じ型式+製造番号が既に登録されています。"
              : error.message,
        },
        { status: 409 },
      );
    }

    return NextResponse.json({ ok: true, id: inserted.id });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unexpected draft save error",
      },
      { status: 500 },
    );
  }
}
