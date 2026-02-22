import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type { Config } from "../src/types";

describe("config.default.json validation", () => {
  let defaultConfig: Config;

  // Load the config once before all tests
  const configPath = join(__dirname, "../lib/config.default.json");
  const configContent = readFileSync(configPath, "utf-8");
  defaultConfig = JSON.parse(configContent);

  test("Load config.default.json and verify it parses correctly", () => {
    expect(defaultConfig).toBeDefined();
    expect(typeof defaultConfig).toBe("object");
  });

  test("Verify git.auto_commit is set to true in default config", () => {
    expect(defaultConfig.git).toBeDefined();
    expect(defaultConfig.git.auto_commit).toBe(true);
    expect(typeof defaultConfig.git.auto_commit).toBe("boolean");
  });

  test("Verify git.create_branch defaults to false", () => {
    expect(defaultConfig.git).toBeDefined();
    expect(defaultConfig.git.create_branch).toBe(false);
    expect(typeof defaultConfig.git.create_branch).toBe("boolean");
  });

  test("Verify git.create_pr defaults to false", () => {
    expect(defaultConfig.git).toBeDefined();
    expect(defaultConfig.git.create_pr).toBe(false);
    expect(typeof defaultConfig.git.create_pr).toBe("boolean");
  });

  test("Verify budget.per_persona_max_usd is 2.50 for tool-using personas", () => {
    expect(defaultConfig.budget).toBeDefined();
    expect(defaultConfig.budget.per_persona_max_usd).toBe(2.5);
  });

  test("Validate default config matches the Config type schema", () => {
    // Verify models section
    expect(defaultConfig.models).toBeDefined();
    expect(defaultConfig.models.planner).toBe("opus");
    expect(defaultConfig.models.persona).toBe("opus");
    expect(defaultConfig.models.synthesizer).toBe("opus");
    expect(defaultConfig.models.executor).toBe("opus");

    // Verify budget section
    expect(defaultConfig.budget).toBeDefined();
    expect(defaultConfig.budget.total_max_usd).toBe(75.0);
    expect(defaultConfig.budget.per_task_max_usd).toBe(10.0);
    expect(defaultConfig.budget.per_persona_max_usd).toBe(2.5);
    expect(defaultConfig.budget.synthesis_max_usd).toBe(2.0);
    expect(defaultConfig.budget.execution_max_usd).toBe(5.0);

    // Verify parallelism section
    expect(defaultConfig.parallelism).toBeDefined();
    expect(defaultConfig.parallelism.persona_timeout_seconds).toBe(600);

    // Verify verification section
    expect(defaultConfig.verification).toBeDefined();
    expect(Array.isArray(defaultConfig.verification.commands)).toBe(true);
    expect(defaultConfig.verification.max_retries).toBe(2);

    // Verify personas section
    expect(defaultConfig.personas).toBeDefined();
    expect(Array.isArray(defaultConfig.personas.trivial)).toBe(true);
    expect(Array.isArray(defaultConfig.personas.standard)).toBe(true);
    expect(Array.isArray(defaultConfig.personas.complex)).toBe(true);

    // Verify git section with all three fields
    expect(defaultConfig.git).toBeDefined();
    expect(typeof defaultConfig.git.auto_commit).toBe("boolean");
    expect(typeof defaultConfig.git.create_branch).toBe("boolean");
    expect(typeof defaultConfig.git.create_pr).toBe("boolean");
  });

  test("Test that JSON structure is valid with no syntax errors", () => {
    // If we got here, JSON.parse succeeded
    expect(() => {
      const rawConfig = readFileSync(configPath, "utf-8");
      JSON.parse(rawConfig);
    }).not.toThrow();

    // Verify the config object is valid
    expect(defaultConfig).toBeTruthy();
    expect(Object.keys(defaultConfig).length).toBeGreaterThan(0);

    // Verify git section is complete
    const gitKeys = Object.keys(defaultConfig.git);
    expect(gitKeys).toContain("auto_commit");
    expect(gitKeys).toContain("create_branch");
    expect(gitKeys).toContain("create_pr");
    expect(gitKeys.length).toBe(3);
  });
});
