import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP_NAME, ORGANIZATION_APP_NAME, WORKFLOW_MONITOR_NAME } from "../shared/branding";

describe("application branding", () => {
  it("uses Supplier Invoice Manager as the deployed browser title", () => {
    expect(process.env.VITE_APP_TITLE).toBe(APP_NAME);
    const html = readFileSync(resolve(process.cwd(), "client/index.html"), "utf8");
    expect(html).toContain(`<title>${APP_NAME}</title>`);
  });

  it("uses the same product name for organization and operational-monitor labels", () => {
    expect(ORGANIZATION_APP_NAME).toBe("ContainerZone Supplier Invoice Manager");
    expect(WORKFLOW_MONITOR_NAME).toBe("ContainerZone Supplier Invoice Monitor");
  });
});
