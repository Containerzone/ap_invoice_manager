import { useState, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { Upload, FileText, X, ArrowLeft, Loader2, CheckCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export default function InvoiceUpload() {
  const [, setLocation] = useLocation();
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadedInvoiceId, setUploadedInvoiceId] = useState<number | null>(null);
  const [step, setStep] = useState<"select" | "uploading" | "extracting" | "done">("select");

  const uploadMutation = trpc.invoices.upload.useMutation();
  const extractMutation = trpc.invoices.extract.useMutation();

  const handleFile = useCallback((file: File) => {
    if (file.type !== "application/pdf") {
      toast.error("Only PDF files are supported");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.error("File size must be under 20MB");
      return;
    }
    setSelectedFile(file);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleProcess = async () => {
    if (!selectedFile) return;

    try {
      setStep("uploading");

      // Convert file to base64
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(",")[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(selectedFile);
      });

      // Upload to server
      const { invoiceId } = await uploadMutation.mutateAsync({
        fileName: selectedFile.name,
        fileBase64: base64,
        mimeType: "application/pdf",
      });

      setUploadedInvoiceId(invoiceId);
      setStep("extracting");

      // Run extraction
      const extractResult = await extractMutation.mutateAsync({ invoiceId });

      setStep("done");

      // Surface duplicate warnings before navigating
      const localDup = (extractResult as any).duplicateWarning as string | undefined;
      const xeroDup = (extractResult as any).xeroBillDuplicateWarning as string | undefined;

      if (localDup) {
        toast.warning(`Duplicate detected: ${localDup}`, { duration: 10000 });
      } else if (xeroDup) {
        toast.warning(`Possible duplicate in Xero: ${xeroDup}`, { duration: 10000 });
      } else {
        toast.success("Invoice uploaded and data extracted successfully");
      }

      // Navigate to invoice detail after short delay (longer if duplicate warning shown)
      setTimeout(() => setLocation(`/invoices/${invoiceId}`), localDup || xeroDup ? 3000 : 1500);
    } catch (err: any) {
      toast.error(err?.message ?? "Upload failed");
      setStep("select");
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-muted-foreground"
          onClick={() => setLocation("/invoices")}
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-semibold text-foreground tracking-tight">Upload Invoice</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload a PDF invoice to extract data and verify against Xero
        </p>
      </div>

      {/* Upload Area */}
      <Card className="border shadow-sm">
        <CardContent className="p-6">
          {step === "select" && (
            <>
              <div
                className={cn(
                  "relative border-2 border-dashed rounded-xl p-10 text-center transition-all cursor-pointer",
                  dragActive
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50 hover:bg-muted/30"
                )}
                onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                onClick={() => document.getElementById("file-input")?.click()}
              >
                <input
                  id="file-input"
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFile(file);
                  }}
                />
                <div className="flex flex-col items-center gap-3">
                  <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center">
                    <Upload className="h-7 w-7 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      Drop your PDF here, or{" "}
                      <span className="text-primary underline underline-offset-2">browse</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">PDF files up to 20MB</p>
                  </div>
                </div>
              </div>

              {selectedFile && (
                <div className="mt-4 flex items-center gap-3 p-3.5 bg-muted/40 rounded-xl border">
                  <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <FileText className="h-4.5 w-4.5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{selectedFile.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground shrink-0"
                    onClick={(e) => { e.stopPropagation(); setSelectedFile(null); }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              )}

              <div className="mt-5 flex gap-3">
                <Button
                  className="flex-1 gap-2"
                  disabled={!selectedFile}
                  onClick={handleProcess}
                >
                  <Upload className="h-4 w-4" />
                  Upload & Extract Data
                </Button>
              </div>
            </>
          )}

          {(step === "uploading" || step === "extracting") && (
            <div className="flex flex-col items-center gap-5 py-8">
              <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                <Loader2 className="h-8 w-8 text-primary animate-spin" />
              </div>
              <div className="text-center">
                <p className="text-base font-medium text-foreground">
                  {step === "uploading" ? "Uploading invoice..." : "Extracting data with AI..."}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {step === "uploading"
                    ? "Securely storing your PDF"
                    : "Reading invoice details, amounts, and container numbers"}
                </p>
              </div>
              {/* Progress steps */}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className={cn("flex items-center gap-1", step !== "uploading" && "text-emerald-600")}>
                  {step !== "uploading" ? <CheckCircle className="h-3.5 w-3.5" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Upload
                </span>
                <span className="text-border">→</span>
                <span className={cn("flex items-center gap-1", step === "extracting" && "text-primary")}>
                  {step === "extracting" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span className="h-3.5 w-3.5 rounded-full border border-border inline-block" />}
                  Extract
                </span>
                <span className="text-border">→</span>
                <span className="flex items-center gap-1">
                  <span className="h-3.5 w-3.5 rounded-full border border-border inline-block" />
                  Review
                </span>
              </div>
            </div>
          )}

          {step === "done" && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="h-16 w-16 rounded-2xl bg-emerald-50 flex items-center justify-center">
                <CheckCircle className="h-8 w-8 text-emerald-500" />
              </div>
              <div className="text-center">
                <p className="text-base font-medium text-foreground">Invoice processed successfully</p>
                <p className="text-sm text-muted-foreground mt-1">Redirecting to invoice detail...</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Info */}
      <div className="rounded-xl border bg-muted/30 p-4 space-y-2">
        <p className="text-xs font-medium text-foreground">What happens after upload?</p>
        <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside">
          <li>The PDF is securely stored and scanned using AI</li>
          <li>Invoice number, amounts, PO numbers, and container numbers are extracted</li>
          <li>The supplier is matched against your database or flagged for creation</li>
          <li>You can verify the extracted data and compare against Xero</li>
        </ol>
      </div>
    </div>
  );
}
