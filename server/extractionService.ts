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
  supplierContactName: string | null;
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
    /** PO number associated with this specific line item (e.g. from a Cust Ref column) */
    poNumber?: string | null;
    /** Raw customer reference field (may contain container number + PO number) */
    custRef?: string | null;
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
  supplierContactName: null,
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

/**
 * Post-process extracted data to apply PO number regex pattern matching.
 * PO numbers follow the pattern: 1-2 uppercase letters (commonly AD, BD, DD, ED, A, B, D, E)
 * followed by exactly 6 digits. E.g. AD123456, BD001234, A123456.
 * Searches the poNumber field, all line item descriptions, and a combined text blob.
 */
export function applyPoNumberRegex(data: ExtractedInvoiceData, rawText?: string): string | null {
  // Pattern: 1-2 uppercase letters + exactly 6 digits, as a whole word/token
  const PO_PATTERN = /\b([A-Z]{1,2}\d{6})\b/g;

  // Priority 1: if LLM already found a poNumber, validate it matches pattern
  if (data.poNumber) {
    const match = data.poNumber.match(/^[A-Z]{1,2}\d{6}$/);
    if (match) return data.poNumber;
    // LLM found something but it doesn't match — still search below
  }

  // Priority 2: search line item descriptions for PO pattern
  for (const li of data.lineItems) {
    const m = li.description.match(PO_PATTERN);
    if (m && m.length > 0) return m[0];
  }

  // Priority 3: build a combined text blob from ALL string fields on the extracted data
  // This covers invoiceNumber, notes, supplierName, and any reference text the LLM captured
  const combinedFields = [
    data.invoiceNumber,
    data.notes,
    data.supplierName,
    data.supplierAddress,
    rawText,
  ]
    .filter(Boolean)
    .join(" ");

  if (combinedFields) {
    const matches = combinedFields.match(PO_PATTERN);
    if (matches && matches.length > 0) return matches[0];
  }

  // If we reach here, nothing matched the valid pattern — return null
  return null;
}

/**
 * Extracts ALL unique PO numbers from the invoice data (not just the first one).
 * Uses the same PO_PATTERN and searches all text sources.
 */
export function extractAllPoNumbers(data: ExtractedInvoiceData | null | undefined, rawText?: string): string[] {
  if (!data) return [];
  const PO_PATTERN = /\b([A-Z]{1,2}\d{6})\b/g;
  const found = new Set<string>();

  // From LLM-identified top-level poNumber
  if (data.poNumber && /^[A-Z]{1,2}\d{6}$/.test(data.poNumber)) {
    found.add(data.poNumber);
  }

  // From all line items — check description, poNumber field, and custRef
  for (const li of (data.lineItems ?? [])) {
    // Per-line-item poNumber (structured field — most reliable)
    if (li.poNumber && /^[A-Z]{1,2}\d{6}$/.test(li.poNumber)) {
      found.add(li.poNumber);
    }
    // Per-line-item custRef (may contain container + PO, e.g. "CBHU4279322 P702739")
    if (li.custRef) {
      const custRefMatches = li.custRef.match(PO_PATTERN);
      if (custRefMatches) custRefMatches.forEach((m) => found.add(m));
    }
    // Description text scan
    if (li.description) {
      const descMatches = li.description.match(PO_PATTERN);
      if (descMatches) descMatches.forEach((m) => found.add(m));
    }
  }

  // From combined text fields
  const combinedFields = [
    data.invoiceNumber,
    data.notes,
    data.supplierName,
    data.supplierAddress,
    rawText,
  ]
    .filter(Boolean)
    .join(" ");

  if (combinedFields) {
    const matches = combinedFields.match(PO_PATTERN);
    if (matches) matches.forEach((m) => found.add(m));
  }

  return Array.from(found);
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
    supplierContactName: { type: ["string", "null"] },
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
          poNumber: { type: ["string", "null"] },
          custRef: { type: ["string", "null"] },
        },
        required: ["description", "quantity", "unitPrice", "amount", "taxRate", "poNumber", "custRef"],
        additionalProperties: false,
      },
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    notes: { type: ["string", "null"] },
  },
  required: [
    "invoiceNumber", "poNumber", "containerNumbers", "supplierName",
    "supplierAbn", "supplierEmail", "supplierPhone", "supplierAddress",
    "supplierContactName", "invoiceDate", "dueDate", "subtotal", "tax",
    "total", "currency", "lineItems", "confidence", "notes",
  ],
  additionalProperties: false,
};

const EXTRACTION_PROMPT = `Extract all data from this invoice PDF and return it as JSON with this exact structure:
{
  "invoiceNumber": "string or null",
  "poNumber": "The primary/first Purchase Order number found on the invoice, or null. PO numbers are 1-2 uppercase letters followed by exactly 6 digits. Known supplier prefixes: P (Pacific National), SL (Straitlink), AZ (Aurizon), TR (Tasmanian Railways). Also look for AD, BD, DD, ED and other 1-2 letter prefixes. Search ALL text including reference fields, Cust Ref columns, descriptions, and line items.",
  "containerNumbers": ["array of container numbers like MSCU1234567 — ISO 6346 format: 4 letters + 7 digits"],
  "supplierName": "full legal company name or null",
  "supplierAbn": "Australian Business Number (11 digits) or null",
  "supplierEmail": "supplier email address or null",
  "supplierPhone": "supplier phone number or null",
  "supplierAddress": "full supplier address or null",
  "supplierContactName": "name of the contact person at the supplier (e.g. accounts person, salesperson) or null",
  "invoiceDate": "YYYY-MM-DD or null",
  "dueDate": "YYYY-MM-DD or null",
  "subtotal": number or null (before tax),
  "tax": number or null (GST/VAT amount),
  "total": number or null (final amount due),
  "currency": "3-letter currency code, default AUD",
  "lineItems": [
    {
      "description": "full line item description text",
      "quantity": number|null,
      "unitPrice": number|null,
      "amount": number|null (the line item amount/total, excluding GST if shown separately),
      "taxRate": number|null (e.g. 10 for 10% GST),
      "poNumber": "PO number for THIS specific line item — 1-2 uppercase letters + 6 digits (e.g. P702739, SL123456). Look in the Cust Ref column, reference column, or any column adjacent to this line. Extract ONLY the PO number token, not the full ref. null if not found.",
      "custRef": "The full raw customer reference string for this line item (e.g. 'CBHU4279322 P702739'). This is the entire Cust Ref / Customer Reference field value for this line. null if not found."
    }
  ],
  "confidence": "high if all key fields found, medium if some missing, low if very little data",
  "notes": "any additional observations, warnings, or context — or null"
}
Rules:
- Container numbers: ISO 6346 format (4 letters + 7 digits, e.g. MSCU1234567)
- ABN: 11 digits, often formatted as XX XXX XXX XXX — normalise to digits only
- All monetary values must be numbers (not strings)
- PO numbers: 1-2 uppercase letters + exactly 6 digits. IMPORTANT: On freight/rail invoices, each line item often has its own PO number in a 'Cust Ref' or 'Customer Reference' column. Extract the PO number per line item into the poNumber field.
- For Pacific National invoices: the Cust Ref column contains a container number followed by a PO number (e.g. 'CBHU4279322 P702739'). The PO number is the P-prefixed token.
- Use null for any field not found
Return ONLY valid JSON. No markdown, no explanation.`;

function parseJsonFromContent(content: string): ExtractedInvoiceData | null {
  try {
    const parsed = JSON.parse(content.trim());
    if (parsed && typeof parsed === "object" && "invoiceNumber" in parsed) {
      return parsed as ExtractedInvoiceData;
    }
  } catch {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        if (parsed && typeof parsed === "object") return parsed as ExtractedInvoiceData;
      } catch {}
    }
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
        parsed.poNumber = applyPoNumberRegex(parsed);
        console.log(`[Extraction] Attempt 1 succeeded. Confidence: ${parsed.confidence}, PO: ${parsed.poNumber}`);
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
        parsed.poNumber = applyPoNumberRegex(parsed);
        console.log(`[Extraction] Attempt 2 succeeded. Confidence: ${parsed.confidence}, PO: ${parsed.poNumber}`);
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
        parsed.poNumber = applyPoNumberRegex(parsed);
        console.log(`[Extraction] Attempt 3 succeeded. Confidence: ${parsed.confidence}, PO: ${parsed.poNumber}`);
        return parsed;
      }
    }
    throw new Error("Empty or unparseable response");
  } catch (err) {
    console.error("[Extraction] All attempts failed:", (err as Error).message);
  }

  return FALLBACK;
}
