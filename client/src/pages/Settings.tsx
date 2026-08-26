import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  CheckCircle2, ExternalLink, Loader2, RefreshCw,
  Settings as SettingsIcon, Unlink, Zap, Mail, Shield, AlertTriangle
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";

export default function Settings() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const { data: xeroStatus, isLoading: xeroLoading, refetch: refetchXero } =
    trpc.xero.status.useQuery();
  const disconnectMutation = trpc.xero.disconnect.useMutation();
  const { data: microsoftStatus, refetch: refetchMicrosoft } = trpc.microsoft.status.useQuery(undefined, { enabled: isAdmin });
  const enableMicrosoftMutation = trpc.microsoft.enableInboxProcessing.useMutation();

  const utils = trpc.useUtils();

  const handleXeroConnect = async () => {
    try {
      const redirectUri = `${window.location.origin}/xero/callback`;
      const { url } = await utils.xero.getAuthUrl.fetch({ redirectUri });
      window.location.href = url;
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to get Xero auth URL — ensure XERO_CLIENT_ID is configured");
    }
  };

  const handleXeroDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      await refetchXero();
      toast.success("Xero disconnected");
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to disconnect Xero");
    }
  };

  const handleEnableMicrosoftInbox = async () => {
    try {
      const result = await enableMicrosoftMutation.mutateAsync({ origin: window.location.origin });
      await refetchMicrosoft();
      toast.success(`Microsoft invoice mailbox enabled until ${new Date(result.subscriptionExpiresAt).toLocaleString()}`);
    } catch (e: any) {
      toast.error(e?.message ?? "Unable to enable Microsoft invoice mailbox");
    }
  };

  if (!isAdmin) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Shield className="h-12 w-12 text-muted-foreground/30 mb-4" />
          <p className="text-base font-medium text-foreground">Admin Access Required</p>
          <p className="text-sm text-muted-foreground mt-1">
            Only administrators can access settings
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-foreground tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage integrations and application configuration
        </p>
      </div>

      {/* Xero Integration */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Zap className="h-4 w-4 text-muted-foreground" />
            Xero Integration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {xeroLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-9 w-36" />
            </div>
          ) : xeroStatus?.connected ? (
            <div className="space-y-4">
              {xeroStatus.rateLimit?.active && (
                <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-300 rounded-xl">
                  <AlertTriangle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-red-900">
                      Xero {xeroStatus.rateLimit.problem === "day" ? "Daily" : "API"} Request Limit Reached
                    </p>
                    <p className="text-sm text-red-800 mt-0.5">
                      Xero has instructed the application to pause this organisation until{" "}
                      <strong>
                        {xeroStatus.rateLimit.pausedUntil
                          ? new Date(xeroStatus.rateLimit.pausedUntil).toLocaleString("en-AU")
                          : "the limit resets"}
                      </strong>.
                    </p>
                    <p className="text-xs text-red-700 mt-1">
                      The application will not send further Xero requests during this pause. Daily calls remaining: {xeroStatus.rateLimit.dayRemaining ?? 0}; minute calls remaining: {xeroStatus.rateLimit.minuteRemaining ?? "unknown"}.
                    </p>
                  </div>
                </div>
              )}
              {/* Missing attachments scope warning — shown when token lacks accounting.attachments */}
              {!xeroStatus.hasAttachmentsScope && (
                <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-300 rounded-xl">
                  <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-amber-800">Re-authentication Required</p>
                    <p className="text-sm text-amber-700 mt-0.5">
                      Your current Xero token is missing the <code className="bg-amber-100 px-1 rounded text-xs font-mono">accounting.attachments</code> permission.
                      PDF attachments to Xero bills will fail with a 401 error until you re-authenticate.
                    </p>
                    <p className="text-xs text-amber-600 mt-1">
                      Click <strong>Re-authenticate</strong> below to reconnect Xero and grant the required permission.
                    </p>
                  </div>
                </div>
              )}
              <div className={`flex items-start gap-3 p-4 rounded-xl border ${
                xeroStatus.hasAttachmentsScope
                  ? "bg-emerald-50 border-emerald-200"
                  : "bg-muted/40 border-border"
              }`}>
                <CheckCircle2 className={`h-5 w-5 shrink-0 mt-0.5 ${
                  xeroStatus.hasAttachmentsScope ? "text-emerald-500" : "text-muted-foreground"
                }`} />
                <div>
                  <p className={`text-sm font-semibold ${
                    xeroStatus.hasAttachmentsScope ? "text-emerald-800" : "text-foreground"
                  }`}>Connected to Xero</p>
                  {xeroStatus.tenantName && (
                    <p className={`text-sm mt-0.5 ${
                      xeroStatus.hasAttachmentsScope ? "text-emerald-700" : "text-muted-foreground"
                    }`}>
                      Organisation: <strong>{xeroStatus.tenantName}</strong>
                    </p>
                  )}
                  {xeroStatus.expiresAt && (
                    <p className={`text-xs mt-1 ${
                      xeroStatus.hasAttachmentsScope ? "text-emerald-600" : "text-muted-foreground"
                    }`}>
                      Token expires: {new Date(xeroStatus.expiresAt).toLocaleString("en-AU")}
                    </p>
                  )}
                  <p className={`text-xs mt-1 ${
                    xeroStatus.hasAttachmentsScope ? "text-emerald-600" : "text-amber-600 font-medium"
                  }`}>
                    PDF attachments: {xeroStatus.hasAttachmentsScope ? "✓ Enabled" : "✗ Missing scope — re-authenticate required"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant={xeroStatus.hasAttachmentsScope ? "outline" : "default"}
                  size="sm"
                  className="gap-2"
                  onClick={handleXeroConnect}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Re-authenticate
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 text-destructive border-destructive/30 hover:bg-destructive/5"
                  onClick={handleXeroDisconnect}
                  disabled={disconnectMutation.isPending}
                >
                  {disconnectMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Unlink className="h-3.5 w-3.5" />
                  )}
                  Disconnect
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-4 bg-muted/40 border rounded-xl">
                <p className="text-sm text-muted-foreground">
                  Connect your Xero account to verify invoice amounts and create draft bills for payment approval.
                </p>
                <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground list-disc list-inside">
                  <li>Automatically verify extracted invoice amounts against Xero bills</li>
                  <li>Flag discrepancies between supplier invoices and Xero records</li>
                  <li>Push resolved invoices as draft bills ready for payment approval</li>
                </ul>
              </div>
              <Button
                onClick={handleXeroConnect}
                className="gap-2"
              >
                <ExternalLink className="h-4 w-4" />
                Connect to Xero
              </Button>
              <p className="text-xs text-muted-foreground">
                You'll need a Xero account with API access. Configure your Xero app credentials in the environment variables first.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      {/* Email Configuration */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" />
            Email Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div className="p-3 bg-muted/40 rounded-lg border">
              <p className="text-xs text-muted-foreground">From Address</p>
              <p className="text-sm font-medium text-foreground mt-0.5">admin@containerzone.com.au</p>
            </div>
            <div className="p-3 bg-muted/40 rounded-lg border">
              <p className="text-xs text-muted-foreground">SMTP Host</p>
              <p className="text-sm font-medium text-foreground mt-0.5">
                {import.meta.env.VITE_SMTP_CONFIGURED === "true" ? "Configured" : "smtp.office365.com"}
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Email credentials are configured via environment variables. Dispute emails are sent from admin@containerzone.com.au via Microsoft 365.
          </p>
          <div className="rounded-lg border bg-emerald-50/50 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">Invoice email upload</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Send supplier PDFs to <span className="font-medium">{microsoftStatus?.invoiceAlias ?? "invoices@containerzone.com.au"}</span>. The app watches the admin mailbox and accepts PDF attachments only.
                </p>
              </div>
              <Button size="sm" onClick={handleEnableMicrosoftInbox} disabled={enableMicrosoftMutation.isPending}>
                {enableMicrosoftMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : microsoftStatus?.subscriptionId ? "Renew connection" : "Enable inbox"}
              </Button>
            </div>
            {microsoftStatus?.subscriptionId ? (
              <p className="text-xs text-emerald-800">Connected. Subscription expires {microsoftStatus.subscriptionExpiresAt ? new Date(microsoftStatus.subscriptionExpiresAt).toLocaleString() : "soon"}; renewal runs automatically.</p>
            ) : (
              <p className="text-xs text-amber-800">Not yet activated. Enable this after publishing the current version so Microsoft can validate the secure webhook.</p>
            )}
            {microsoftStatus?.lastSubscriptionError && <p className="text-xs text-destructive">{microsoftStatus.lastSubscriptionError}</p>}
            {microsoftStatus?.submissions?.length ? (
              <div className="border-t pt-2 mt-2 space-y-1.5">
                <p className="text-xs font-medium text-foreground">Recent email submissions</p>
                {microsoftStatus.submissions.slice(0, 5).map((submission) => (
                  <div key={submission.id} className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate text-muted-foreground">{submission.attachmentName} · {submission.senderAddress ?? "Unknown sender"}</span>
                    <span className={submission.status === "processed" ? "text-emerald-700 font-medium" : submission.status === "failed" ? "text-destructive font-medium" : "text-amber-700 font-medium"}>{submission.status}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Separator />

      {/* About */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <SettingsIcon className="h-4 w-4 text-muted-foreground" />
            About
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Application</p>
              <p className="font-medium text-foreground">AP Invoice Manager</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Organisation</p>
              <p className="font-medium text-foreground">ContainerZone</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Version</p>
              <p className="font-medium text-foreground">1.0.0</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Logged in as</p>
              <p className="font-medium text-foreground">{user?.name ?? "—"}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
