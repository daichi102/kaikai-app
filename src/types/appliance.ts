export type ApplianceCategory = "washing_machine" | "refrigerator" | "microwave";

export type OcrApplianceCategoryOption =
  | "washing_machine_vertical"
  | "washing_machine_drum"
  | "refrigerator_400_or_less"
  | "refrigerator_over_400"
  | "microwave"
  | "other";

export type ApplianceStatus = "stored" | "collected" | "returned";

export interface ApplianceSlip {
  id: string;
  slip_type: string;
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
  appliance_category: ApplianceCategory;
  status: ApplianceStatus;
  ocr_needs_review: boolean;
  duplicate_warning: boolean;
  image_path: string | null;
  registered_by: string | null;
  received_at: string;
  created_at: string;
  updated_at: string;
}
