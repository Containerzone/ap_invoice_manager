import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { toast } from "sonner";
import { Users as UsersIcon, ShieldCheck, User, Loader2 } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { formatRelativeTime } from "@/lib/invoiceUtils";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export default function Users() {
  const { user: currentUser } = useAuth();
  const utils = trpc.useUtils();
  const { data: users, isLoading } = trpc.users.list.useQuery();
  const updateRoleMutation = trpc.users.updateRole.useMutation();

  const handleRoleChange = async (userId: number, newRole: "admin" | "user") => {
    try {
      await updateRoleMutation.mutateAsync({ userId, role: newRole });
      await utils.users.list.invalidate();
      toast.success(`User role updated to ${newRole}`);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to update role");
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-foreground tracking-tight">Users</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage user access and permissions
        </p>
      </div>

      {/* Role legend */}
      <div className="flex items-center gap-4 p-4 bg-muted/40 rounded-xl border text-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <span className="font-medium text-foreground">Admin</span>
          <span className="text-muted-foreground">— Full access: manage users, suppliers, settings, all invoices</span>
        </div>
        <div className="flex items-center gap-2 ml-4">
          <User className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium text-foreground">Staff</span>
          <span className="text-muted-foreground">— Upload invoices, create queries, add notes</span>
        </div>
      </div>

      {/* Users list */}
      <Card className="border shadow-sm overflow-hidden">
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
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <UsersIcon className="h-12 w-12 text-muted-foreground/25 mb-4" />
            <p className="text-base font-medium text-foreground">No users yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Users appear here once they sign in
            </p>
          </CardContent>
        ) : (
          <>
            {/* Table header */}
            <div className="hidden md:grid grid-cols-[1fr_200px_120px_120px] gap-4 px-5 py-2.5 bg-muted/40 border-b text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <span>User</span>
              <span>Email</span>
              <span>Last Active</span>
              <span>Role</span>
            </div>
            <div className="divide-y divide-border">
              {users?.map((u) => {
                const isSelf = u.id === currentUser?.id;
                return (
                  <div
                    key={u.id}
                    className="grid grid-cols-1 md:grid-cols-[1fr_200px_120px_120px] gap-2 md:gap-4 items-center px-5 py-4"
                  >
                    <div className="flex items-center gap-3">
                      <Avatar className="h-9 w-9 border">
                        <AvatarFallback className="text-xs font-medium bg-primary/10 text-primary">
                          {u.name?.charAt(0).toUpperCase() ?? "?"}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="text-sm font-medium text-foreground">
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
                                <strong>{u.role}</strong> to{" "}
                                <strong>{u.role === "admin" ? "staff" : "admin"}</strong>?
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
      </Card>
    </div>
  );
}
