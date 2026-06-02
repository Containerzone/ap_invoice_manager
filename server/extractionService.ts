import { invokeLLM } from "./_core/llm";

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

export async function extractInvoiceData(pdfUrl: string): Promise<ExtractedInvoiceData> {
  const systemPrompt = `You are an expert invoice data extraction assistant specialised in container freight and logistics invoices.
Extract all relevant information from the provided invoice PDF with high accuracy.
Return ONLY valid JSON matching the specified schema. Do not include any explanation or markdown.`;

  const userPrompt = `Extract all data from this invoice PDF and return it as JSON with this exact structure:
{
  "invoiceNumber": "string or null",
  "poNumber": "string or null - Purchase Order number",
  "containerNumbers": ["array of container numbers like MSCU1234567"],
  "supplierName": "string or null",
  "supplierAbn": "string or null - Australian Business Number",
  "supplierEmail": "string or null",
  "supplierPhone": "string or null",
  "supplierAddress": "string or null",
  "invoiceDate": "YYYY-MM-DD or null",
  "dueDate": "YYYY-MM-DD or null",
  "subtotal": number or null,
  "tax": number or null - GST amount,
  "total": number or null,
  "currency": "AUD",
  "lineItems": [
    {
      "description": "string",
      "quantity": number or null,
      "unitPrice": number or null,
      "amount": number or null,
      "taxRate": number or null
    }
  ],
  "confidence": "high|medium|low",
  "notes": "any additional observations or null"
}

Rules:
- Container numbers follow ISO 6346 format (4 letters + 7 digits, e.g. MSCU1234567)
- ABN is 11 digits, often formatted as XX XXX XXX XXX
- All monetary values should be numbers, not strings
- If a field cannot be found, use null
- confidence = "high" if all key fields found, "medium" if some missing, "low" if very little data`;

  try {
    const response = await invokeLLM({
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "file_url",
              file_url: {
                url: pdfUrl,
                mime_type: "application/pdf",
              },
            },
            { type: "text", text: userPrompt },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "invoice_extraction",
          strict: true,
          schema: {
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
          },
        },
      },
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error("No content in LLM response");

    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    return parsed as ExtractedInvoiceData;
  } catch (error) {
    console.error("[Extraction] LLM extraction failed:", error);
    // Return a minimal fallback
    return {
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
  }
}
