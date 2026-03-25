import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/client";
import ExcelJS from "exceljs";

/** Column definition: DB field → Japanese header */
const COLUMNS: Array<{ header: string; key: string; width?: number }> = [
  { header: "作業指示番号", key: "work_order_number" },
  { header: "製品名", key: "product_name" },
  { header: "STO伝票", key: "sto_number" },
  { header: "依頼部署", key: "request_department" },
  { header: "品番", key: "model_number" },
  { header: "製造番号", key: "serial_number" },
  { header: "承認番号", key: "approval_number" },
  { header: "お客様名", key: "customer_name" },
  { header: "申請区分", key: "request_type" },
  { header: "症状", key: "symptom" },
];

/** Map DB enum values to readable Japanese labels */
function categoryLabel(value: string | null): string {
  switch (value) {
    case "washing_machine":
      return "洗濯機";
    case "refrigerator":
      return "冷蔵庫";
    case "microwave":
      return "電子レンジ";
    default:
      return value ?? "";
  }
}

function statusLabel(value: string | null): string {
  switch (value) {
    case "stored":
      return "保管中";
    case "collected":
      return "回収済";
    case "returned":
      return "返却済";
    default:
      return value ?? "";
  }
}

function formatDate(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

/** Auto-fit column width based on header and cell content */
function autoFitColumns(sheet: ExcelJS.Worksheet): void {
  sheet.columns.forEach((column) => {
    let maxLength = 0;

    // Check header length (Japanese characters count as ~2)
    const headerStr = String(column.header ?? "");
    const headerLen = [...headerStr].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
    maxLength = headerLen;

    // Check each cell
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      const cellStr = String(cell.value ?? "");
      const cellLen = [...cellStr].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
      if (cellLen > maxLength) maxLength = cellLen;
    });

    column.width = Math.max(maxLength + 2, 8);
  });
}

export async function GET() {
  try {
    const supabase = createSupabaseServiceClient();

    const { data: rows, error } = await supabase
      .from("appliance_slips")
      .select("*")
      .order("received_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "kaikai-app";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("家電伝票一覧");

    // Set columns
    sheet.columns = COLUMNS.map((col) => ({
      header: col.header,
      key: col.key,
      width: col.width,
    }));

    // Style header row
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.alignment = { horizontal: "center", vertical: "middle" };
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFD9E1F2" },
      };
    });

    // Add data rows
    for (const row of rows ?? []) {
      sheet.addRow({
        work_order_number: row.work_order_number ?? "",
        product_name: row.product_name ?? categoryLabel(row.appliance_category),
        sto_number: row.sto_number ?? "",
        request_department: row.request_department ?? "",
        model_number: row.model_number ?? "",
        serial_number: row.serial_number ?? "",
        approval_number: row.approval_number ?? "",
        customer_name: row.customer_name ?? "",
        request_type: row.request_type ?? "",
        symptom: row.symptom ?? "",
      });
    }

    // Auto-fit column widths
    autoFitColumns(sheet);

    // Apply borders to all cells
    const lastRow = sheet.rowCount;
    const lastCol = COLUMNS.length;
    for (let r = 1; r <= lastRow; r++) {
      for (let c = 1; c <= lastCol; c++) {
        const cell = sheet.getCell(r, c);
        cell.border = {
          top: { style: "thin" },
          left: { style: "thin" },
          bottom: { style: "thin" },
          right: { style: "thin" },
        };
      }
    }

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();

    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const fileName = `家電伝票一覧_${timestamp}.xlsx`;

    return new NextResponse(buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
