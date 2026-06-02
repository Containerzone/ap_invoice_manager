import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Building2, Plus, Search, Mail, Phone, Hash, Edit2, X, Check, Loader2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useAuth } from "@/_core/hooks/useAuth";

interface SupplierFormData {
  name: string;
  email: string;
  phone: string;
  abn: string;
  address: string;
  xeroContactId: string;
}

const EMPTY_FORM: SupplierFormData = {
  name: "", email: "", phone: "", abn: "", address: "", xeroContactId: "",
};

export default function Suppliers() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [search, setSearch] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<SupplierFormData>(EMPTY_FORM);

  const utils = trpc.useUtils();
  const { data: allSuppliers, isLoading } = trpc.suppliers.list.useQuery();
  const suppliers = allSuppliers?.filter((s) =>
    !search || s.name?.toLowerCase().includes(search.toLowerCase()) ||
    s.email?.toLowerCase().includes(search.toLowerCase()) ||
    s.abn?.includes(search)
  );
  const createMutation = trpc.suppliers.create.useMutation();
  const updateMutation = trpc.suppliers.update.useMutation();

  const invalidate = () => utils.suppliers.list.invalidate();

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowDialog(true);
  };

  const openEdit = (s: any) => {
    setEditingId(s.id);
    setForm({
      name: s.name ?? "",
      email: s.email ?? "",
      phone: s.phone ?? "",
      abn: s.abn ?? "",
      address: s.address ?? "",
      xeroContactId: s.xeroContactId ?? "",
    });
    setShowDialog(true);
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      toast.error("Supplier name is required");
      return;
    }
    try {
      if (editingId) {
        await updateMutation.mutateAsync({ id: editingId, ...form });
        toast.success("Supplier updated");
      } else {
        await createMutation.mutateAsync(form);
        toast.success("Supplier created");
      }
      await invalidate();
      setShowDialog(false);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to save supplier");
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Suppliers</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {suppliers?.length ?? 0} supplier{suppliers?.length !== 1 ? "s" : ""} in database
          </p>
        </div>
        {isAdmin && (
          <Button onClick={openCreate} className="gap-2 shadow-sm">
            <Plus className="h-4 w-4" />
            Add Supplier
          </Button>
        )}
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search suppliers..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 h-9"
        />
      </div>

      {/* Suppliers grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-xl" />
          ))}
        </div>
      ) : suppliers?.length === 0 ? (
        <Card className="border shadow-sm">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Building2 className="h-12 w-12 text-muted-foreground/25 mb-4" />
            <p className="text-base font-medium text-foreground">No suppliers found</p>
            <p className="text-sm text-muted-foreground mt-1 mb-4">
              {search ? "Try adjusting your search" : "Suppliers are created automatically when invoices are uploaded"}
            </p>
            {isAdmin && !search && (
              <Button variant="outline" size="sm" className="gap-2" onClick={openCreate}>
                <Plus className="h-3.5 w-3.5" />
                Add Supplier Manually
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {suppliers?.map((s) => (
            <Card key={s.id} className="border shadow-sm hover:shadow-md transition-shadow">
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                    <Building2 className="h-5 w-5 text-primary" />
                  </div>
                  {isAdmin && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => openEdit(s)}
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <p className="text-sm font-semibold text-foreground">{s.name}</p>
                {s.abn && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                    <Hash className="h-3 w-3" />
                    ABN: {s.abn}
                  </p>
                )}
                {s.email && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1 truncate">
                    <Mail className="h-3 w-3 shrink-0" />
                    {s.email}
                  </p>
                )}
                {s.phone && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                    <Phone className="h-3 w-3" />
                    {s.phone}
                  </p>
                )}
                {s.xeroContactId && (
                  <div className="mt-2 inline-flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                    <Check className="h-3 w-3" />
                    Xero linked
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Supplier" : "Add Supplier"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {[
              { key: "name", label: "Name *", placeholder: "Supplier company name" },
              { key: "email", label: "Email", placeholder: "supplier@example.com" },
              { key: "phone", label: "Phone", placeholder: "+61 2 1234 5678" },
              { key: "abn", label: "ABN", placeholder: "12 345 678 901" },
              { key: "address", label: "Address", placeholder: "123 Main St, Sydney NSW 2000" },
              { key: "xeroContactId", label: "Xero Contact ID", placeholder: "Optional" },
            ].map(({ key, label, placeholder }) => (
              <div key={key} className="space-y-1.5">
                <Label className="text-xs">{label}</Label>
                <Input
                  placeholder={placeholder}
                  value={form[key as keyof SupplierFormData]}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  className="h-9 text-sm"
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={isPending} className="gap-2">
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {editingId ? "Save Changes" : "Create Supplier"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
