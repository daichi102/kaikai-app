import { NextResponse } from "next/server";
import type { ApplianceCategory } from "@/types/appliance";
import type { OcrExtractedDraft } from "@/types/ocr";
import { createSign } from "node:crypto";

type DocumentEntity = {
  type?: string;
  mentionText?: string;
  confidence?: number;
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

type ExtractResponse = {
  ok: true;
  extracted: OcrExtractedDraft;
  rawText: string;
};

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
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
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

function normalizeText(value: string): string {
  return value.replace(/[\s　]+/g, " ").trim();
}

function chooseCategory(text: string): ApplianceCategory {
  const normalized = text.toLowerCase();
  if (normalized.includes("洗濯") || normalized.includes("washing")) {
    return "washing_machine";
  }
  if (normalized.includes("冷蔵") || normalized.includes("refrigerator")) {
    return "refrigerator";
  }
  return "microwave";
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

  return normalizeText(matched.normalizedValue?.text ?? matched.mentionText ?? "");
}

function pickRegexValue(text: string, regexes: RegExp[]): string {
  for (const regex of regexes) {
    const match = text.match(regex);
    if (match?.[1]) {
      return normalizeText(match[1]);
    }
  }
  return "";
}

function pickNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function mapToDraft(text: string, entities: DocumentEntity[]): OcrExtractedDraft {
  const normalizedText = normalizeText(text);

  const stoNumber =
    pickEntityValue(entities, ["sto", "sto_number"]) ||
    pickRegexValue(normalizedText, [/STO[\s:\-]*([A-Z0-9\-]+)/i, /STO番号[\s:\-]*([A-Z0-9\-]+)/i]);

  const approvalNumber =
    pickEntityValue(entities, ["approval", "approval_number", "承認"]) ||
    pickRegexValue(normalizedText, [/承認番号[\s:\-]*([A-Z0-9\-]+)/i, /approval[\s:\-]*([A-Z0-9\-]+)/i]);

  const workOrderNumber =
    pickEntityValue(entities, ["work_order", "workorder", "作業", "依頼"]) ||
    pickRegexValue(normalizedText, [/作業依頼(?:票)?番号[\s:\-]*([A-Z0-9\-]+)/i, /work\s*order[\s:\-]*([A-Z0-9\-]+)/i]);

  const modelNumber =
    pickEntityValue(entities, ["model", "型式", "型番"]) ||
    pickRegexValue(normalizedText, [/型(?:式|番)[\s:\-]*([A-Z0-9\-]+)/i, /model[\s:\-]*([A-Z0-9\-]+)/i]);

  const serialNumber =
    pickEntityValue(entities, ["serial", "製造", "製番"]) ||
    pickRegexValue(normalizedText, [/製造番号[\s:\-]*([A-Z0-9\-]+)/i, /serial[\s:\-]*([A-Z0-9\-]+)/i]);

  const requestType =
    pickEntityValue(entities, ["request_type", "依頼区分", "request"]) ||
    pickRegexValue(normalizedText, [/依頼区分[\s:\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i]);

  const vendorName =
    pickEntityValue(entities, ["vendor", "販売", "業者", "取引先"]) ||
    pickRegexValue(normalizedText, [/販売(?:店|会社)?[\s:\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i]);

  const productName =
    pickEntityValue(entities, ["product", "製品", "品名"]) ||
    pickRegexValue(normalizedText, [/品名[\s:\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i]);

  const customerName =
    pickEntityValue(entities, ["customer", "お客様", "顧客", "氏名"]) ||
    pickRegexValue(normalizedText, [/(?:お客様名|顧客名|氏名)[\s:\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i]);

  const requestDepartment =
    pickEntityValue(entities, ["department", "部署", "部門"]) ||
    pickRegexValue(normalizedText, [/(?:依頼部署|部署|部門)[\s:\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i]);

  const symptom =
    pickEntityValue(entities, ["symptom", "症状", "不具合"]) ||
    pickRegexValue(normalizedText, [/(?:症状|不具合)[\s:\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i]);

  const inspectionLevel =
    pickEntityValue(entities, ["inspection", "点検", "判定"]) ||
    pickRegexValue(normalizedText, [/(?:点検区分|点検レベル|判定)[\s:\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i]);

  const returnDestination =
    pickEntityValue(entities, ["return_destination", "返却", "送付先"]) ||
    pickRegexValue(normalizedText, [/(?:返却先|送付先)[\s:\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i]);

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
    appliance_category: chooseCategory(`${productName} ${requestType} ${normalizedText}`),
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

    const extracted = mapToDraft(rawText, entities);

    const response: ExtractResponse = {
      ok: true,
      extracted,
      rawText,
    };

    return NextResponse.json(response);
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
