import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { collectDisplayRecordIds, formatBusinessDisplayJson, formatBusinessDisplayText } from "../client/src/lib/vtigerBusinessDisplay";

const references = { "5x488095": "D702928", "79x489399": "C1915" };

describe("VTiger business reference presentation", () => {
  it("shows the verified business number rather than rewriting the technical suffix", () => {
    expect(formatBusinessDisplayText("5x488095", references)).toBe("D702928");
    expect(formatBusinessDisplayText("79x489399", references)).toBe("C1915");
    expect(formatBusinessDisplayText("5x488095", references)).not.toBe("D488095");
  });
  it("replaces all source references inside messages and composite record keys", () => {
    expect(formatBusinessDisplayText("asset:79x489399; Deal 5x488095 / 5X488095", references))
      .toBe("asset:C1915; Deal D702928 / D702928");
  });
  it("never invents a business number when unresolved or unavailable", () => {
    expect(formatBusinessDisplayText("5x12345")).toBe("[Deal reference loading]");
    expect(formatBusinessDisplayText("79x12345", { "79x12345": null })).toBe("[Container Control reference unavailable]");
  });
  it("rejects a C number for a Deal and a D number for a Container Control", () => {
    expect(formatBusinessDisplayText("5x488095", { "5x488095": "C1915" })).toBe("[Deal reference unavailable]");
    expect(formatBusinessDisplayText("79x489399", { "79x489399": "D702928" })).toBe("[Container Control reference unavailable]");
  });
  it("does not alter Xero identifiers, item codes, UUIDs or substrings", () => {
    const value = "INV-702928 HC1915-2 SC1915 SER60 Q531794 9b45x012 ABC79x489399Z";
    expect(formatBusinessDisplayText(value, references)).toBe(value);
  });
  it("collects and deduplicates nested technical IDs including JSON messages", () => {
    expect(collectDisplayRecordIds({ deal: "5X488095", details: ["asset:79x489399", "5x488095"] }))
      .toEqual(["5x488095", "79x489399"]);
  });
  it("ignores unrelated VTiger modules and oversized/partial IDs", () => {
    expect(collectDisplayRecordIds("4x123 13x123 5x1234567890123 foo79x489399bar")).toEqual([]);
  });
  it("handles cyclic input and dates without mutating any input", () => {
    const input: any = { id: "5x488095", at: new Date("2026-10-16") }; input.self = input;
    expect(collectDisplayRecordIds(input)).toEqual(["5x488095"]);
    expect(input.id).toBe("5x488095");
  });
  it("projects evidence JSON while retaining technical IDs in the original audit object", () => {
    const audit = Object.freeze({ sourceRecordId: "79x489399", link: Object.freeze({ dealId: "5x488095" }) });
    const output = formatBusinessDisplayJson(audit, references);
    expect(JSON.parse(output)).toEqual({ sourceRecordId: "C1915", link: { dealId: "D702928" } });
    expect(audit.sourceRecordId).toBe("79x489399"); expect(audit.link.dealId).toBe("5x488095");
  });
  it("keeps empty, boolean, numeric and null values well-defined", () => {
    expect(formatBusinessDisplayText("", references)).toBe("");
    expect(formatBusinessDisplayJson(null, references)).toBe("null");
    expect(formatBusinessDisplayJson(undefined, references)).toBe("");
    expect(formatBusinessDisplayJson([1, false], references)).toBe("[\n  1,\n  false\n]");
  });
});

describe("whole-app business-reference UI coverage", () => {
  const root = path.resolve(import.meta.dirname, "../client/src");
  const dirs = ["pages", "components"];
  const sourceProperty = /(?:sourceRecordId|dealId|candidateRecordId|containerControlId|recordKey|recordId|JSON\.stringify)/;
  function containsJsx(node: ts.Node): boolean {
    let found = false;
    const visit = (item: ts.Node) => {
      if (ts.isJsxElement(item) || ts.isJsxFragment(item) || ts.isJsxSelfClosingElement(item)) found = true;
      else ts.forEachChild(item, visit);
    };
    visit(node); return found;
  }
  it("protects source-number text and evidence across every page/domain component", () => {
    const unsafe: string[] = [];
    for (const dir of dirs) {
      for (const filename of fs.readdirSync(path.join(root, dir)).filter(name => name.endsWith(".tsx"))) {
        if (filename === "BusinessReferenceDisplay.tsx") continue;
        const full = path.join(root, dir, filename);
        const source = fs.readFileSync(full, "utf8");
        const parsed = ts.createSourceFile(full, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const visit = (node: ts.Node) => {
          if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
            && !containsJsx(node.expression) && sourceProperty.test(node.expression.getText(parsed))) {
            unsafe.push(`${dir}/${filename}: ${node.expression.getText(parsed)}`);
          }
          ts.forEachChild(node, visit);
        };
        visit(parsed);
      }
    }
    expect(unsafe).toEqual([]);
  });
  it("retains the true ID for candidate selection and downstream requests", () => {
    const source = fs.readFileSync(path.join(root, "components/FinancialFamilyCandidateDiscovery.tsx"), "utf8");
    expect(source).toContain("setSelectedRecordId(candidate.recordId)");
    expect(source).toContain("selectedRecordId === candidate.recordId");
    expect(source).toContain("<BusinessText value={candidate.recordId} />");
    const actions = fs.readFileSync(path.join(root, "pages/FinancialOperations.tsx"), "utf8");
    expect(actions).toContain("candidateRecordId: entry.candidateRecordId!");
  });
  it("places the shared resolver behind app authentication", () => {
    const source = fs.readFileSync(path.join(root, "App.tsx"), "utf8");
    expect(source).toContain("return <BusinessReferenceProvider>{children}</BusinessReferenceProvider>");
    expect(source.indexOf("if (!isAuthenticated)")).toBeLessThan(source.indexOf("return <BusinessReferenceProvider>"));
  });
});
