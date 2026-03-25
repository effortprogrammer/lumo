import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { registryToTools } from "../src/cli-registry/tool-bridge.js";
import { CliRegistry } from "../src/cli-registry/registry.js";

async function writeFixtureRegistry(root: string): Promise<void> {
  const alphaDir = join(root, "alpha-cli");
  const betaDir = join(root, "beta-cli");
  await mkdir(alphaDir, { recursive: true });
  await mkdir(betaDir, { recursive: true });

  await writeFile(join(alphaDir, "manifest.json"), JSON.stringify({
    name: "alpha-cli",
    version: "1.0.0",
    description: "Alpha test CLI",
    language: "python",
    entrypoint: "cli.py",
    capabilities: ["search"],
    auth: {
      type: "none",
      refresh_strategy: "none",
    },
    health: {
      last_success: null,
      last_failure: null,
      consecutive_failures: 0,
      failure_threshold: 3,
    },
    interface: {
      search: {
        args: ["query"],
        flags: ["--limit N", "--json"],
        description: "Search alpha",
      },
      health: {
        args: [],
        flags: ["--json"],
        description: "Health alpha",
      },
    },
  }, null, 2));

  await writeFile(join(alphaDir, "cli.py"), [
    "#!/usr/bin/env python3",
    "import json",
    "import sys",
    "",
    "command = sys.argv[1]",
    "if command == 'search':",
    "    payload = {'query': sys.argv[2], 'ok': True}",
    "    print(json.dumps(payload))",
    "    raise SystemExit(0)",
    "if command == 'health':",
    "    print(json.dumps({'ok': True}))",
    "    raise SystemExit(0)",
    "print(json.dumps({'command': command}))",
    "raise SystemExit(0)",
    "",
  ].join("\n"), "utf8");

  await writeFile(join(betaDir, "manifest.json"), JSON.stringify({
    name: "beta-cli",
    version: "1.0.0",
    description: "Beta test CLI",
    language: "python",
    entrypoint: "cli.py",
    capabilities: ["price"],
    auth: {
      type: "cookie",
      refresh_strategy: "manual",
    },
    health: {
      last_success: null,
      last_failure: null,
      consecutive_failures: 1,
      failure_threshold: 3,
    },
    interface: {
      get: {
        args: ["product_id"],
        flags: ["--json"],
        description: "Get beta product",
      },
      health: {
        args: [],
        flags: ["--json"],
        description: "Health beta",
      },
    },
  }, null, 2));

  await writeFile(join(betaDir, "cli.py"), [
    "#!/usr/bin/env python3",
    "import json",
    "import sys",
    "",
    "command = sys.argv[1]",
    "if command == 'health':",
    "    print(json.dumps({'ok': False}))",
    "    raise SystemExit(3)",
    "if command == 'get':",
    "    print(json.dumps({'product_id': sys.argv[2]}))",
    "    raise SystemExit(0)",
    "print(json.dumps({'command': command}))",
    "raise SystemExit(0)",
    "",
  ].join("\n"), "utf8");
}

describe("CliRegistry", () => {
  it("discovers manifests, invokes CLIs, and converts them to tool definitions", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-cli-registry-"));
    const registryDir = join(tempDir, "registry");

    try {
      await mkdir(registryDir, { recursive: true });
      await writeFixtureRegistry(registryDir);

      const registry = new CliRegistry(registryDir);
      const manifests = await registry.discover();

      assert.deepEqual(manifests.map((manifest) => manifest.name), ["alpha-cli", "beta-cli"]);
      assert.equal(registry.get("alpha-cli")?.description, "Alpha test CLI");
      assert.equal(registry.list()[0]?.path, join(registryDir, "alpha-cli"));

      const searchResult = await registry.invoke("alpha-cli", "search", ["hello", "--json"]);
      assert.equal(searchResult.exitCode, 0);
      assert.deepEqual(searchResult.parsed, {
        query: "hello",
        ok: true,
      });

      const tools = registryToTools(registry);
      assert.equal(tools[0]?.name, "alpha-cli.health");
      assert.equal(tools[1]?.name, "alpha-cli.search");
      assert.deepEqual(tools[1]?.inputSchema.required, ["query"]);
      assert.equal(tools[1]?.metadata.registryCli, "alpha-cli");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("updates manifest health timestamps after health checks", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-cli-registry-health-"));
    const registryDir = join(tempDir, "registry");
    const now = "2026-03-24T10:20:30.000Z";

    try {
      await mkdir(registryDir, { recursive: true });
      await writeFixtureRegistry(registryDir);

      const registry = new CliRegistry(registryDir, {
        now: () => now,
      });
      await registry.discover();

      const successHealth = await registry.healthCheck("alpha-cli");
      assert.equal(successHealth.last_success, now);
      assert.equal(successHealth.consecutive_failures, 0);

      const failureHealth = await registry.healthCheck("beta-cli");
      assert.equal(failureHealth.last_failure, now);
      assert.equal(failureHealth.consecutive_failures, 2);

      const persisted = JSON.parse(await readFile(join(registryDir, "beta-cli", "manifest.json"), "utf8"));
      assert.equal(persisted.health.last_failure, now);
      assert.equal(persisted.health.consecutive_failures, 2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
