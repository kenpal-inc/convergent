import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStateModule, countTasksByStatus, recordTournamentMetrics } from "../src/state";
import { readFile } from "node:fs/promises";
import type { TournamentMetrics } from "../src/types";

// Helper to create a mock state file
async function createMockState(
  dir: string,
  tasks: Record<string, { status: string }>
) {
  const statePath = join(dir, "state.json");
  const stateContent = {
    current_task_index: 0,
    tasks_status: tasks,
    total_cost_usd: 0,
    consecutive_failures: 0,
    started_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
  };
  await writeFile(statePath, JSON.stringify(stateContent, null, 2));
}

describe("countTasksByStatus", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "state-test-"));
    initStateModule(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("returns all 5 status types with correct counts", async () => {
    await createMockState(testDir, {
      "task-1": { status: "pending" },
      "task-2": { status: "blocked" },
      "task-3": { status: "in_progress" },
      "task-4": { status: "completed" },
      "task-5": { status: "failed" },
    });

    const counts = await countTasksByStatus();

    // Verify all 5 status types are present
    expect(counts).toHaveProperty("pending");
    expect(counts).toHaveProperty("blocked");
    expect(counts).toHaveProperty("in_progress");
    expect(counts).toHaveProperty("completed");
    expect(counts).toHaveProperty("failed");

    // Verify correct counts
    expect(counts.pending).toBe(1);
    expect(counts.blocked).toBe(1);
    expect(counts.in_progress).toBe(1);
    expect(counts.completed).toBe(1);
    expect(counts.failed).toBe(1);
  });

  test("returns all zeros with no tasks", async () => {
    await createMockState(testDir, {});

    const counts = await countTasksByStatus();

    expect(counts.pending).toBe(0);
    expect(counts.blocked).toBe(0);
    expect(counts.in_progress).toBe(0);
    expect(counts.completed).toBe(0);
    expect(counts.failed).toBe(0);
  });

  test("accurately counts tasks in each status category", async () => {
    await createMockState(testDir, {
      "task-1": { status: "pending" },
      "task-2": { status: "pending" },
      "task-3": { status: "pending" },
      "task-4": { status: "blocked" },
      "task-5": { status: "blocked" },
      "task-6": { status: "in_progress" },
      "task-7": { status: "completed" },
      "task-8": { status: "completed" },
      "task-9": { status: "completed" },
      "task-10": { status: "completed" },
      "task-11": { status: "failed" },
    });

    const counts = await countTasksByStatus();

    expect(counts.pending).toBe(3);
    expect(counts.blocked).toBe(2);
    expect(counts.in_progress).toBe(1);
    expect(counts.completed).toBe(4);
    expect(counts.failed).toBe(1);
  });

  test("handles unknown status gracefully (if any exist in malformed state)", async () => {
    await createMockState(testDir, {
      "task-1": { status: "completed" },
      "task-2": { status: "unknown_status" }, // Malformed
      "task-3": { status: "pending" },
    });

    const counts = await countTasksByStatus();

    // Should handle unknown status without crashing
    expect(counts.completed).toBe(1);
    expect(counts.pending).toBe(1);
    // Unknown status might increment a non-standard key or be ignored
    // The function should still return valid counts for known statuses
    expect(counts.failed).toBe(0);
    expect(counts.blocked).toBe(0);
    expect(counts.in_progress).toBe(0);
  });

  test("handles only pending tasks", async () => {
    await createMockState(testDir, {
      "task-1": { status: "pending" },
      "task-2": { status: "pending" },
      "task-3": { status: "pending" },
      "task-4": { status: "pending" },
    });

    const counts = await countTasksByStatus();

    expect(counts.pending).toBe(4);
    expect(counts.blocked).toBe(0);
    expect(counts.in_progress).toBe(0);
    expect(counts.completed).toBe(0);
    expect(counts.failed).toBe(0);
  });

  test("handles only completed tasks", async () => {
    await createMockState(testDir, {
      "task-1": { status: "completed" },
      "task-2": { status: "completed" },
      "task-3": { status: "completed" },
    });

    const counts = await countTasksByStatus();

    expect(counts.completed).toBe(3);
    expect(counts.pending).toBe(0);
    expect(counts.blocked).toBe(0);
    expect(counts.in_progress).toBe(0);
    expect(counts.failed).toBe(0);
  });

  test("handles mixed in_progress and blocked tasks", async () => {
    await createMockState(testDir, {
      "task-1": { status: "in_progress" },
      "task-2": { status: "in_progress" },
      "task-3": { status: "blocked" },
      "task-4": { status: "blocked" },
      "task-5": { status: "blocked" },
    });

    const counts = await countTasksByStatus();

    expect(counts.in_progress).toBe(2);
    expect(counts.blocked).toBe(3);
    expect(counts.pending).toBe(0);
    expect(counts.completed).toBe(0);
    expect(counts.failed).toBe(0);
  });
});

describe("TournamentMetrics with synthesis fields", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "state-test-"));
    initStateModule(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("synthesis fields can be stored and retrieved from state.json", async () => {
    await createMockState(testDir, {
      "task-001": { status: "in_progress" },
    });

    const metrics: TournamentMetrics = {
      competitors_count: 3,
      implementations_succeeded: 2,
      verifications_passed: 2,
      winner_strategy: "synthesis",
      winner_score: 85,
      score_spread: 10,
      convergence_ratio: 0.75,
      diff_lines_winner: 120,
      synthesis_attempted: true,
      synthesis_succeeded: true,
      synthesis_fell_back: false,
      synthesis_rationale: "High convergence ratio with complementary patterns",
      synthesis_convergent_patterns: [
        "Both implementations used middleware pattern for auth",
        "Error handling follows existing codebase conventions",
      ],
    };

    await recordTournamentMetrics("task-001", metrics);

    // Read back from state.json and verify
    const stateContent = JSON.parse(await readFile(join(testDir, "state.json"), "utf-8"));
    const storedMetrics = stateContent.tasks_status["task-001"].tournament_metrics;

    expect(storedMetrics).toBeDefined();
    expect(storedMetrics.synthesis_attempted).toBe(true);
    expect(storedMetrics.synthesis_succeeded).toBe(true);
    expect(storedMetrics.synthesis_fell_back).toBe(false);
    expect(storedMetrics.synthesis_rationale).toBe("High convergence ratio with complementary patterns");
    expect(storedMetrics.synthesis_convergent_patterns).toEqual([
      "Both implementations used middleware pattern for auth",
      "Error handling follows existing codebase conventions",
    ]);

    // Also verify the original fields are preserved
    expect(storedMetrics.competitors_count).toBe(3);
    expect(storedMetrics.winner_strategy).toBe("synthesis");
    expect(storedMetrics.winner_score).toBe(85);
  });

  test("synthesis fields are optional and backward compatible", async () => {
    await createMockState(testDir, {
      "task-002": { status: "in_progress" },
    });

    // Metrics without any synthesis fields (pre-synthesis state)
    const metrics: TournamentMetrics = {
      competitors_count: 2,
      implementations_succeeded: 1,
      verifications_passed: 1,
      winner_strategy: "pragmatist",
      winner_score: 100,
      score_spread: 0,
    };

    await recordTournamentMetrics("task-002", metrics);

    const stateContent = JSON.parse(await readFile(join(testDir, "state.json"), "utf-8"));
    const storedMetrics = stateContent.tasks_status["task-002"].tournament_metrics;

    expect(storedMetrics).toBeDefined();
    expect(storedMetrics.competitors_count).toBe(2);
    expect(storedMetrics.winner_strategy).toBe("pragmatist");
    // Synthesis fields should not be present
    expect(storedMetrics.synthesis_fell_back).toBeUndefined();
    expect(storedMetrics.synthesis_rationale).toBeUndefined();
    expect(storedMetrics.synthesis_convergent_patterns).toBeUndefined();
  });
});
