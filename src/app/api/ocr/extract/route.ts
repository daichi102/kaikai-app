import { NextResponse } from "next/server";
import { createSign } from "node:crypto";
import type { OcrApplianceCategoryOption } from "@/types/appliance";
import type { OcrExtractedDraft } from "@/types/ocr";

type DocumentEntity = {
  type?: string;
  mentionText?: string;
  normalizedValue?: {
    text?: string;
  };
};

type ProcessResponse = {
  document?: {
    text?: string;
    entities?: DocumentEntity[];
  };
};

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

const OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const OAUTH_AUDIENCE = "https://oauth2.googleapis.com/token";

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseServiceAccountKey(raw: string): ServiceAccountKey {
  const parsed = JSON.parse(raw) as ServiceAccountKey;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Invalid GCP_SERVICE_ACCOUNT_KEY. client_email/private_key is required.");
  }
  return parsed;
}

function base64Url(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signJwt(header: string, payload: string, privateKey: string): string {
  const encodedHeader = base64Url(header);
  const encodedPayload = base64Url(payload);
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();

  const signature = signer
    .sign(privateKey)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  return `${unsignedToken}.${signature}`;
}

async function createAccessToken(serviceAccount: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = serviceAccount.token_uri ?? OAUTH_AUDIENCE;

  const header = JSON.stringify({ alg: "RS256", typ: "JWT" });
  const payload = JSON.stringify({
    iss: serviceAccount.client_email,
    scope: OAUTH_SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  });

  const assertion = signJwt(header, payload, serviceAccount.private_key);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch access token: ${errorText}`);
  }

  const tokenResult = (await response.json()) as { access_token?: string };
  if (!tokenResult.access_token) {
    throw new Error("Access token missing in OAuth response.");
  }

  return tokenResult.access_token;
}

function getMimeType(file: File): string {
  if (file.type) {
    return file.type;
  }

  const lowered = file.name.toLowerCase();
  if (lowered.endsWith(".jpg") || lowered.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lowered.endsWith(".png")) {
    return "image/png";
  }
  return "application/octet-stream";
}

function normalizeLine(value: string): string {
  return value.replace(/[\u3000\t ]+/g, " ").trim();
}

function normalizeText(value: string): string {
  return value.replace(/[\u3000\s]+/g, " ").trim();
}

function toLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => normalizeLine(line))
    .filter((line) => line.length > 0)
    .filter((line) => !/^\d+$/.test(line))
    .filter((line) => !/^(?:19|20)\d{2}[./年]\d{1,2}[./月]/.test(line))
    .filter((line) => !/午前|午後|AM|PM|\d{1,2}:\d{2}/.test(line));
}

function cleanValue(value: string): string {
  return normalizeText(
    value
      .replace(/^[\s:：|｜・-]+/, "")
      .replace(/[（(]\s*空白の場合[^）)]*[）)]/g, "")
      .replace(/空白の場合[^、。\n]*(?:記入|入力)?[ー一\-]*/g, "")
      .replace(/[（(]\s*参伝No\.?\s*[）)]/g, "")
      .replace(/[（(]\s*旧品番\s*[）)]/g, "")
      .replace(/[（(]\s*梱包に貼付\s*[）)]/g, "")
      .replace(/[\s|｜]+$/g, ""),
  );
}

function isValueLike(value: string): boolean {
  return /[A-Za-z0-9（）()]/.test(value);
}

const LABELS = {
  sto_number: [/STO\s*伝票/i, /STO\s*(?:No|番号)/i],
  approval_number: [/承認番号/i],
  work_order_number: [/作業指示番号/i],
  vendor_name: [/交換業者名/i, /販売店/i],
  model_number: [/返品品番/i, /型式[\/／]型番/i, /型番/i],
  serial_number: [/製造番号/i, /シリアル/i],
  request_type: [/申請区分/i, /依頼区分/i],
  symptom: [/症状/i],
  inspection_level: [/調査レベル/i, /点検レベル/i],
  return_destination: [/返品先/i, /返却先/i],
  product_name: [/品名/i],
  request_department: [/依頼部署/i],
  customer_name: [/顧客名/i],
} as const;

const ALL_LABEL_PATTERNS = Object.values(LABELS).flat();

function isLikelyLabel(text: string): boolean {
  return ALL_LABEL_PATTERNS.some((pattern) => pattern.test(text));
}

function sliceFormLines(lines: string[]): string[] {
  if (lines.length === 0) {
    return lines;
  }

  const startIndex = lines.findIndex((line) => /返品票|STO\s*伝票|承認番号/.test(line));
  const lastRelevant = lines
    .map((line, index) => ({ line, index }))
    .reverse()
    .find(({ line }) => /返(?:品|却)先|調査レベル|点検レベル|症状/.test(line));
  const endIndex = lastRelevant?.index ?? lines.length - 1;

  if (startIndex === -1 || endIndex <= startIndex) {
    return lines;
  }

  return lines.slice(startIndex, endIndex + 2);
}

function isLikelyNoise(text: string): boolean {
  if (/\d{1,2}[/／]\d{1,2}\s+[^\d]/.test(text)) {
    return true;
  }
  if (/^[④③②①⑤⑥⑦⑧⑨⑩]/.test(text)) {
    return true;
  }
  if (/[都道府県市区町村](?:$|\s)/.test(text) && !/倉庫|センター|検品/.test(text)) {
    return true;
  }
  return false;
}

type LabelField = keyof typeof LABELS;

function isValidByField(field: LabelField, value: string): boolean {
  if (!value || isLikelyLabel(value) || isLikelyNoise(value)) {
    return false;
  }

  switch (field) {
    case "sto_number":
      return /^\d{8,12}$/.test(value.replace(/[-\s]/g, ""));
    case "approval_number":
      return /^[A-Z]\d{5,}[A-Z0-9]*$/i.test(value.replace(/[-\s]/g, ""));
    case "work_order_number":
      return /^\d{6,10}$/.test(value.replace(/[-\s]/g, ""));
    case "model_number":
      return /^[A-Z]{2,}[-A-Z0-9()\/（）]{3,}$/i.test(value.replace(/\s/g, ""));
    case "serial_number":
      return /^[A-Z0-9()（）\/-]{5,}$/i.test(value.replace(/\s/g, ""));
    case "request_type":
      return /商品|交換|同機種|異機種|修理|返品|回収/.test(value) && !/\d{1,2}\/\d{1,2}/.test(value);
    case "symptom":
    case "inspection_level":
    case "return_destination":
    case "product_name":
    case "request_department":
    case "customer_name":
    case "vendor_name":
      return !isLikelyNoise(value);
    default:
      return true;
  }
}

function extractByLabel(lines: string[], field: LabelField, patterns: readonly RegExp[]): string {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!patterns.some((pattern) => pattern.test(line))) {
      continue;
    }

    const inlineRaw = line
      .replace(patterns[0], "")
      .replace(/^[^:：]*[:：]/, "");
    const inline = cleanValue(inlineRaw);

    const inlineHasNumber = /[0-9A-Za-z]/.test(inline);
    if (inline && inlineHasNumber && !isLikelyLabel(inline) && isValueLike(inline) && isValidByField(field, inline)) {
      return inline;
    }

    for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
      const candidate = cleanValue(lines[j]);
      if (!candidate || isLikelyLabel(candidate) || !isValidByField(field, candidate)) {
        continue;
      }
      return candidate;
    }
  }

  return "";
}

function pickEntityValue(entities: DocumentEntity[], keys: string[]): string {
  const keySet = keys.map((key) => key.toLowerCase());
  const matched = entities.find((entity) => {
    const type = (entity.type ?? "").toLowerCase();
    return keySet.some((key) => type.includes(key));
  });

  if (!matched) {
    return "";
  }

  return cleanValue(matched.normalizedValue?.text ?? matched.mentionText ?? "");
}

function pickRegexValue(text: string, regexes: RegExp[]): string {
  for (const regex of regexes) {
    const match = text.match(regex);
    if (match?.[1]) {
      return cleanValue(match[1]);
    }
  }
  return "";
}

function pickNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function chooseCategory(text: string): OcrApplianceCategoryOption {
  const normalized = text.toLowerCase();

  if (normalized.includes("ドラム")) {
    return "washing_machine_drum";
  }
  if (normalized.includes("aqw") || normalized.includes("洗濯") || normalized.includes("washing")) {
    return "washing_machine_vertical";
  }

  if (normalized.includes("冷蔵") || normalized.includes("refrigerator")) {
    const liters = normalized.match(/(\d{3})\s*[lｌＬ]/);
    if (liters?.[1]) {
      return Number(liters[1]) > 400 ? "refrigerator_over_400" : "refrigerator_400_or_less";
    }
    return "refrigerator_400_or_less";
  }

  if (normalized.includes("レンジ") || normalized.includes("microwave")) {
    return "microwave";
  }

  return "other";
}

function mapToDraft(text: string, entities: DocumentEntity[]): OcrExtractedDraft {
  const lines = toLines(text);
  const normalizedText = normalizeText(text);

  const stoNumber =
    extractByLabel(lines, "sto_number", LABELS.sto_number) ||
    pickEntityValue(entities, ["sto", "sto_number"]) ||
    pickRegexValue(normalizedText, [
      /STO[^A-Z0-9]*([A-Z0-9-]{6,})/i,
      /\b(\d{8,12})\b/,
    ]);
  const normalizedSto =
    /\d/.test(stoNumber)
      ? stoNumber
      : pickRegexValue(normalizedText, [
          /STO[^A-Z0-9]*([A-Z0-9-]{6,})/i,
          /\b(\d{8,12})\b/,
        ]);

  const approvalNumber =
    extractByLabel(lines, "approval_number", LABELS.approval_number) ||
    pickEntityValue(entities, ["approval", "approval_number"]) ||
    pickRegexValue(normalizedText, [/承認番号[^A-Z0-9]*([A-Z0-9-]{6,})/i]);
  const normalizedApproval =
    /\d/.test(approvalNumber)
      ? approvalNumber
      : pickRegexValue(normalizedText, [/承認番号[^A-Z0-9]*([A-Z0-9-]{6,})/i, /\b([A-Z0-9]{6,})\b/]);

  const workOrderNumber =
    extractByLabel(lines, "work_order_number", LABELS.work_order_number) ||
    pickRegexValue(normalizedText, [
      /作業指示番号[^A-Z0-9]*([A-Z0-9-]{6,})/i,
      /\b(\d{8,10})\b/,
    ]);
  const normalizedWorkOrder =
    /\d/.test(workOrderNumber)
      ? workOrderNumber
      : pickRegexValue(normalizedText, [
          /作業指示番号[^A-Z0-9]*([A-Z0-9-]{6,})/i,
          /\b(\d{8,10})\b/,
        ]);

  const vendorName =
    extractByLabel(lines, "vendor_name", LABELS.vendor_name) ||
    pickEntityValue(entities, ["vendor", "dealer", "shop"]);

  const modelNumber =
    extractByLabel(lines, "model_number", LABELS.model_number) ||
    pickEntityValue(entities, ["model", "model_number"]) ||
    pickRegexValue(normalizedText, [/(AQW[-A-Z0-9()/]+)/i]);

  const serialNumber =
    extractByLabel(lines, "serial_number", LABELS.serial_number) ||
    pickEntityValue(entities, ["serial", "serial_number"]) ||
    pickRegexValue(normalizedText, [/製造番号[^A-Z0-9]*([A-Z0-9()/-]{5,})/i]);

  const requestType =
    extractByLabel(lines, "request_type", LABELS.request_type) ||
    pickEntityValue(entities, ["request_type", "request"]) ||
    pickRegexValue(normalizedText, [/申請区分[^\n]*?([\p{L}\p{N}()（）\-・ ]{3,})/u]);

  const symptom =
    extractByLabel(lines, "symptom", LABELS.symptom) ||
    pickEntityValue(entities, ["symptom"]);

  const inspectionLevel =
    extractByLabel(lines, "inspection_level", LABELS.inspection_level) ||
    pickEntityValue(entities, ["inspection", "level"]);

  const returnDestination =
    extractByLabel(lines, "return_destination", LABELS.return_destination) ||
    pickEntityValue(entities, ["return_destination"]);

  const productName = extractByLabel(lines, "product_name", LABELS.product_name) || pickEntityValue(entities, ["product"]);

  const requestDepartment =
    extractByLabel(lines, "request_department", LABELS.request_department) ||
    pickEntityValue(entities, ["department"]);

  const customerName =
    extractByLabel(lines, "customer_name", LABELS.customer_name) ||
    pickEntityValue(entities, ["customer", "client"]);

  return {
    sto_number: normalizedSto,
    approval_number: normalizedApproval,
    work_order_number: normalizedWorkOrder,
    vendor_name: pickNullable(vendorName),
    model_number: modelNumber,
    serial_number: serialNumber,
    request_type: requestType,
    symptom: pickNullable(symptom),
    inspection_level: pickNullable(inspectionLevel),
    return_destination: pickNullable(returnDestination),
    product_name: pickNullable(productName),
    request_department: pickNullable(requestDepartment),
    customer_name: pickNullable(customerName),
    appliance_category: chooseCategory(`${modelNumber} ${productName} ${requestType} ${normalizedText}`),
    appliance_category_other: null,
  };
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const image = formData.get("image");

    if (!(image instanceof File)) {
      return NextResponse.json({ ok: false, error: "image file is required." }, { status: 400 });
    }

    const projectId = getRequiredEnv("GCP_PROJECT_ID");
    const location = getRequiredEnv("GCP_LOCATION");
    const processorId = getRequiredEnv("GCP_PROCESSOR_ID");
    const serviceAccountRaw = getRequiredEnv("GCP_SERVICE_ACCOUNT_KEY");

    const serviceAccount = parseServiceAccountKey(serviceAccountRaw);
    const accessToken = await createAccessToken(serviceAccount);

    const bytes = await image.arrayBuffer();
    const contentBase64 = Buffer.from(bytes).toString("base64");

    const endpoint = `https://${location}-documentai.googleapis.com/v1/projects/${projectId}/locations/${location}/processors/${processorId}:process`;

    const processResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rawDocument: {
          content: contentBase64,
          mimeType: getMimeType(image),
        },
      }),
    });

    if (!processResponse.ok) {
      const errorText = await processResponse.text();
      return NextResponse.json(
        { ok: false, error: `Document AI request failed: ${errorText}` },
        { status: 502 },
      );
    }

    const processResult = (await processResponse.json()) as ProcessResponse;
    const rawText = processResult.document?.text ?? "";
    const entities = processResult.document?.entities ?? [];

    return NextResponse.json({
      ok: true,
      extracted: mapToDraft(rawText, entities),
      rawText,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unexpected OCR extract error",
      },
      { status: 500 },
    );
  }
}
