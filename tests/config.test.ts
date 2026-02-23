import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { unlinkSync } from "fs";
import { loadConfig } from "../src/config";

describe("loadConfig convergence_threshold", () => {
  const defaultPath = resolve(__dirname, "../lib/config.default.json");

  test("default config includes tournament.convergence_threshold = 0.5", async () => {
    const config = await loadConfig(defaultPath);
    expect(config.tournament.convergence_threshold).toBe(0.5);
  });

  test("project config can override convergence_threshold", async () => {
    const tmpDir = require("os").tmpdir();
    const overridePath = `${tmpDir}/convergent-test-config-${Date.now()}.json`;
    await Bun.write(
      overridePath,
      JSON.stringify({ tournament: { convergence_threshold: 0.8 } }),
    );
    const config = await loadConfig(defaultPath, overridePath);
    expect(config.tournament.convergence_threshold).toBe(0.8);
    // Ensure other tournament defaults are preserved
    expect(config.tournament.competitors).toBe(3);
    expect(config.tournament.strategies).toEqual([
      "pragmatist",
      "thorough",
      "deconstructor",
    ]);
    unlinkSync(overridePath);
  });
});
