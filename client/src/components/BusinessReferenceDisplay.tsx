import React, { createContext, isValidElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { collectDisplayRecordIds, formatBusinessDisplayText, type BusinessReferenceMap } from "@/lib/vtigerBusinessDisplay";
import { setBusinessToastReferences } from "@/lib/businessToast";

const Context = createContext<{ references: BusinessReferenceMap; register: (ids: string[]) => void }>({ references: {}, register: () => {} });

/** Shared, bounded read-only label batches for every page and portalled dialog. */
export function BusinessReferenceProvider({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils();
  const [references, setReferences] = useState<Record<string, string | null>>({});
  const resolved = useRef<Record<string, string | null>>({});
  const pending = useRef(new Set<string>());
  const attempted = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef(false);
  const alive = useRef(true);
  const flush = useRef<() => void>(() => {});

  flush.current = async () => {
    timer.current = null;
    if (running.current || !alive.current) return;
    const ids = Array.from(pending.current).slice(0, 50);
    if (!ids.length) return;
    ids.forEach(id => { pending.current.delete(id); attempted.current.add(id); });
    running.current = true;
    const next: Record<string, string | null> = Object.fromEntries(ids.map(id => [id, null]));
    try {
      const rows = await utils.financialOperations.vtigerDisplayReferences.fetch({ recordIds: ids });
      rows.forEach(row => { next[row.recordId] = row.businessNumber; });
    } catch {
      // A display lookup failure is not a financial hold. Do not infer a number.
    } finally {
      running.current = false;
      if (alive.current) {
        resolved.current = { ...resolved.current, ...next };
        setReferences(resolved.current);
        if (pending.current.size) timer.current = setTimeout(() => void flush.current(), 50);
      }
    }
  };

  const register = useCallback((ids: string[]) => {
    ids.forEach(id => { if (!attempted.current.has(id)) pending.current.add(id); });
    if (pending.current.size && !running.current && !timer.current) timer.current = setTimeout(() => void flush.current(), 50);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); setBusinessToastReferences({}); };
  }, []);
  useEffect(() => { setBusinessToastReferences(references); }, [references]);
  const value = useMemo(() => ({ references, register }), [references, register]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

function ResolvedBusinessText({ text, idsKey }: { text: string; idsKey: string }) {
  const { references, register } = useContext(Context);
  useEffect(() => { register(JSON.parse(idsKey) as string[]); }, [idsKey, register]);
  return <>{formatBusinessDisplayText(text, references)}</>;
}

/** No DOM wrapper, no source mutation, no changes to keys, form values or API args. */
export function BusinessText({ value }: { value: unknown }) {
  if (typeof value === "string") {
    const ids = collectDisplayRecordIds(value);
    return ids.length ? <ResolvedBusinessText text={value} idsKey={JSON.stringify(ids)} /> : <>{value}</>;
  }
  if (value == null || typeof value === "boolean") return null;
  if (typeof value === "number" || isValidElement(value)) return <>{value}</>;
  return <>{value as ReactNode}</>;
}

export function useBusinessReferenceText(source?: unknown) {
  const { references, register } = useContext(Context);
  const idsKey = JSON.stringify(collectDisplayRecordIds(source));
  useEffect(() => { register(JSON.parse(idsKey) as string[]); }, [idsKey, register]);
  return (text: string) => formatBusinessDisplayText(text, references);
}
