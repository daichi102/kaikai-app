import { NextResponse } from "next/server";
import { createSign } from "node:crypto";
import type { ApplianceCategory } from "@/types/appliance";
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
    .filter((line) => !/^\d+$/.test(line));
}

function cleanValue(value: string): string {
  return normalizeText(
    value
      .replace(/^[\s:：|｜・-]+/, "")
      .replace(/[\s|｜]+$/g, ""),
  );
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

function extractByLabel(lines: string[], patterns: readonly RegExp[]): string {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!patterns.some((pattern) => pattern.test(line))) {
      continue;
    }

    const inline = cleanValue(
      line
        .replace(patterns[0], "")
        .replace(/^[^:：]*[:：]/, ""),
    );

    if (inline && !isLikelyLabel(inline)) {
      return inline;
    }

    for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
      const candidate = cleanValue(lines[j]);
      if (!candidate || isLikelyLabel(candidate)) {
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

function chooseCategory(text: string): ApplianceCategory {
  const normalized = text.toLowerCase();

  if (normalized.includes("aqw") || normalized.includes("洗濯") || normalized.includes("washing")) {
    return "washing_machine";
  }
  if (normalized.includes("冷蔵") || normalized.includes("refrigerator")) {
    return "refrigerator";
  }
  return "microwave";
}

function mapToDraft(text: string, entities: DocumentEntity[]): OcrExtractedDraft {
  const lines = toLines(text);
  const normalizedText = normalizeText(text);

  const stoNumber =
    extractByLabel(lines, LABELS.sto_number) ||
    pickEntityValue(entities, ["sto", "sto_number"]) ||
    pickRegexValue(normalizedText, [/STO[^A-Z0-9]*([A-Z0-9-]{6,})/i]);

  const approvalNumber =
    extractByLabel(lines, LABELS.approval_number) ||
    pickEntityValue(entities, ["approval", "approval_number"]) ||
    pickRegexValue(normalizedText, [/承認番号[^A-Z0-9]*([A-Z0-9-]{6,})/i]);

  const workOrderNumber =
    extractByLabel(lines, LABELS.work_order_number) ||
    pickEntityValue(entities, ["work_order", "workorder"]) ||
    pickRegexValue(normalizedText, [/作業指示番号[^A-Z0-9]*([A-Z0-9-]{6,})/i]);

  const vendorName =
    extractByLabel(lines, LABELS.vendor_name) ||
    pickEntityValue(entities, ["vendor", "dealer", "shop"]);

  const modelNumber =
    extractByLabel(lines, LABELS.model_number) ||
    pickEntityValue(entities, ["model", "model_number"]) ||
    pickRegexValue(normalizedText, [/(AQW[-A-Z0-9()/]+)/i]);

  const serialNumber =
    extractByLabel(lines, LABELS.serial_number) ||
    pickEntityValue(entities, ["serial", "serial_number"]) ||
    pickRegexValue(normalizedText, [/製造番号[^A-Z0-9]*([A-Z0-9()/-]{5,})/i]);

  const requestType =
    extractByLabel(lines, LABELS.request_type) ||
    pickEntityValue(entities, ["request_type", "request"]) ||
    pickRegexValue(normalizedText, [/申請区分[^\n]*?([\p{L}\p{N}()（）\-・ ]{3,})/u]);

  const symptom = extractByLabel(lines, LABELS.symptom) || pickEntityValue(entities, ["symptom"]);

  const inspectionLevel =
    extractByLabel(lines, LABELS.inspection_level) || pickEntityValue(entities, ["inspection", "level"]);

  const returnDestination =
    extractByLabel(lines, LABELS.return_destination) || pickEntityValue(entities, ["return_destination"]);

  const productName = extractByLabel(lines, LABELS.product_name) || pickEntityValue(entities, ["product"]);

  const requestDepartment =
    extractByLabel(lines, LABELS.request_department) || pickEntityValue(entities, ["department"]);

  const customerName =
    extractByLabel(lines, LABELS.customer_name) || pickEntityValue(entities, ["customer", "client"]);

  return {
    sto_number: stoNumber,
    approval_number: approvalNumber,
    work_order_number: workOrderNumber,
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
