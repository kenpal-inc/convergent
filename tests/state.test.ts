import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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
