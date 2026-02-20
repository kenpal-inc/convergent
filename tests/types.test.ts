import { describe, expect, test } from "bun:test";
import type { Config } from "../src/types";

describe("Config type definition", () => {
  test("Verify Config type includes git.auto_commit as boolean", () => {
    const config: Config = {
      models: {
        planner: "sonnet",
        persona: "sonnet",
        synthesizer: "opus",
        executor: "sonnet",
      },
      budget: {
        total_max_usd: 50.0,
        per_task_max_usd: 10.0,
        per_persona_max_usd: 1.0,
        synthesis_max_usd: 2.0,
        execution_max_usd: 5.0,
      },
      parallelism: {
        persona_timeout_seconds: 120,
      },
      verification: {
        commands: [],
        max_retries: 2,
      },
      personas: {
        trivial: [],
        standard: ["pragmatist", "tdd", "security"],
        complex: [
          "conservative",
          "minimalist",
          "tdd",
          "performance",
          "ux",
          "security",
          "pragmatist",
        ],
      },
      git: {
        auto_commit: true,
        create_branch: true,
        create_pr: true,
      },
    };

    expect(typeof config.git.auto_commit).toBe("boolean");
    expect(config.git.auto_commit).toBe(true);
  });

  test("Verify Config type includes git.create_branch as boolean", () => {
    const config: Config = {
      models: {
        planner: "sonnet",
        persona: "sonnet",
        synthesizer: "opus",
        executor: "sonnet",
      },
      budget: {
        total_max_usd: 50.0,
        per_task_max_usd: 10.0,
        per_persona_max_usd: 1.0,
        synthesis_max_usd: 2.0,
        execution_max_usd: 5.0,
      },
      parallelism: {
        persona_timeout_seconds: 120,
      },
      verification: {
        commands: [],
        max_retries: 2,
      },
      personas: {
        trivial: [],
        standard: ["pragmatist", "tdd", "security"],
        complex: [
          "conservative",
          "minimalist",
          "tdd",
          "performance",
          "ux",
          "security",
          "pragmatist",
        ],
      },
      git: {
        auto_commit: true,
        create_branch: false,
        create_pr: true,
      },
    };

    expect(typeof config.git.create_branch).toBe("boolean");
    expect(config.git.create_branch).toBe(false);
  });

  test("Verify Config type includes git.create_pr as boolean", () => {
    const config: Config = {
      models: {
        planner: "sonnet",
        persona: "sonnet",
        synthesizer: "opus",
        executor: "sonnet",
      },
      budget: {
        total_max_usd: 50.0,
        per_task_max_usd: 10.0,
        per_persona_max_usd: 1.0,
        synthesis_max_usd: 2.0,
        execution_max_usd: 5.0,
      },
      parallelism: {
        persona_timeout_seconds: 120,
      },
      verification: {
        commands: [],
        max_retries: 2,
      },
      personas: {
        trivial: [],
        standard: ["pragmatist", "tdd", "security"],
        complex: [
          "conservative",
          "minimalist",
          "tdd",
          "performance",
          "ux",
          "security",
          "pragmatist",
        ],
      },
      git: {
        auto_commit: true,
        create_branch: true,
        create_pr: false,
      },
    };

    expect(typeof config.git.create_pr).toBe("boolean");
    expect(config.git.create_pr).toBe(false);
  });

  test("Test that a valid Config object with all git fields can be created", () => {
    const config: Config = {
      models: {
        planner: "sonnet",
        persona: "sonnet",
        synthesizer: "opus",
        executor: "sonnet",
      },
      budget: {
        total_max_usd: 50.0,
        per_task_max_usd: 10.0,
        per_persona_max_usd: 1.0,
        synthesis_max_usd: 2.0,
        execution_max_usd: 5.0,
      },
      parallelism: {
        persona_timeout_seconds: 120,
      },
      verification: {
        commands: [],
        max_retries: 2,
      },
      personas: {
        trivial: [],
        standard: ["pragmatist", "tdd", "security"],
        complex: [
          "conservative",
          "minimalist",
          "tdd",
          "performance",
          "ux",
          "security",
          "pragmatist",
        ],
      },
      git: {
        auto_commit: true,
        create_branch: true,
        create_pr: true,
      },
    };

    expect(config).toBeDefined();
    expect(config.git).toBeDefined();
    expect(config.git.auto_commit).toBeDefined();
    expect(config.git.create_branch).toBeDefined();
    expect(config.git.create_pr).toBeDefined();
  });

  test("Test that TypeScript compilation succeeds with the updated type definition", () => {
    // This test verifies type safety at compile time
    // If this file compiles without errors, the type definition is correct

    const config: Config = {
      models: {
        planner: "sonnet",
        persona: "sonnet",
        synthesizer: "opus",
        executor: "sonnet",
      },
      budget: {
        total_max_usd: 50.0,
        per_task_max_usd: 10.0,
        per_persona_max_usd: 1.0,
        synthesis_max_usd: 2.0,
        execution_max_usd: 5.0,
      },
      parallelism: {
        persona_timeout_seconds: 120,
      },
      verification: {
        commands: [],
        max_retries: 2,
      },
      personas: {
        trivial: [],
        standard: ["pragmatist", "tdd", "security"],
        complex: [
          "conservative",
          "minimalist",
          "tdd",
          "performance",
          "ux",
          "security",
          "pragmatist",
        ],
      },
      git: {
        auto_commit: true,
        create_branch: true,
        create_pr: true,
      },
    };

    // Type assertions to verify correct types
    const autoCommit: boolean = config.git.auto_commit;
    const createBranch: boolean = config.git.create_branch;
    const createPr: boolean = config.git.create_pr;

    expect(autoCommit).toBeDefined();
    expect(createBranch).toBeDefined();
    expect(createPr).toBeDefined();
  });
});
