import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type { Config } from "../src/types";

describe("Config integration tests", () => {
  test("Test loading config from file and accessing git.create_branch", () => {
    const configPath = join(__dirname, "../lib/config.default.json");
    const configContent = readFileSync(configPath, "utf-8");
    const config: Config = JSON.parse(configContent);

    expect(config.git.create_branch).toBeDefined();
    expect(typeof config.git.create_branch).toBe("boolean");
    expect(config.git.create_branch).toBe(false);
  });

  test("Test loading config from file and accessing git.create_pr", () => {
    const configPath = join(__dirname, "../lib/config.default.json");
    const configContent = readFileSync(configPath, "utf-8");
    const config: Config = JSON.parse(configContent);

    expect(config.git.create_pr).toBeDefined();
    expect(typeof config.git.create_pr).toBe("boolean");
    expect(config.git.create_pr).toBe(false);
  });

  test("Verify all three git configuration fields are accessible at runtime", () => {
    const configPath = join(__dirname, "../lib/config.default.json");
    const configContent = readFileSync(configPath, "utf-8");
    const config: Config = JSON.parse(configContent);

    // All three fields should be accessible
    expect(config.git.auto_commit).toBeDefined();
    expect(config.git.create_branch).toBeDefined();
    expect(config.git.create_pr).toBeDefined();

    // All three should be booleans
    expect(typeof config.git.auto_commit).toBe("boolean");
    expect(typeof config.git.create_branch).toBe("boolean");
    expect(typeof config.git.create_pr).toBe("boolean");

    // auto_commit defaults to true, create_branch/create_pr default to false
    expect(config.git.auto_commit).toBe(true);
    expect(config.git.create_branch).toBe(false);
    expect(config.git.create_pr).toBe(false);
  });

  test("Test that config validation passes with the new fields", () => {
    const configPath = join(__dirname, "../lib/config.default.json");
    const configContent = readFileSync(configPath, "utf-8");
    const config: Config = JSON.parse(configContent);

    // Validate the config object structure
    const validateConfig = (cfg: Config): boolean => {
      if (!cfg.git) return false;
      if (typeof cfg.git.auto_commit !== "boolean") return false;
      if (typeof cfg.git.create_branch !== "boolean") return false;
      if (typeof cfg.git.create_pr !== "boolean") return false;
      return true;
    };

    expect(validateConfig(config)).toBe(true);
  });

  test("Ensure backward compatibility if config uses existing type definitions", () => {
    const configPath = join(__dirname, "../lib/config.default.json");
    const configContent = readFileSync(configPath, "utf-8");
    const config: Config = JSON.parse(configContent);

    // Old code that only uses auto_commit should still work
    const autoCommit: boolean = config.git.auto_commit;
    expect(autoCommit).toBeDefined();
    expect(typeof autoCommit).toBe("boolean");

    // New code can access the new fields
    const createBranch: boolean = config.git.create_branch;
    const createPr: boolean = config.git.create_pr;
    expect(createBranch).toBeDefined();
    expect(createPr).toBeDefined();
    expect(typeof createBranch).toBe("boolean");
    expect(typeof createPr).toBe("boolean");

    // auto_commit defaults to true, create_branch/create_pr default to false
    expect(autoCommit).toBe(true);
    expect(createBranch).toBe(false);
    expect(createPr).toBe(false);
  });
});
