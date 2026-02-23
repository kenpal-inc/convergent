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

  test("Validate default config matches the Config type schema", () => {
    // Verify models section
    expect(defaultConfig.models).toBeDefined();
    expect(defaultConfig.models.planner).toBe("opus");
    expect(defaultConfig.models.executor).toBe("opus");

    // Verify budget section
    expect(defaultConfig.budget).toBeDefined();
    expect(defaultConfig.budget.total_max_usd).toBe(75.0);
    expect(defaultConfig.budget.per_task_max_usd).toBe(15.0);
    expect(defaultConfig.budget.plan_max_usd).toBe(2.0);
    expect(defaultConfig.budget.execution_max_usd).toBe(5.0);
    expect(defaultConfig.budget.review_max_usd).toBe(2.0);
    expect(defaultConfig.budget.per_review_persona_max_usd).toBe(0.80);

    // Verify parallelism section
    expect(defaultConfig.parallelism).toBeDefined();
    expect(defaultConfig.parallelism.tournament_timeout_seconds).toBe(1800);

    // Verify tournament section
    expect(defaultConfig.tournament).toBeDefined();
    expect(defaultConfig.tournament.competitors).toBe(3);
    expect(defaultConfig.tournament.strategies).toEqual(["pragmatist", "thorough", "deconstructor"]);

    // Verify verification section
    expect(defaultConfig.verification).toBeDefined();
    expect(defaultConfig.verification.auto_detect).toBe(true);
    expect(Array.isArray(defaultConfig.verification.commands)).toBe(true);
    expect(defaultConfig.verification.max_retries).toBe(2);

    // Verify review section
    expect(defaultConfig.review).toBeDefined();
    expect(defaultConfig.review.enabled).toBe(true);
    expect(defaultConfig.review.max_retries).toBe(2);
    expect(defaultConfig.review.personas).toEqual(["correctness", "security", "maintainability"]);

    // Verify git section
    expect(defaultConfig.git).toBeDefined();
    expect(typeof defaultConfig.git.auto_commit).toBe("boolean");
    expect(typeof defaultConfig.git.create_branch).toBe("boolean");
    expect(typeof defaultConfig.git.create_pr).toBe("boolean");
  });

  test("Test that JSON structure is valid with no syntax errors", () => {
    expect(() => {
      const rawConfig = readFileSync(configPath, "utf-8");
      JSON.parse(rawConfig);
    }).not.toThrow();

    expect(defaultConfig).toBeTruthy();
    expect(Object.keys(defaultConfig).length).toBeGreaterThan(0);

    const gitKeys = Object.keys(defaultConfig.git);
    expect(gitKeys).toContain("auto_commit");
    expect(gitKeys).toContain("create_branch");
    expect(gitKeys).toContain("create_pr");
    expect(gitKeys.length).toBe(3);
  });
});
