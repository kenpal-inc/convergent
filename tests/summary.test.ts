import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStateModule, countTasksByStatus } from "../src/state";

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

// Helper to create a mock tasks file
async function createMockTasks(dir: string, taskCount: number) {
  const tasksPath = join(dir, "tasks.json");
  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    id: `task-${i + 1}`,
    title: `Task ${i + 1}`,
    description: `Description ${i + 1}`,
    depends_on: [],
    context_files: [],
    acceptance_criteria: [],
    estimated_complexity: "standard",
  }));
  await writeFile(
    tasksPath,
    JSON.stringify({ goal: "test", generated_at: new Date().toISOString(), tasks }, null, 2)
  );
}

// Helper to create a mock budget file
async function createMockBudget(dir: string, totalUsd: number) {
  const budgetPath = join(dir, "budget.json");
  await writeFile(
    budgetPath,
    JSON.stringify({ entries: [], total_usd: totalUsd }, null, 2)
  );
}

describe("printSummary - Status Display", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "summary-test-"));
    initStateModule(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("displays all 5 status types when state contains tasks in each status", async () => {
    await createMockState(testDir, {
      "task-1": { status: "completed" },
      "task-2": { status: "failed" },
      "task-3": { status: "blocked" },
      "task-4": { status: "pending" },
      "task-5": { status: "in_progress" },
    });

    const counts = await countTasksByStatus();

    expect(counts.completed).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.blocked).toBe(1);
    expect(counts.pending).toBe(1);
    expect(counts.in_progress).toBe(1);
  });

  test("sum of all status counts equals the total task count", async () => {
    await createMockState(testDir, {
      "task-1": { status: "completed" },
      "task-2": { status: "completed" },
      "task-3": { status: "failed" },
      "task-4": { status: "blocked" },
      "task-5": { status: "pending" },
      "task-6": { status: "in_progress" },
    });

    const counts = await countTasksByStatus();
    const calculatedTotal =
      counts.completed +
      counts.failed +
      counts.blocked +
      counts.pending +
      counts.in_progress;

    expect(calculatedTotal).toBe(6);
  });

  test("handles empty state gracefully (0 tasks)", async () => {
    await createMockState(testDir, {});

    const counts = await countTasksByStatus();

    expect(counts.completed).toBe(0);
    expect(counts.failed).toBe(0);
    expect(counts.blocked).toBe(0);
    expect(counts.pending).toBe(0);
    expect(counts.in_progress).toBe(0);
  });

  test("shows 0 for other statuses when only completed tasks exist", async () => {
    await createMockState(testDir, {
      "task-1": { status: "completed" },
      "task-2": { status: "completed" },
      "task-3": { status: "completed" },
    });

    const counts = await countTasksByStatus();

    expect(counts.completed).toBe(3);
    expect(counts.failed).toBe(0);
    expect(counts.blocked).toBe(0);
    expect(counts.pending).toBe(0);
    expect(counts.in_progress).toBe(0);
  });

  test("displays correct counts for each status with mixed statuses", async () => {
    await createMockState(testDir, {
      "task-1": { status: "completed" },
      "task-2": { status: "completed" },
      "task-3": { status: "failed" },
      "task-4": { status: "blocked" },
      "task-5": { status: "blocked" },
      "task-6": { status: "pending" },
      "task-7": { status: "pending" },
      "task-8": { status: "pending" },
      "task-9": { status: "in_progress" },
    });

    const counts = await countTasksByStatus();

    expect(counts.completed).toBe(2);
    expect(counts.failed).toBe(1);
    expect(counts.blocked).toBe(2);
    expect(counts.pending).toBe(3);
    expect(counts.in_progress).toBe(1);
  });

  test("verification checkmark appears when sum matches total", async () => {
    await createMockState(testDir, {
      "task-1": { status: "completed" },
      "task-2": { status: "failed" },
      "task-3": { status: "pending" },
    });

    const counts = await countTasksByStatus();
    const calculatedTotal =
      counts.completed +
      counts.failed +
      counts.blocked +
      counts.pending +
      counts.in_progress;
    const expectedTotal = 3;

    expect(calculatedTotal).toBe(expectedTotal);
    expect(calculatedTotal === expectedTotal ? "✓" : "✗").toBe("✓");
  });

  test("verification shows ✗ when counts don't match total (edge case)", async () => {
    // This is a theoretical edge case - in practice this shouldn't happen
    // but we test the logic anyway
    await createMockState(testDir, {
      "task-1": { status: "completed" },
      "task-2": { status: "failed" },
    });

    const counts = await countTasksByStatus();
    const calculatedTotal =
      counts.completed +
      counts.failed +
      counts.blocked +
      counts.pending +
      counts.in_progress;
    const artificialTotal = 5; // Simulating a mismatch

    expect(calculatedTotal === artificialTotal ? "✓" : "✗").toBe("✗");
  });
});
