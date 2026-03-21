import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCliUsage } from "../src/index.js";

describe("CLI entry", () => {
  it("documents the first-run onboarding commands", () => {
    const usage = getCliUsage();

    assert.match(usage, /^Usage: lumo/m);
    assert.match(usage, /init\s+Run guided first-time setup/);
    assert.match(usage, /If the config file is missing, Lumo launches guided setup automatically\./);
    assert.match(usage, /launches the pi CLI/);
  });
});
