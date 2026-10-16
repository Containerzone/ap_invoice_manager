import { toast as originalToast } from "sonner";
import { formatBusinessDisplayText, type BusinessReferenceMap } from "./vtigerBusinessDisplay";

let references: BusinessReferenceMap = {};
export function setBusinessToastReferences(value: BusinessReferenceMap) { references = value; }
const display = (message: unknown) => typeof message === "string" ? formatBusinessDisplayText(message, references) : message;

/** Sonner-compatible presentation wrapper; callbacks, options and IDs stay intact. */
export const toast: typeof originalToast = new Proxy(originalToast, {
  apply(target, thisArg, args) { return Reflect.apply(target, thisArg, [display(args[0]), ...args.slice(1)]); },
  get(target, property, receiver) {
    const method = Reflect.get(target, property, receiver);
    if (["message", "success", "error", "warning", "info", "loading"].includes(String(property)) && typeof method === "function") {
      return (...args: unknown[]) => Reflect.apply(method, target, [display(args[0]), ...args.slice(1)]);
    }
    return method;
  },
});
