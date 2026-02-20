import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initStateModule,
  initState,
  updateTaskStatus,
  countTasksByStatus,
  getTaskStatus,
} from "../src/state";

// Helper to create a mock tasks file
async function createMockTasksFile(dir: string, taskCount: number) {
  const tasksPath = join(dir, "tasks.json");
  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    id: `task-${i + 1}`,
    title: `Task ${i + 1}`,
    description: `Description ${i + 1}`,
    depends_on: i > 0 ? [`task-${i}`] : [],
    context_files: [],
    acceptance_criteria: [],
    estimated_complexity: "standard",
  }));
  await writeFile(
    tasksPath,
    JSON.stringify(
      {
        goal: "integration test",
        generated_at: new Date().toISOString(),
        tasks,
      },
      null,
      2
    )
  );
}

describe("Integration Tests - Summary with Task Status", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "integration-test-"));
    initStateModule(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("multi-task scenario shows accurate counts in final summary", async () => {
    await createMockTasksFile(testDir, 10);
    await initState();

    // Simulate processing tasks with different outcomes
    await updateTaskStatus("task-1", "completed");
    await updateTaskStatus("task-2", "completed");
    await updateTaskStatus("task-3", "completed");
    await updateTaskStatus("task-4", "failed");
    await updateTaskStatus("task-5", "blocked");
    await updateTaskStatus("task-6", "in_progress");
    // task-7 through task-10 remain pending

    const counts = await countTasksByStatus();

    expect(counts.completed).toBe(3);
    expect(counts.failed).toBe(1);
    expect(counts.blocked).toBe(1);
    expect(counts.in_progress).toBe(1);
    expect(counts.pending).toBe(4);

    // Verify total
    const total =
      counts.completed +
      counts.failed +
      counts.blocked +
      counts.in_progress +
      counts.pending;
    expect(total).toBe(10);
  });

  test("status transitions (pending->in_progress->completed) are reflected in summary", async () => {
    await createMockTasksFile(testDir, 3);
    await initState();

    // All start as pending
    let counts = await countTasksByStatus();
    expect(counts.pending).toBe(3);

    // Transition task-1: pending -> in_progress
    await updateTaskStatus("task-1", "in_progress");
    counts = await countTasksByStatus();
    expect(counts.pending).toBe(2);
    expect(counts.in_progress).toBe(1);

    // Transition task-1: in_progress -> completed
    await updateTaskStatus("task-1", "completed");
    counts = await countTasksByStatus();
    expect(counts.pending).toBe(2);
    expect(counts.in_progress).toBe(0);
    expect(counts.completed).toBe(1);

    // Transition task-2: pending -> in_progress -> completed
    await updateTaskStatus("task-2", "in_progress");
    await updateTaskStatus("task-2", "completed");
    counts = await countTasksByStatus();
    expect(counts.pending).toBe(1);
    expect(counts.completed).toBe(2);
  });

  test("blocked tasks remain blocked and show in summary correctly", async () => {
    await createMockTasksFile(testDir, 5);
    await initState();

    // Mark some tasks as blocked
    await updateTaskStatus("task-2", "blocked");
    await updateTaskStatus("task-4", "blocked");

    let counts = await countTasksByStatus();
    expect(counts.blocked).toBe(2);
    expect(counts.pending).toBe(3);

    // Complete task-1, blocked tasks should remain blocked
    await updateTaskStatus("task-1", "completed");
    counts = await countTasksByStatus();
    expect(counts.completed).toBe(1);
    expect(counts.blocked).toBe(2);
    expect(counts.pending).toBe(2);

    // Verify blocked tasks are still blocked
    expect(await getTaskStatus("task-2")).toBe("blocked");
    expect(await getTaskStatus("task-4")).toBe("blocked");
  });

  test("resume scenario shows accurate counts after state reload", async () => {
    await createMockTasksFile(testDir, 6);
    await initState();

    // First session: process some tasks
    await updateTaskStatus("task-1", "completed");
    await updateTaskStatus("task-2", "in_progress");
    await updateTaskStatus("task-3", "blocked");

    const counts1 = await countTasksByStatus();
    expect(counts1.completed).toBe(1);
    expect(counts1.in_progress).toBe(1);
    expect(counts1.blocked).toBe(1);
    expect(counts1.pending).toBe(3);

    // Simulate resume: re-initialize state module with same directory
    initStateModule(testDir);

    // Verify counts are preserved after reload
    const counts2 = await countTasksByStatus();
    expect(counts2.completed).toBe(1);
    expect(counts2.in_progress).toBe(1);
    expect(counts2.blocked).toBe(1);
    expect(counts2.pending).toBe(3);

    // Continue processing in resumed session
    await updateTaskStatus("task-2", "completed");
    await updateTaskStatus("task-4", "failed");

    const counts3 = await countTasksByStatus();
    expect(counts3.completed).toBe(2);
    expect(counts3.failed).toBe(1);
    expect(counts3.in_progress).toBe(0);
    expect(counts3.blocked).toBe(1);
    expect(counts3.pending).toBe(2);
  });

  test("all tasks completed scenario shows correct final summary", async () => {
    await createMockTasksFile(testDir, 5);
    await initState();

    // Complete all tasks
    for (let i = 1; i <= 5; i++) {
      await updateTaskStatus(`task-${i}`, "in_progress");
      await updateTaskStatus(`task-${i}`, "completed");
    }

    const counts = await countTasksByStatus();
    expect(counts.completed).toBe(5);
    expect(counts.pending).toBe(0);
    expect(counts.in_progress).toBe(0);
    expect(counts.blocked).toBe(0);
    expect(counts.failed).toBe(0);
  });

  test("mixed outcomes scenario reflects realistic workflow", async () => {
    await createMockTasksFile(testDir, 8);
    await initState();

    // Simulate realistic workflow with mixed outcomes
    await updateTaskStatus("task-1", "completed");
    await updateTaskStatus("task-2", "completed");
    await updateTaskStatus("task-3", "failed"); // Failed task
    await updateTaskStatus("task-4", "blocked"); // Dependency failed
    await updateTaskStatus("task-5", "in_progress"); // Currently working
    await updateTaskStatus("task-6", "completed");
    // task-7, task-8 remain pending

    const counts = await countTasksByStatus();

    // Verify realistic distribution
    expect(counts.completed).toBe(3);
    expect(counts.failed).toBe(1);
    expect(counts.blocked).toBe(1);
    expect(counts.in_progress).toBe(1);
    expect(counts.pending).toBe(2);

    // Verify sum equals total tasks
    const total =
      counts.completed +
      counts.failed +
      counts.blocked +
      counts.in_progress +
      counts.pending;
    expect(total).toBe(8);
  });
});
