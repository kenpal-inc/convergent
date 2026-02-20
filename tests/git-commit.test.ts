import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Config } from "../src/types";

describe("gitCommitTask", () => {
  let originalSpawn: any;
  let originalWrite: any;
  let tempDir: string;

  const mockConfig: Config = {
    models: {
      planner: "claude-3-5-sonnet-20241022",
      persona: "claude-3-5-sonnet-20241022",
      synthesizer: "claude-3-5-sonnet-20241022",
      executor: "claude-3-5-sonnet-20241022",
    },
    budget: {
      total_max_usd: 50,
      per_task_max_usd: 5,
      per_persona_max_usd: 1,
      synthesis_max_usd: 1,
      execution_max_usd: 2,
    },
    parallelism: {
      persona_timeout_seconds: 300,
    },
    verification: {
      commands: ["bun test"],
      max_retries: 2,
    },
    personas: {
      trivial: ["pragmatist"],
      standard: ["pragmatist", "tdd"],
      complex: ["pragmatist", "tdd", "security"],
    },
    git: {
      auto_commit: true,
    },
  };

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    originalWrite = Bun.write;
    tempDir = mkdtempSync(join(tmpdir(), "git-test-"));
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
    Bun.write = originalWrite;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  test("returns true when auto_commit is disabled", async () => {
    const disabledConfig = {
      ...mockConfig,
      git: { auto_commit: false },
    };

    // Dynamic import to get fresh module
    const { gitCommitTask } = await import("../src/git");
    const result = await gitCommitTask("task-1", "Test Task", disabledConfig, tempDir, tempDir);

    expect(result).toBe(true);
  });

  test("returns true when no changes to commit", async () => {
    Bun.spawn = mock((args: any[], options: any) => {
      // All git status checks return empty (no changes)
      return {
        stdout: { text: async () => "" },
        stderr: { text: async () => "" },
        exited: Promise.resolve(0),
      };
    });

    const { gitCommitTask } = await import("../src/git");
    const result = await gitCommitTask("task-1", "Test Task", mockConfig, tempDir, tempDir);

    expect(result).toBe(true);
  });

  test("returns false when git add fails", async () => {
    let callCount = 0;
    Bun.spawn = mock((args: any[], options: any) => {
      callCount++;

      // git diff --name-only (has changes)
      if (callCount === 1) {
        return {
          stdout: { text: async () => "file.ts" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git diff --cached --name-only
      if (callCount === 2) {
        return {
          stdout: { text: async () => "" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git ls-files --others --exclude-standard
      if (callCount === 3) {
        return {
          stdout: { text: async () => "" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git diff --stat
      if (callCount === 4) {
        return {
          stdout: { text: async () => "file.ts | 10 ++++++++" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git add -A - FAIL
      if (callCount === 5) {
        return {
          stdout: { text: async () => "" },
          stderr: { text: async () => "error: pathspec did not match" },
          exited: Promise.resolve(1),
        };
      }

      return {
        stdout: { text: async () => "" },
        stderr: { text: async () => "" },
        exited: Promise.resolve(0),
      };
    });

    // Mock Bun.write
    Bun.write = mock(async () => {});

    // Mock callClaude using spyOn
    const claudeModule = await import("../src/claude");
    const spy = spyOn(claudeModule, "callClaude");
    spy.mockResolvedValue({
      type: "success",
      subtype: "text",
      is_error: false,
      result: "test commit message",
      total_cost_usd: 0.001,
    });

    const { gitCommitTask } = await import("../src/git");
    const result = await gitCommitTask("task-1", "Test Task", mockConfig, tempDir, tempDir);

    expect(result).toBe(false);
    spy.mockRestore();
  });

  test("returns true when git commit succeeds", async () => {
    let callCount = 0;
    Bun.spawn = mock((args: any[], options: any) => {
      callCount++;

      // git diff --name-only
      if (callCount === 1) {
        return {
          stdout: { text: async () => "file.ts" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git diff --cached --name-only
      if (callCount === 2) {
        return {
          stdout: { text: async () => "" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git ls-files --others --exclude-standard
      if (callCount === 3) {
        return {
          stdout: { text: async () => "" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git diff --stat (for commit message)
      if (callCount === 4) {
        return {
          stdout: { text: async () => "file.ts | 10 ++++++++" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git add -A
      if (callCount === 5) {
        return {
          stdout: { text: async () => "" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git commit - SUCCESS
      if (callCount === 6) {
        return {
          stdout: { text: async () => "[main abc123] test commit" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }

      return {
        stdout: { text: async () => "" },
        stderr: { text: async () => "" },
        exited: Promise.resolve(0),
      };
    });

    Bun.write = mock(async () => {});

    // Mock callClaude
    const claudeModule = await import("../src/claude");
    const spy = spyOn(claudeModule, "callClaude");
    spy.mockResolvedValue({
      type: "success",
      subtype: "text",
      is_error: false,
      result: "test commit message",
      total_cost_usd: 0.001,
    });

    const { gitCommitTask } = await import("../src/git");
    const result = await gitCommitTask("task-1", "Test Task", mockConfig, tempDir, tempDir);

    expect(result).toBe(true);
    spy.mockRestore();
  });

  test("returns false when git commit fails", async () => {
    let callCount = 0;
    Bun.spawn = mock((args: any[], options: any) => {
      callCount++;

      // git diff --name-only
      if (callCount === 1) {
        return {
          stdout: { text: async () => "file.ts" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git diff --cached --name-only
      if (callCount === 2) {
        return {
          stdout: { text: async () => "" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git ls-files --others --exclude-standard
      if (callCount === 3) {
        return {
          stdout: { text: async () => "" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git diff --stat
      if (callCount === 4) {
        return {
          stdout: { text: async () => "file.ts | 10 ++++++++" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git add -A
      if (callCount === 5) {
        return {
          stdout: { text: async () => "" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git commit - FAIL
      if (callCount === 6) {
        return {
          stdout: { text: async () => "some output" },
          stderr: { text: async () => "error: commit failed" },
          exited: Promise.resolve(1),
        };
      }

      return {
        stdout: { text: async () => "" },
        stderr: { text: async () => "" },
        exited: Promise.resolve(0),
      };
    });

    Bun.write = mock(async () => {});

    // Mock callClaude
    const claudeModule = await import("../src/claude");
    const spy = spyOn(claudeModule, "callClaude");
    spy.mockResolvedValue({
      type: "success",
      subtype: "text",
      is_error: false,
      result: "test commit message",
      total_cost_usd: 0.001,
    });

    const { gitCommitTask } = await import("../src/git");
    const result = await gitCommitTask("task-1", "Test Task", mockConfig, tempDir, tempDir);

    expect(result).toBe(false);
    spy.mockRestore();
  });

  test("logs both stdout and stderr when commit fails", async () => {
    const logMessages: string[] = [];

    let callCount = 0;
    Bun.spawn = mock((args: any[], options: any) => {
      callCount++;

      // git diff --name-only
      if (callCount === 1) {
        return {
          stdout: { text: async () => "file.ts" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git diff --cached --name-only
      if (callCount === 2) {
        return {
          stdout: { text: async () => "" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git ls-files --others --exclude-standard
      if (callCount === 3) {
        return {
          stdout: { text: async () => "" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git diff --stat
      if (callCount === 4) {
        return {
          stdout: { text: async () => "file.ts | 10 ++++++++" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git add -A
      if (callCount === 5) {
        return {
          stdout: { text: async () => "" },
          stderr: { text: async () => "" },
          exited: Promise.resolve(0),
        };
      }
      // git commit - FAIL with both stdout and stderr
      if (callCount === 6) {
        return {
          stdout: { text: async () => "some stdout output" },
          stderr: { text: async () => "error: commit failed" },
          exited: Promise.resolve(1),
        };
      }

      return {
        stdout: { text: async () => "" },
        stderr: { text: async () => "" },
        exited: Promise.resolve(0),
      };
    });

    Bun.write = mock(async () => {});

    // Mock logger
    const logModule = await import("../src/logger");
    const errorSpy = spyOn(logModule.log, "error");
    errorSpy.mockImplementation((msg: string) => {
      logMessages.push(msg);
    });

    // Mock callClaude
    const claudeModule = await import("../src/claude");
    const claudeSpy = spyOn(claudeModule, "callClaude");
    claudeSpy.mockResolvedValue({
      type: "success",
      subtype: "text",
      is_error: false,
      result: "test commit message",
      total_cost_usd: 0.001,
    });

    const { gitCommitTask } = await import("../src/git");
    await gitCommitTask("task-1", "Test Task", mockConfig, tempDir, tempDir);

    // Check that both stdout and stderr were logged
    const hasStdout = logMessages.some(msg => msg.includes("some stdout output"));
    const hasStderr = logMessages.some(msg => msg.includes("error: commit failed"));

    expect(hasStdout).toBe(true);
    expect(hasStderr).toBe(true);

    errorSpy.mockRestore();
    claudeSpy.mockRestore();
  });
});

describe("getGitLog", () => {
  test("returns success with output for valid git repository", async () => {
    // Use the current project root which is a git repo
    const { getGitLog } = await import("../src/git");
    const result = await getGitLog(process.cwd());
    expect(result.success).toBe(true);
    expect(typeof result.output).toBe('string');
  });

  test("returns failure for non-git directory", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'git-test-'));
    const { getGitLog } = await import("../src/git");
    const result = await getGitLog(tempDir);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("respects maxCommits parameter", async () => {
    const { getGitLog } = await import("../src/git");
    const result = await getGitLog(process.cwd(), undefined, 3);
    expect(result.success).toBe(true);
    const lines = result.output.split('\n').filter(l => l.trim());
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  test("handles sinceTimestamp parameter", async () => {
    const { getGitLog } = await import("../src/git");
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const result = await getGitLog(process.cwd(), futureDate);
    expect(result.success).toBe(true);
    expect(result.output).toBe(''); // No commits in the future
  });
});
