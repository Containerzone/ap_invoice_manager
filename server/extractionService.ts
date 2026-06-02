import { invokeLLM } from "./_core/llm";
import { storageGetSignedUrl } from "./storage";

export interface ExtractedInvoiceData {
  invoiceNumber: string | null;
  poNumber: string | null;
  containerNumbers: string[];
  supplierName: string | null;
  supplierAbn: string | null;
  supplierEmail: string | null;
  supplierPhone: string | null;
  supplierAddress: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  currency: string;
  lineItems: Array<{
    description: string;
    quantity: number | null;
    unitPrice: number | null;
    amount: number | null;
    taxRate: number | null;
  }>;
  confidence: "high" | "medium" | "low";
  notes: string | null;
}

const FALLBACK: ExtractedInvoiceData = {
  invoiceNumber: null,
  poNumber: null,
  containerNumbers: [],
  supplierName: null,
  supplierAbn: null,
  supplierEmail: null,
  supplierPhone: null,
  supplierAddress: null,
  invoiceDate: null,
  dueDate: null,
  subtotal: null,
  tax: null,
  total: null,
  currency: "AUD",
  lineItems: [],
  confidence: "low",
  notes: "Extraction failed — please review manually.",
};

/**
 * Strip the /manus-storage/ prefix to get the raw storage key.
 */
function resolveStorageKey(fileUrlOrKey: string): string {
  return fileUrlOrKey.replace(/^\/manus-storage\//, "");
}

/**
 * Fetch PDF bytes from S3 via a signed URL and return as base64.
 */
async function fetchPdfAsBase64(fileKey: string): Promise<string> {
  const signedUrl = await storageGetSignedUrl(fileKey);
  const response = await fetch(signedUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch PDF from storage: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer).toString("base64");
}

const JSON_SCHEMA = {
  type: "object",
  properties: {
    invoiceNumber: { type: ["string", "null"] },
    poNumber: { type: ["string", "null"] },
    containerNumbers: { type: "array", items: { type: "string" } },
    supplierName: { type: ["string", "null"] },
    supplierAbn: { type: ["string", "null"] },
    supplierEmail: { type: ["string", "null"] },
    supplierPhone: { type: ["string", "null"] },
    supplierAddress: { type: ["string", "null"] },
    invoiceDate: { type: ["string", "null"] },
    dueDate: { type: ["string", "null"] },
    subtotal: { type: ["number", "null"] },
    tax: { type: ["number", "null"] },
    total: { type: ["number", "null"] },
    currency: { type: "string" },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          quantity: { type: ["number", "null"] },
          unitPrice: { type: ["number", "null"] },
          amount: { type: ["number", "null"] },
          taxRate: { type: ["number", "null"] },
        },
        required: ["description", "quantity", "unitPrice", "amount", "taxRate"],
        additionalProperties: false,
      },
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    notes: { type: ["string", "null"] },
  },
  required: [
    "invoiceNumber", "poNumber", "containerNumbers", "supplierName",
    "supplierAbn", "supplierEmail", "supplierPhone", "supplierAddress",
    "invoiceDate", "dueDate", "subtotal", "tax", "total", "currency",
    "lineItems", "confidence", "notes",
  ],
  additionalProperties: false,
};

const EXTRACTION_PROMPT = `Extract all data from this invoice PDF and return it as JSON with this exact structure:
{
  "invoiceNumber": "string or null",
  "poNumber": "string or null - Purchase Order number",
  "containerNumbers": ["array of container numbers like MSCU1234567"],
  "supplierName": "string or null",
  "supplierAbn": "string or null - Australian Business Number (11 digits)",
  "supplierEmail": "string or null",
  "supplierPhone": "string or null",
  "supplierAddress": "string or null",
  "invoiceDate": "YYYY-MM-DD or null",
  "dueDate": "YYYY-MM-DD or null",
  "subtotal": number or null,
  "tax": number or null (GST amount),
  "total": number or null,
  "currency": "AUD",
  "lineItems": [{ "description": "string", "quantity": number|null, "unitPrice": number|null, "amount": number|null, "taxRate": number|null }],
  "confidence": "high|medium|low",
  "notes": "any additional observations or null"
}
Rules:
- Container numbers: ISO 6346 format (4 letters + 7 digits, e.g. MSCU1234567)
- ABN: 11 digits, often formatted as XX XXX XXX XXX
- All monetary values must be numbers (not strings)
- Use null for any field not found
- confidence = "high" if all key fields found, "medium" if some missing, "low" if very little data
Return ONLY valid JSON. No markdown, no explanation.`;

function parseJsonFromContent(content: string): ExtractedInvoiceData | null {
  try {
    // Try direct parse first
    const parsed = JSON.parse(content.trim());
    if (parsed && typeof parsed === "object" && "invoiceNumber" in parsed) {
      return parsed as ExtractedInvoiceData;
    }
  } catch {
    // Try extracting JSON from markdown code blocks
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        if (parsed && typeof parsed === "object") return parsed as ExtractedInvoiceData;
      } catch {}
    }
    // Try finding raw JSON object in the response
    const objMatch = content.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        const parsed = JSON.parse(objMatch[0]);
        if (parsed && typeof parsed === "object") return parsed as ExtractedInvoiceData;
      } catch {}
    }
  }
  return null;
}

export async function extractInvoiceData(
  fileUrlOrKey: string
): Promise<ExtractedInvoiceData> {
  const storageKey = resolveStorageKey(fileUrlOrKey);
  console.log(`[Extraction] Starting extraction for key: ${storageKey}`);

  let pdfBase64: string;
  try {
    pdfBase64 = await fetchPdfAsBase64(storageKey);
    console.log(`[Extraction] PDF fetched: ${Math.round(pdfBase64.length * 0.75 / 1024)}KB`);
  } catch (err) {
    console.error("[Extraction] Failed to fetch PDF from storage:", err);
    return { ...FALLBACK, notes: `Could not retrieve PDF file: ${(err as Error).message}` };
  }

  const dataUrl = `data:application/pdf;base64,${pdfBase64}`;

  // --- Attempt 1: Gemini 2.5 Flash with PDF data URI + JSON schema ---
  try {
    console.log("[Extraction] Attempt 1: Gemini 2.5 Flash with JSON schema...");
    const response = await invokeLLM({
      model: "gemini-2.5-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "file_url", file_url: { url: dataUrl, mime_type: "application/pdf" } },
            { type: "text", text: EXTRACTION_PROMPT },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "invoice_extraction", strict: true, schema: JSON_SCHEMA },
      },
    });

    const content = response.choices?.[0]?.message?.content;
    if (content && typeof content === "string") {
      const parsed = parseJsonFromContent(content);
      if (parsed) {
        console.log(`[Extraction] Attempt 1 succeeded. Confidence: ${parsed.confidence}`);
        return parsed;
      }
    }
    throw new Error("Empty or unparseable response from Gemini");
  } catch (err) {
    console.warn("[Extraction] Attempt 1 failed:", (err as Error).message);
  }

  // --- Attempt 2: Claude Sonnet with PDF data URI, plain JSON mode ---
  try {
    console.log("[Extraction] Attempt 2: Claude Sonnet with json_object mode...");
    const response = await invokeLLM({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "system",
          content: "You are an expert invoice data extraction assistant for container freight and logistics. Return ONLY valid JSON. No markdown, no explanation.",
        },
        {
          role: "user",
          content: [
            { type: "file_url", file_url: { url: dataUrl, mime_type: "application/pdf" } },
            { type: "text", text: EXTRACTION_PROMPT },
          ],
        },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices?.[0]?.message?.content;
    if (content && typeof content === "string") {
      const parsed = parseJsonFromContent(content);
      if (parsed) {
        console.log(`[Extraction] Attempt 2 succeeded. Confidence: ${parsed.confidence}`);
        return parsed;
      }
    }
    throw new Error("Empty or unparseable response from Claude");
  } catch (err) {
    console.warn("[Extraction] Attempt 2 failed:", (err as Error).message);
  }

  // --- Attempt 3: Gemini without strict schema, just text prompt ---
  try {
    console.log("[Extraction] Attempt 3: Gemini without strict schema...");
    const response = await invokeLLM({
      model: "gemini-2.5-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "file_url", file_url: { url: dataUrl, mime_type: "application/pdf" } },
            { type: "text", text: EXTRACTION_PROMPT },
          ],
        },
      ],
    });

    const content = response.choices?.[0]?.message?.content;
    if (content && typeof content === "string") {
      const parsed = parseJsonFromContent(content);
      if (parsed) {
        console.log(`[Extraction] Attempt 3 succeeded. Confidence: ${parsed.confidence}`);
        return parsed;
      }
    }
    throw new Error("Empty or unparseable response");
  } catch (err) {
    console.error("[Extraction] All attempts failed:", (err as Error).message);
  }

  return FALLBACK;
}
