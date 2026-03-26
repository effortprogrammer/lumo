import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CliManifest } from "../src/cli-registry/manifest.js";
import {
  createPiAgentRegistryExtensionFile,
  createPiAgentRegistryExtensionFileFromManifests,
} from "../src/runtime/pi-agent-registry-extension.js";
import { PiRpcRuntimeClient } from "../src/runtime/pi-rpc-runtime-client.js";

describe("pi-agent-registry-extension", () => {
  it("generates valid JS extension source with registerTool calls", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-registry-ext-"));
    const registryDir = join(tempDir, "registry");
    try {
      const manifests = await writeFixtureRegistry(registryDir);
      const file = createPiAgentRegistryExtensionFileFromManifests({
        registryPath: registryDir, manifests, baseDir: tempDir,
      });
      // Must contain pi extension contract
      assert.match(file.source, /export default async function \(pi\)/);
      assert.match(file.source, /pi\.registerTool\(/);
      // Must import CliRegistry and Type
      assert.match(file.source, /CliRegistry/);
      assert.match(file.source, /Type\.(String|Number|Boolean|Object)/);
      // Must embed the manifests as JSON (manifest names appear)
      assert.match(file.source, /"alpha-cli"/);
      assert.match(file.source, /"beta-cli"/);
      // Must call registry.invoke at runtime
      assert.match(file.source, /registry\.invoke\(/);
      // File must exist on disk
      assert.ok(existsSync(file.extensionPath));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("includes embedded manifest commands in generated source", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-registry-ext-"));
    const registryDir = join(tempDir, "registry");
    try {
      await writeFixtureRegistry(registryDir);
      const file = createPiAgentRegistryExtensionFile(registryDir, { baseDir: tempDir });
      // Verify each interface command key exists in the embedded manifest JSON
      assert.match(file.source, /"search"/);
      assert.match(file.source, /"health"/);
      assert.match(file.source, /"get"/);
      // Verify descriptions from manifests appear
      assert.match(file.source, /Search alpha/);
      assert.match(file.source, /Get beta product/);
      // Verify the template that constructs tool names
      assert.match(file.source, /\$\{manifest\.name\}\.\$\{command\}/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("cleans up temp extension dir on dispose", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-registry-ext-"));
    const registryDir = join(tempDir, "registry");
    try {
      await writeFixtureRegistry(registryDir);
      const client = new PiRpcRuntimeClient({
        cwd: tempDir,
        env: { PATH: process.env.PATH } as Record<string, string | undefined>,
        registryPath: registryDir,
      });
      const priv = client as unknown as { extensions?: string[]; tempRegistryExtensionDir?: string };

      const extPath = priv.extensions?.find((p: string) => p.includes("pi-agent-registry-extension.js"));
      assert.ok(extPath);
      assert.ok(existsSync(extPath!));
      assert.ok(priv.tempRegistryExtensionDir);
      assert.ok(existsSync(priv.tempRegistryExtensionDir!));

      client.dispose();

      assert.equal(existsSync(extPath!), false);
      assert.equal(existsSync(priv.tempRegistryExtensionDir!), false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function writeFixtureRegistry(root: string): Promise<CliManifest[]> {
  const alphaDir = join(root, "alpha-cli");
  const betaDir = join(root, "beta-cli");
  await mkdir(alphaDir, { recursive: true });
  await mkdir(betaDir, { recursive: true });

  const manifests: CliManifest[] = [
    {
      name: "alpha-cli", version: "1.0.0", description: "Alpha test CLI",
      language: "python", entrypoint: "cli.py", capabilities: ["search"],
      auth: { type: "none", refresh_strategy: "none" },
      health: { last_success: null, last_failure: null, consecutive_failures: 0, failure_threshold: 3 },
      interface: {
        search: { args: ["query"], flags: ["--limit N", "--json"], description: "Search alpha" },
        health: { args: [], flags: ["--json"], description: "Health alpha" },
      },
    },
    {
      name: "beta-cli", version: "1.0.0", description: "Beta test CLI",
      language: "python", entrypoint: "cli.py", capabilities: ["price"],
      auth: { type: "cookie", refresh_strategy: "manual" },
      health: { last_success: null, last_failure: null, consecutive_failures: 1, failure_threshold: 3 },
      interface: {
        get: { args: ["product_id"], flags: ["--json"], description: "Get beta product" },
        health: { args: [], flags: ["--json"], description: "Health beta" },
      },
    },
  ];

  await writeFile(join(alphaDir, "manifest.json"), JSON.stringify(manifests[0], null, 2));
  await writeFile(join(betaDir, "manifest.json"), JSON.stringify(manifests[1], null, 2));
  await writeFile(join(alphaDir, "cli.py"), "print('alpha')\n", "utf8");
  await writeFile(join(betaDir, "cli.py"), "print('beta')\n", "utf8");
  return manifests;
}
