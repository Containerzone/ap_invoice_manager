import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function XeroCallback() {
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("");

  const callbackMutation = trpc.xero.callback.useMutation();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const error = params.get("error");
    const redirectUri = `${window.location.origin}/xero/callback`;

    if (error) {
      setStatus("error");
      setMessage(error === "access_denied" ? "Access was denied" : `Xero error: ${error}`);
      return;
    }

    if (!code) {
      setStatus("error");
      setMessage("No authorization code received from Xero");
      return;
    }

    callbackMutation
      .mutateAsync({ code, redirectUri })
      .then(() => {
        setStatus("success");
        setMessage("Xero connected successfully");
        setTimeout(() => setLocation("/settings"), 2000);
      })
      .catch((err: any) => {
        setStatus("error");
        setMessage(err?.message ?? "Failed to complete Xero authentication");
      });
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-5 text-center max-w-sm px-4">
        {status === "loading" && (
          <>
            <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Loader2 className="h-8 w-8 text-primary animate-spin" />
            </div>
            <div>
              <p className="text-base font-semibold text-foreground">Connecting to Xero</p>
              <p className="text-sm text-muted-foreground mt-1">Please wait while we complete the connection...</p>
            </div>
          </>
        )}
        {status === "success" && (
          <>
            <div className="h-16 w-16 rounded-2xl bg-emerald-50 flex items-center justify-center">
              <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            </div>
            <div>
              <p className="text-base font-semibold text-foreground">Connected!</p>
              <p className="text-sm text-muted-foreground mt-1">{message}</p>
              <p className="text-xs text-muted-foreground mt-1">Redirecting to settings...</p>
            </div>
          </>
        )}
        {status === "error" && (
          <>
            <div className="h-16 w-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
              <XCircle className="h-8 w-8 text-destructive" />
            </div>
            <div>
              <p className="text-base font-semibold text-foreground">Connection Failed</p>
              <p className="text-sm text-muted-foreground mt-1">{message}</p>
            </div>
            <Button variant="outline" onClick={() => setLocation("/settings")}>
              Back to Settings
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
