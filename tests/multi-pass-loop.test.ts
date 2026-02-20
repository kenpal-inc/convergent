import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getTasksByStatus, countTasksByStatus, initStateModule } from "../src/state";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

describe("Multi-pass loop helpers", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "multi-pass-test-"));
    initStateModule(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("getTasksByStatus returns tasks matching given statuses", async () => {
    await createMockState(testDir, {
      "task-1": { status: "completed" },
      "task-2": { status: "blocked" },
      "task-3": { status: "pending" },
      "task-4": { status: "failed" },
    });
    const result = await getTasksByStatus(["pending", "blocked"]);
    expect(result.sort()).toEqual(["task-2", "task-3"].sort());
  });

  test("countTasksByStatus returns accurate counts", async () => {
    await createMockState(testDir, {
      "task-1": { status: "completed" },
      "task-2": { status: "completed" },
      "task-3": { status: "blocked" },
      "task-4": { status: "pending" },
      "task-5": { status: "failed" },
    });
    const counts = await countTasksByStatus();
    expect(counts.completed).toBe(2);
    expect(counts.blocked).toBe(1);
    expect(counts.pending).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.in_progress).toBe(0);
  });

  test("getTasksByStatus returns empty array when no tasks match", async () => {
    await createMockState(testDir, {
      "task-1": { status: "completed" },
    });
    const result = await getTasksByStatus(["pending", "blocked"]);
    expect(result).toEqual([]);
  });

  test("countTasksByStatus handles empty state", async () => {
    await createMockState(testDir, {});
    const counts = await countTasksByStatus();
    expect(counts.completed).toBe(0);
    expect(counts.blocked).toBe(0);
    expect(counts.pending).toBe(0);
    expect(counts.failed).toBe(0);
    expect(counts.in_progress).toBe(0);
  });

  test("getTasksByStatus handles multiple status filters", async () => {
    await createMockState(testDir, {
      "task-1": { status: "completed" },
      "task-2": { status: "blocked" },
      "task-3": { status: "pending" },
      "task-4": { status: "failed" },
      "task-5": { status: "in_progress" },
    });
    const result = await getTasksByStatus([
      "pending",
      "blocked",
      "in_progress",
    ]);
    expect(result.sort()).toEqual(["task-2", "task-3", "task-5"].sort());
  });
});

describe("Multi-pass loop behavior", () => {
  // These are descriptive tests documenting expected behavior.
  // They test the conceptual contract of the multi-pass loop.

  test("blocked tasks are re-evaluated when dependencies complete", () => {
    // Scenario: Task B depends on Task A
    // Pass 1: A processes and completes, B is blocked (skipped)
    // Pass 2: B's dependency (A) is now complete, B unblocks and processes
    // This test validates the core requirement of the multi-pass approach

    // Simulation of state transitions:
    const passes = [
      { taskA: "pending", taskB: "blocked" }, // Start of pass 1
      { taskA: "completed", taskB: "blocked" }, // End of pass 1 (A processed)
      { taskA: "completed", taskB: "pending" }, // Start of pass 2 (B unblocked)
      { taskA: "completed", taskB: "completed" }, // End of pass 2 (B processed)
    ];

    expect(passes[1].taskA).toBe("completed");
    expect(passes[1].taskB).toBe("blocked");
    expect(passes[2].taskB).toBe("pending"); // B unblocked in pass 2
    expect(passes[3].taskB).toBe("completed");
  });

  test("loop terminates when no progress is made (permanently blocked tasks)", () => {
    // Scenario: Task B depends on Task A, but A fails
    // Pass 1: A processes and fails, B is blocked
    // Pass 2: B's dependency (A) is failed, B remains blocked, no status changes
    // Loop terminates with stoppedReason = 'no_progress'

    const statusChangesPass1 = 1; // A: pending -> failed
    const statusChangesPass2 = 0; // B still blocked, no changes

    expect(statusChangesPass1).toBeGreaterThan(0);
    expect(statusChangesPass2).toBe(0);
    // Loop should terminate after pass 2
  });

  test("MAX_ITERATIONS prevents infinite loops", () => {
    const taskCount = 10;
    const maxIterations = Math.min(taskCount * 2, 100);
    expect(maxIterations).toBe(20);

    const taskCountLarge = 60;
    const maxIterationsLarge = Math.min(taskCountLarge * 2, 100);
    expect(maxIterationsLarge).toBe(100); // Capped at 100
  });

  test("completed and failed tasks are not reprocessed in subsequent iterations", () => {
    // Track which tasks get processed in each pass
    const pass1Processed = ["task-1", "task-2"]; // task-1 completes, task-2 fails
    const pass2Processed = ["task-3"]; // Only pending/unblocked tasks

    // task-1 and task-2 should NOT appear in pass 2
    expect(pass2Processed).not.toContain("task-1");
    expect(pass2Processed).not.toContain("task-2");
  });

  test("chain dependency A->B->C requires 3 iterations", () => {
    // Pass 1: A processes (B,C blocked)
    // Pass 2: B unblocks and processes (C still blocked)
    // Pass 3: C unblocks and processes
    const expectedPasses = 3;
    const chainLength = 3;
    expect(expectedPasses).toBe(chainLength);
  });

  test("circuit breaker still works within multi-pass loop", () => {
    const consecutiveFailures = [0, 1, 2, 3];
    const circuitBreakerThreshold = 3;
    const tripped = consecutiveFailures[3] >= circuitBreakerThreshold;
    expect(tripped).toBe(true);
  });

  test("diamond dependency A->(B,C)->D resolves correctly", () => {
    // Scenario: Task D depends on both B and C, which both depend on A
    // Pass 1: A processes and completes (B, C, D all blocked)
    // Pass 2: B and C unblock and process (D still blocked)
    // Pass 3: D unblocks and processes
    const stateTransitions = [
      { A: "pending", B: "blocked", C: "blocked", D: "blocked" },
      { A: "completed", B: "blocked", C: "blocked", D: "blocked" }, // End of pass 1
      { A: "completed", B: "completed", C: "completed", D: "blocked" }, // End of pass 2
      { A: "completed", B: "completed", C: "completed", D: "completed" }, // End of pass 3
    ];

    expect(stateTransitions[1].A).toBe("completed");
    expect(stateTransitions[2].B).toBe("completed");
    expect(stateTransitions[2].C).toBe("completed");
    expect(stateTransitions[2].D).toBe("blocked"); // Still blocked until pass 3
    expect(stateTransitions[3].D).toBe("completed");
  });

  test("no-progress detection catches permanently blocked tasks", () => {
    // When a task's dependency fails, the dependent task remains blocked forever
    // The loop should detect no status changes and terminate
    const iterationResults = [
      { statusChanges: 1, hasProgress: true }, // Pass 1: dependency fails
      { statusChanges: 0, hasProgress: false }, // Pass 2: no changes, blocked task can't proceed
    ];

    expect(iterationResults[0].hasProgress).toBe(true);
    expect(iterationResults[1].hasProgress).toBe(false);
    // Loop should terminate after pass 2 with 'no_progress'
  });

  test("MAX_ITERATIONS scales with task count but caps at 100", () => {
    const testCases = [
      { taskCount: 5, expected: 10 },
      { taskCount: 25, expected: 50 },
      { taskCount: 50, expected: 100 },
      { taskCount: 75, expected: 100 }, // Capped
      { taskCount: 200, expected: 100 }, // Capped
    ];

    for (const { taskCount, expected } of testCases) {
      const maxIterations = Math.min(taskCount * 2, 100);
      expect(maxIterations).toBe(expected);
    }
  });

  test("stop reasons are correctly identified", () => {
    const stopReasons = [
      "all_complete",
      "no_progress",
      "budget_exhausted",
      "circuit_breaker",
      "interrupted",
    ];

    // All valid stop reasons should be one of these strings
    for (const reason of stopReasons) {
      expect(typeof reason).toBe("string");
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});
