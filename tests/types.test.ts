import { describe, expect, test } from "bun:test";
import type { Config } from "../src/types";

function makeTestConfig(overrides?: Partial<Config>): Config {
  return {
    models: { planner: "opus", executor: "opus" },
    budget: {
      total_max_usd: 50.0,
      per_task_max_usd: 10.0,
      plan_max_usd: 2.0,
      execution_max_usd: 5.0,
      review_max_usd: 2.0,
      per_review_persona_max_usd: 0.80,
    },
    parallelism: { tournament_timeout_seconds: 600 },
    tournament: { competitors: 3, strategies: ["pragmatist", "thorough", "deconstructor"] },
    verification: { auto_detect: true, commands: [], max_retries: 2 },
    review: { enabled: true, max_retries: 2, personas: ["correctness", "security", "maintainability"] },
    git: { auto_commit: true, create_branch: true, create_pr: true },
    ...overrides,
  };
}

describe("Config type definition", () => {
  test("Verify Config type includes git.auto_commit as boolean", () => {
    const config = makeTestConfig();
    expect(typeof config.git.auto_commit).toBe("boolean");
    expect(config.git.auto_commit).toBe(true);
  });

  test("Verify Config type includes git.create_branch as boolean", () => {
    const config = makeTestConfig({ git: { auto_commit: true, create_branch: false, create_pr: true } });
    expect(typeof config.git.create_branch).toBe("boolean");
    expect(config.git.create_branch).toBe(false);
  });

  test("Verify Config type includes git.create_pr as boolean", () => {
    const config = makeTestConfig({ git: { auto_commit: true, create_branch: true, create_pr: false } });
    expect(typeof config.git.create_pr).toBe("boolean");
    expect(config.git.create_pr).toBe(false);
  });

  test("Test that a valid Config object with all git fields can be created", () => {
    const config = makeTestConfig();
    expect(config).toBeDefined();
    expect(config.git).toBeDefined();
    expect(config.git.auto_commit).toBeDefined();
    expect(config.git.create_branch).toBeDefined();
    expect(config.git.create_pr).toBeDefined();
  });

  test("Verify Config includes tournament section", () => {
    const config = makeTestConfig();
    expect(config.tournament).toBeDefined();
    expect(config.tournament.competitors).toBe(3);
    expect(config.tournament.strategies).toEqual(["pragmatist", "thorough", "deconstructor"]);
  });

  test("Test that TypeScript compilation succeeds with the updated type definition", () => {
    const config = makeTestConfig();

    const autoCommit: boolean = config.git.auto_commit;
    const createBranch: boolean = config.git.create_branch;
    const createPr: boolean = config.git.create_pr;

    expect(autoCommit).toBeDefined();
    expect(createBranch).toBeDefined();
    expect(createPr).toBeDefined();
  });
});
