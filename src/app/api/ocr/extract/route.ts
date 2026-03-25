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

function normalizeLine(value: string): string {
  return value.replace(/[ \t　]+/g, " ").trim();
}

function sanitizeExtractedValue(value: string): string {
  return value
    .replace(/^["'`「『]+/, "")
    .replace(/["'`」』]+$/, "")
    .replace(/^(?:\([^)]{2,}\)|（[^）]{2,}）)+\s*/, "")
    .trim();
}

function toNormalizedLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => normalizeLine(line))
    .filter((line) => line.length > 0)
    .filter((line) => !/^\d+$/.test(line));
}

function looksLikeLabelLine(line: string, labels: string[]): boolean {
  const normalized = normalizeLine(line).toLowerCase();
  return labels.some((label) => normalized.includes(label.toLowerCase()));
}

const ALL_KNOWN_LABELS: string[] = [
  "返品票", "AQUA", "本体に貼付",
  "STO伝票", "STO番号", "参伝No",
  "承認番号", "承認No",
  "作業指示番号", "作業依頼番号", "指示番号", "依頼番号", "作業番号",
  "交換業者名", "販売店", "販売会社", "取引先",
  "返品品番", "旧品番", "型式", "型番", "形式",
  "製造番号", "製番", "製造No",
  "申請区分", "依頼区分", "処理区分",
  "症状", "不具合", "現象",
  "調査レベル", "点検レベル", "点検区分", "判定",
  "返品先", "返却先", "送付先",
  "品名", "製品名",
  "お客様名", "顧客名", "氏名",
  "依頼部署", "部署", "部門",
];

function pickLineLabelValue(text: string, labels: string[]): string {
  const lines = toNormalizedLines(text);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lowered = line.toLowerCase();

    for (const label of labels) {
      const loweredLabel = label.toLowerCase();
      const index = lowered.indexOf(loweredLabel);

      if (index < 0) {
        continue;
      }

      const afterLabel = line
        .slice(index + label.length)
        .replace(/^(?:[\s　:：\-ー*]|\([^)]{2,}\)|（[^）]{2,}）)*/,"")
        .trim();

      if (afterLabel && !looksLikeLabelLine(afterLabel, ALL_KNOWN_LABELS)) {
        return afterLabel;
      }

      for (let next = i + 1; next < Math.min(i + 4, lines.length); next += 1) {
        const candidate = lines[next].trim();
        if (!candidate) {
          continue;
        }
        if (looksLikeLabelLine(candidate, ALL_KNOWN_LABELS)) {
          continue;
        }
        return candidate;
      }
    }
  }

  return "";
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

  return sanitizeExtractedValue(normalizeText(matched.normalizedValue?.text ?? matched.mentionText ?? ""));
}

function pickRegexValue(text: string, regexes: RegExp[]): string {
  for (const regex of regexes) {
    const match = text.match(regex);
    if (match?.[1]) {
      return sanitizeExtractedValue(normalizeText(match[1]));
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
    pickLineLabelValue(text, ["STO伝票", "STO番号", "参伝No", "sto number"]) ||
    pickRegexValue(normalizedText, [
      /STO伝票(?:\([^)]*\)|（[^）]*）)?[\s:：\-]*([A-Z0-9\-]+)/i,
      /STO(?:番号)?[\s:：\-]*([A-Z0-9\-]+)/i,
      /参伝\s*No\.?[\s:：\-]*([A-Z0-9\-]+)/i,
      /sto\s*no\.?[\s:：\-]*([A-Z0-9\-]+)/i,
    ]);

  const approvalNumber =
    pickEntityValue(entities, ["approval", "approval_number", "承認"]) ||
    pickLineLabelValue(text, ["承認番号", "承認No", "approval", "approval number"]) ||
    pickRegexValue(normalizedText, [
      /承認(?:番号|No)?[\s:：\-]*([A-Z0-9\-]+)/i,
      /approval(?:\s*number)?[\s:：\-]*([A-Z0-9\-]+)/i,
    ]);

  const workOrderNumber =
    pickEntityValue(entities, ["work_order", "workorder", "作業", "依頼"]) ||
    pickLineLabelValue(text, [
      "作業指示番号",
      "作業依頼番号",
      "指示番号",
      "依頼番号",
      "作業番号",
      "work order",
    ]) ||
    pickRegexValue(normalizedText, [
      /作業指示(?:票)?番号[\s:：\-]*([A-Z0-9\-]+)/i,
      /作業依頼(?:票)?番号[\s:：\-]*([A-Z0-9\-]+)/i,
      /指示(?:票)?番号[\s:：\-]*([A-Z0-9\-]+)/i,
      /依頼(?:票)?番号[\s:：\-]*([A-Z0-9\-]+)/i,
      /work\s*order[\s:：\-]*([A-Z0-9\-]+)/i,
    ]);

  const modelNumber =
    pickEntityValue(entities, ["model", "型式", "型番"]) ||
    pickLineLabelValue(text, ["返品品番", "旧品番", "型式", "型番", "形式", "model"]) ||
    pickRegexValue(normalizedText, [
      /返品品番(?:\s*\(?旧品番\)?)?[\s:：\-]*([A-Z0-9\-\/()]+)/i,
      /型(?:式|番|式\/型番)[\s:：\-]*([A-Z0-9\-\/]+)/i,
      /model[\s:：\-]*([A-Z0-9\-\/]+)/i,
    ]);

  const serialNumber =
    pickEntityValue(entities, ["serial", "製造", "製番"]) ||
    pickLineLabelValue(text, ["製造番号", "製番", "serial", "S/N"]) ||
    pickRegexValue(normalizedText, [
      /製造番号[\s:：\-]*([A-Z0-9\-\/]+)/i,
      /serial(?:\s*number)?[\s:：\-]*([A-Z0-9\-\/]+)/i,
      /S\/N[\s:：\-]*([A-Z0-9\-\/]+)/i,
    ]);

  const requestType =
    pickEntityValue(entities, ["request_type", "依頼区分", "request"]) ||
    pickLineLabelValue(text, ["申請区分", "依頼区分", "処理区分", "request type"]) ||
    pickRegexValue(normalizedText, [
      /申請区分[\s:：\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i,
      /依頼区分[\s:：\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i,
      /処理区分[\s:：\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i,
    ]);

  const vendorName =
    pickEntityValue(entities, ["vendor", "販売", "業者", "取引先"]) ||
    pickLineLabelValue(text, ["交換業者名", "販売店", "販売会社", "取引先", "vendor"]) ||
    pickRegexValue(normalizedText, [
      /交換業者名[\s:：\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i,
      /販売(?:店|会社)?[\s:\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i,
    ]);

  const productName =
    pickEntityValue(entities, ["product", "製品", "品名"]) ||
    pickLineLabelValue(text, ["品名", "製品名", "product"]) ||
    pickRegexValue(normalizedText, [/品名[\s:\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i]);

  const customerName =
    pickEntityValue(entities, ["customer", "お客様", "顧客", "氏名"]) ||
    pickLineLabelValue(text, ["お客様名", "顧客名", "氏名", "customer"]) ||
    pickRegexValue(normalizedText, [/(?:お客様名|顧客名|氏名)[\s:\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i]);

  const requestDepartment =
    pickEntityValue(entities, ["department", "部署", "部門"]) ||
    pickLineLabelValue(text, ["依頼部署", "部署", "部門", "department"]) ||
    pickRegexValue(normalizedText, [/(?:依頼部署|部署|部門)[\s:\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i]);

  const symptom =
    pickEntityValue(entities, ["symptom", "症状", "不具合"]) ||
    pickLineLabelValue(text, ["症状", "不具合", "現象", "symptom"]) ||
    pickRegexValue(normalizedText, [/(?:症状|不具合)[\s:\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i]);

  const inspectionLevel =
    pickEntityValue(entities, ["inspection", "点検", "判定"]) ||
    pickLineLabelValue(text, ["調査レベル", "点検レベル", "点検区分", "判定", "inspection"]) ||
    pickRegexValue(normalizedText, [
      /(?:調査レベル|点検区分|点検レベル|判定)[\s:\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i,
    ]);

  const returnDestination =
    pickEntityValue(entities, ["return_destination", "返却", "送付先"]) ||
    pickLineLabelValue(text, ["返品先", "返却先", "送付先", "返却先名", "return destination"]) ||
    pickRegexValue(normalizedText, [/(?:返品先|返却先|送付先)[\s:\-]*(.+?)(?:\s[A-Z0-9\-]{2,}|$)/i]);

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
