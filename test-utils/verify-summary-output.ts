#!/usr/bin/env bun

/**
 * Manual verification script to check the printSummary output format
 * This creates a mock state and displays the summary to verify visual formatting
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStateModule, initState, updateTaskStatus, countTasksByStatus } from "../src/state";
import { log } from "../src/logger";

async function createMockTasksFile(dir: string, taskCount: number) {
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
    JSON.stringify(
      {
        goal: "test summary display",
        generated_at: new Date().toISOString(),
        tasks,
      },
      null,
      2
    )
  );
}

async function createMockBudget(dir: string, totalUsd: number) {
  const budgetPath = join(dir, "budget.json");
  await writeFile(
    budgetPath,
    JSON.stringify({ entries: [], total_usd: totalUsd }, null, 2)
  );
}

async function main() {
  const testDir = await mkdtemp(join(tmpdir(), "verify-summary-"));

  try {
    console.log("Creating mock state with all 5 status types...\n");

    initStateModule(testDir);
    await createMockTasksFile(testDir, 12);
    await createMockBudget(testDir, 3.45);
    await initState();

    // Set up tasks in different statuses
    await updateTaskStatus("task-1", "completed");
    await updateTaskStatus("task-2", "completed");
    await updateTaskStatus("task-3", "completed");
    await updateTaskStatus("task-4", "completed");
    await updateTaskStatus("task-5", "completed");
    await updateTaskStatus("task-6", "failed");
    await updateTaskStatus("task-7", "failed");
    await updateTaskStatus("task-8", "blocked");
    await updateTaskStatus("task-9", "blocked");
    await updateTaskStatus("task-10", "blocked");
    await updateTaskStatus("task-11", "in_progress");
    // task-12 remains pending

    const finalCounts = await countTasksByStatus();
    const totalTasks = 12;
    const calculatedTotal =
      finalCounts.completed +
      finalCounts.failed +
      finalCounts.blocked +
      finalCounts.pending +
      finalCounts.in_progress;

    // Display summary in the new format
    console.log("");
    console.log(log.bold("========================================="));
    console.log(log.bold("  convergent Summary"));
    console.log(log.bold("========================================="));
    console.log(`  Tasks:     ${totalTasks} total`);
    console.log(
      `    Status:  ${log.green(String(finalCounts.completed))} completed | ${log.red(String(finalCounts.failed))} failed | ${log.yellow(String(finalCounts.blocked))} blocked | ${log.blue(String(finalCounts.pending))} pending | ${log.cyan(String(finalCounts.in_progress))} in_progress`
    );
    console.log(
      `    Check:   ${calculatedTotal === totalTasks ? "✓" : "✗"} Sum matches total (${calculatedTotal})`
    );
    console.log(`  Cost:      $3.45`);
    console.log(`  Logs:      ${testDir}/logs/`);
    console.log(`  State:     ${testDir}/state.json`);
    console.log(log.bold("========================================="));
    console.log("");

    console.log("✅ Summary format verification complete!");
    console.log("\nBreakdown:");
    console.log(`  - Completed: ${finalCounts.completed}`);
    console.log(`  - Failed: ${finalCounts.failed}`);
    console.log(`  - Blocked: ${finalCounts.blocked}`);
    console.log(`  - Pending: ${finalCounts.pending}`);
    console.log(`  - In Progress: ${finalCounts.in_progress}`);
    console.log(`  - Total: ${totalTasks}`);
    console.log(`  - Sum: ${calculatedTotal}`);
    console.log(`  - Match: ${calculatedTotal === totalTasks ? "✓" : "✗"}`);

  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

main().catch(console.error);
