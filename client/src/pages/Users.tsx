import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Users as UsersIcon, ShieldCheck, User, Loader2, UserPlus, Mail, Trash2, CheckCircle2,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { formatRelativeTime } from "@/lib/invoiceUtils";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

export default function Users() {
  const { user: currentUser } = useAuth();
  const utils = trpc.useUtils();

  const { data: users, isLoading } = trpc.users.list.useQuery();
  const { data: invites, isLoading: invitesLoading } = trpc.users.listInvites.useQuery();

  const updateRoleMutation = trpc.users.updateRole.useMutation();
  const createInviteMutation = trpc.users.createInvite.useMutation();
  const deleteInviteMutation = trpc.users.deleteInvite.useMutation();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"user" | "admin">("user");
  const [inviteName, setInviteName] = useState("");

  const handleRoleChange = async (userId: number, newRole: "admin" | "user") => {
    try {
      await updateRoleMutation.mutateAsync({ userId, role: newRole });
      await utils.users.list.invalidate();
      toast.success(`User role updated to ${newRole}`);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to update role");
    }
  };

  const handleCreateInvite = async () => {
    if (!inviteEmail) return;
    try {
      await createInviteMutation.mutateAsync({ email: inviteEmail, role: inviteRole, name: inviteName || undefined });
      await utils.users.listInvites.invalidate();
      toast.success(`Invite created for ${inviteEmail}`);
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("user");
      setInviteName("");
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to create invite");
    }
  };

  const handleDeleteInvite = async (id: number, email: string) => {
    try {
      await deleteInviteMutation.mutateAsync({ id });
      await utils.users.listInvites.invalidate();
      toast.success(`Invite for ${email} removed`);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to remove invite");
    }
  };

  const pendingInvites = invites?.filter((i) => !i.claimedAt) ?? [];
  const claimedInvites = invites?.filter((i) => i.claimedAt) ?? [];
  const canAddInvite = pendingInvites.length < 3;

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage user access and permissions
          </p>
        </div>
        <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2" disabled={!canAddInvite}>
              <UserPlus className="h-4 w-4" />
              Invite User
              {!canAddInvite && <span className="text-xs opacity-70">(max 3)</span>}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Invite a New User</DialogTitle>
              <DialogDescription>
                Enter the user's email address and role. They will be automatically assigned
                this role when they sign in for the first time. You can have up to 3 pending
                invites at a time.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="invite-email">Email Address <span className="text-destructive">*</span></Label>
                <Input
                  id="invite-email"
                  type="email"
                  placeholder="user@example.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-name">Display Name (optional)</Label>
                <Input
                  id="invite-name"
                  placeholder="Jane Smith"
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-role">Role</Label>
                <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as "user" | "admin")}>
                  <SelectTrigger id="invite-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">Staff — Upload invoices, approve within thresholds, create queries</SelectItem>
                    <SelectItem value="admin">Admin — Full access including user management</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
              <Button
                onClick={handleCreateInvite}
                disabled={!inviteEmail || createInviteMutation.isPending}
              >
                {createInviteMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" />Creating…</>
                ) : (
                  "Create Invite"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Role legend */}
      <div className="flex flex-wrap items-center gap-4 p-4 bg-muted/40 rounded-xl border text-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <span className="font-medium text-foreground">Admin</span>
          <span className="text-muted-foreground">— Full access: manage users, suppliers, settings, all invoices</span>
        </div>
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium text-foreground">Staff</span>
          <span className="text-muted-foreground">— Upload invoices, approve within thresholds, create queries</span>
        </div>
      </div>

      {/* Pending Invites */}
      {(pendingInvites.length > 0 || invitesLoading) && (
        <Card className="border shadow-sm overflow-hidden">
          <CardHeader className="pb-3 border-b bg-muted/20">
            <CardTitle className="text-base font-medium flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" />
              Pending Invites
              <Badge variant="secondary" className="ml-1 text-xs">{pendingInvites.length}/3</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {invitesLoading ? (
              <div className="divide-y divide-border">
                {[...Array(2)].map((_, i) => (
                  <div key={i} className="flex items-center gap-4 px-5 py-4">
                    <Skeleton className="h-9 w-9 rounded-full" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-4 w-48" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                    <Skeleton className="h-7 w-16" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {pendingInvites.map((invite) => (
                  <div key={invite.id} className="flex items-center gap-4 px-5 py-3.5">
                    <div className="h-9 w-9 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                      <Mail className="h-4 w-4 text-amber-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {invite.name ?? invite.email}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {invite.name ? invite.email : "Awaiting sign-in"} · Created {formatRelativeTime(invite.createdAt)}
                      </p>
                    </div>
                    <Badge
                      className={invite.role === "admin"
                        ? "gap-1 bg-primary/10 text-primary border-primary/20 hover:bg-primary/10"
                        : "gap-1"}
                      variant={invite.role === "admin" ? "outline" : "secondary"}
                    >
                      {invite.role === "admin" ? <ShieldCheck className="h-3 w-3" /> : <User className="h-3 w-3" />}
                      {invite.role === "admin" ? "Admin" : "Staff"}
                    </Badge>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          disabled={deleteInviteMutation.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove Invite</AlertDialogTitle>
                          <AlertDialogDescription>
                            Remove the pending invite for <strong>{invite.email}</strong>?
                            They will not be able to join unless re-invited.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => handleDeleteInvite(invite.id, invite.email)}
                          >
                            Remove
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Active Users */}
      <Card className="border shadow-sm overflow-hidden">
        <CardHeader className="pb-3 border-b bg-muted/20">
          <CardTitle className="text-base font-medium flex items-center gap-2">
            <UsersIcon className="h-4 w-4 text-muted-foreground" />
            Active Users
            {users && <Badge variant="secondary" className="ml-1 text-xs">{users.length}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="divide-y divide-border">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-5 py-4">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-56" />
                  </div>
                  <Skeleton className="h-7 w-20" />
                </div>
              ))}
            </div>
          ) : users?.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <UsersIcon className="h-12 w-12 text-muted-foreground/25 mb-4" />
              <p className="text-base font-medium text-foreground">No users yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Users appear here once they sign in
              </p>
            </div>
          ) : (
            <>
              <div className="hidden md:grid grid-cols-[1fr_1fr_120px_100px_80px] gap-4 px-5 py-2.5 bg-muted/40 border-b text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <span>Name</span>
                <span>Email</span>
                <span>Last Sign-in</span>
                <span>Role</span>
                <span></span>
              </div>
              <div className="divide-y divide-border">
                {users?.map((u) => {
                  const isSelf = u.id === currentUser?.id;
                  return (
                    <div
                      key={u.id}
                      className="grid grid-cols-1 md:grid-cols-[1fr_1fr_120px_100px_80px] gap-2 md:gap-4 items-center px-5 py-3.5"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar className="h-9 w-9 shrink-0">
                          <AvatarFallback className="text-sm font-medium bg-primary/10 text-primary">
                            {(u.name ?? u.email ?? "?")[0].toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {u.name ?? "Unknown"}
                            {isSelf && (
                              <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground md:hidden">{u.email}</p>
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground truncate hidden md:block">
                        {u.email ?? "—"}
                      </p>
                      <p className="text-xs text-muted-foreground hidden md:block">
                        {formatRelativeTime(u.lastSignedIn)}
                      </p>
                      <div className="flex items-center gap-2">
                        {u.role === "admin" ? (
                          <Badge className="gap-1 bg-primary/10 text-primary border-primary/20 hover:bg-primary/10">
                            <ShieldCheck className="h-3 w-3" />
                            Admin
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1">
                            <User className="h-3 w-3" />
                            Staff
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center justify-end">
                        {!isSelf && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs text-muted-foreground hover:text-foreground"
                                disabled={updateRoleMutation.isPending}
                              >
                                {updateRoleMutation.isPending ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  "Change"
                                )}
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Change User Role</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Change {u.name}'s role from{" "}
                                  <strong>{u.role === "admin" ? "Admin" : "Staff"}</strong> to{" "}
                                  <strong>{u.role === "admin" ? "Staff" : "Admin"}</strong>?
                                  {u.role === "admin" && (
                                    <span className="block mt-1 text-amber-600">
                                      This will remove their admin access.
                                    </span>
                                  )}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() =>
                                    handleRoleChange(u.id, u.role === "admin" ? "user" : "admin")
                                  }
                                >
                                  Confirm Change
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Claimed Invites (history) */}
      {claimedInvites.length > 0 && (
        <Card className="border shadow-sm overflow-hidden">
          <CardHeader className="pb-3 border-b bg-muted/20">
            <CardTitle className="text-base font-medium flex items-center gap-2 text-muted-foreground">
              <CheckCircle2 className="h-4 w-4" />
              Claimed Invites
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {claimedInvites.map((invite) => (
                <div key={invite.id} className="flex items-center gap-4 px-5 py-3 opacity-60">
                  <div className="h-8 w-8 rounded-full bg-green-100 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate">{invite.email}</p>
                    <p className="text-xs text-muted-foreground">
                      Claimed {invite.claimedAt ? formatRelativeTime(invite.claimedAt) : ""}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-xs">
                    {invite.role === "admin" ? "Admin" : "Staff"}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
