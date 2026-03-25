import type { OcrApplianceCategoryOption } from "@/types/appliance";

export interface OcrExtractedDraft {
  sto_number: string;
  approval_number: string;
  work_order_number: string;
  vendor_name: string | null;
  model_number: string;
  serial_number: string;
  request_type: string;
  symptom: string | null;
  inspection_level: string | null;
  return_destination: string | null;
  product_name: string | null;
  request_department: string | null;
  customer_name: string | null;
  appliance_category: OcrApplianceCategoryOption;
  appliance_category_other: string | null;
}
