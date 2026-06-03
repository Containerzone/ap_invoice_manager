import { useState, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Building2, Plus, Check, ChevronDown, Loader2, Lock } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAuth } from "@/_core/hooks/useAuth";

export interface SupplierSelection {
  name: string;
  supplierId?: number;
}

interface SupplierComboboxProps {
  value: string;
  onChange: (selection: SupplierSelection) => void;
  disabled?: boolean;
  placeholder?: string;
}

interface NewSupplierForm {
  name: string;
  email: string;
  phone: string;
  abn: string;
  address: string;
}

export function SupplierCombobox({ value, onChange, disabled, placeholder }: SupplierComboboxProps) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const [showCreate, setShowCreate] = useState(false);
  const [newForm, setNewForm] = useState<NewSupplierForm>({ name: "", email: "", phone: "", abn: "", address: "" });
  const containerRef = useRef<HTMLDivElement>(null);

  const utils = trpc.useUtils();
  const { data: allSuppliers } = trpc.suppliers.list.useQuery();
  const createMutation = trpc.suppliers.create.useMutation();

  // Sync external value changes
  useEffect(() => {
    setInputValue(value);
  }, [value]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = allSuppliers?.filter((s) =>
    !inputValue || s.name?.toLowerCase().includes(inputValue.toLowerCase())
  ) ?? [];

  const exactMatch = allSuppliers?.find(
    (s) => s.name?.toLowerCase() === inputValue.toLowerCase()
  );

  const handleSelect = (name: string, supplierId?: number) => {
    setInputValue(name);
    onChange({ name, supplierId });
    setOpen(false);
  };

  const handleInputChange = (val: string) => {
    setInputValue(val);
    // When typing freely, clear the supplierId since it's not yet matched
    onChange({ name: val, supplierId: undefined });
    setOpen(true);
  };

  const openCreateDialog = () => {
    setNewForm({ name: inputValue, email: "", phone: "", abn: "", address: "" });
    setShowCreate(true);
    setOpen(false);
  };

  const handleCreate = async () => {
    if (!newForm.name.trim()) {
      toast.error("Supplier name is required");
      return;
    }
    try {
      const newId = await createMutation.mutateAsync(newForm);
      await utils.suppliers.list.invalidate();
      handleSelect(newForm.name, typeof newId === "number" ? newId : undefined);
      setShowCreate(false);
      toast.success(`Supplier "${newForm.name}" created and linked`);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to create supplier");
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Input
          value={inputValue}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={placeholder ?? "Search or type supplier name..."}
          disabled={disabled}
          className="h-9 text-sm pr-8"
        />
        <ChevronDown
          className={cn(
            "absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground transition-transform pointer-events-none",
            open && "rotate-180"
          )}
        />
      </div>

      {open && !disabled && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border bg-popover shadow-lg overflow-hidden">
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 && !inputValue ? (
              <p className="text-xs text-muted-foreground px-3 py-2.5">Start typing to search suppliers...</p>
            ) : filtered.length === 0 ? (
              <p className="text-xs text-muted-foreground px-3 py-2.5">No suppliers match "{inputValue}"</p>
            ) : (
              filtered.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => handleSelect(s.name ?? "", s.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent text-left transition-colors"
                >
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="flex-1 truncate">{s.name}</span>
                  {s.name?.toLowerCase() === inputValue.toLowerCase() && (
                    <Check className="h-3.5 w-3.5 text-primary shrink-0" />
                  )}
                </button>
              ))
            )}
          </div>

          {/* Create new option — only shown to admins when no exact match */}
          {inputValue.trim() && !exactMatch && (
            <div className="border-t">
              {isAdmin ? (
                <button
                  type="button"
                  onClick={openCreateDialog}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm hover:bg-accent text-left transition-colors text-primary"
                >
                  <Plus className="h-3.5 w-3.5 shrink-0" />
                  <span>Create new supplier <span className="font-semibold">"{inputValue}"</span></span>
                </button>
              ) : (
                <div className="flex items-center gap-2.5 px-3 py-2.5 text-xs text-muted-foreground">
                  <Lock className="h-3.5 w-3.5 shrink-0" />
                  <span>No match found — ask an Admin to create this supplier</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Create Supplier Dialog (Admin only) */}
      {isAdmin && (
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Create New Supplier</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              {[
                { key: "name", label: "Name *", placeholder: "Supplier company name" },
                { key: "email", label: "Email", placeholder: "supplier@example.com" },
                { key: "phone", label: "Phone", placeholder: "+61 2 1234 5678" },
                { key: "abn", label: "ABN", placeholder: "12 345 678 901" },
                { key: "address", label: "Address", placeholder: "123 Main St, Sydney NSW 2000" },
              ].map(({ key, label, placeholder }) => (
                <div key={key} className="space-y-1.5">
                  <Label className="text-xs">{label}</Label>
                  <Input
                    placeholder={placeholder}
                    value={newForm[key as keyof NewSupplierForm]}
                    onChange={(e) => setNewForm((f) => ({ ...f, [key]: e.target.value }))}
                    className="h-9 text-sm"
                  />
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={createMutation.isPending} className="gap-2">
                {createMutation.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Plus className="h-3.5 w-3.5" />
                }
                Create & Link Supplier
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
