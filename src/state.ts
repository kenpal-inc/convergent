import { existsSync } from "fs";
import { log } from "./logger";
import type { State, Task, TaskStatus, TaskStatusValue, TaskPhase } from "./types";

let outputDir = "";

function statePath(): string {
  return `${outputDir}/state.json`;
}

function tasksPath(): string {
  return `${outputDir}/tasks.json`;
}

async function readState(): Promise<State> {
  return Bun.file(statePath()).json() as Promise<State>;
}

async function writeState(state: State): Promise<void> {
  await Bun.write(statePath(), JSON.stringify(state, null, 2));
}

export function initStateModule(dir: string): void {
  outputDir = dir;
}

export async function initState(): Promise<void> {
  const tasks = (await Bun.file(tasksPath()).json()) as { tasks: Task[] };
  const now = new Date().toISOString();

  const tasksStatus: Record<string, TaskStatus> = {};
  for (const task of tasks.tasks) {
    tasksStatus[task.id] = { status: "pending" };
  }

  const state: State = {
    current_task_index: 0,
    tasks_status: tasksStatus,
    total_cost_usd: 0,
    consecutive_failures: 0,
    started_at: now,
    last_updated: now,
  };

  await writeState(state);
}

export async function getTaskStatus(taskId: string): Promise<TaskStatusValue> {
  const state = await readState();
  return state.tasks_status[taskId]?.status ?? "unknown" as TaskStatusValue;
}

export async function updateTaskStatus(
  taskId: string,
  status: TaskStatusValue,
  phase?: TaskPhase,
  options?: { softFailure?: boolean },
): Promise<void> {
  const state = await readState();
  const now = new Date().toISOString();

  if (!state.tasks_status[taskId]) {
    state.tasks_status[taskId] = { status: "pending" };
  }

  state.tasks_status[taskId].status = status;
  state.last_updated = now;

  if (phase) {
    state.tasks_status[taskId].phase = phase;
  }

  if (status === "completed") {
    state.tasks_status[taskId].completed_at = now;
    state.consecutive_failures = 0;
  } else if (status === "failed") {
    // softFailure: don't count toward circuit breaker (e.g. Phase A structured output failure)
    if (!options?.softFailure) {
      state.consecutive_failures += 1;
    }
  }

  await writeState(state);
}

export async function getConsecutiveFailures(): Promise<number> {
  const state = await readState();
  return state.consecutive_failures ?? 0;
}

export async function checkDependenciesMet(
  taskId: string,
  tasks: Task[],
): Promise<boolean> {
  const task = tasks.find((t) => t.id === taskId);
  if (!task || !task.depends_on || task.depends_on.length === 0) return true;

  const state = await readState();
  for (const dep of task.depends_on) {
    if (state.tasks_status[dep]?.status !== "completed") {
      log.debug(`Dependency not met: ${dep} (status: ${state.tasks_status[dep]?.status})`);
      return false;
    }
  }
  return true;
}

export function checkNoCircularDeps(tasks: Task[]): boolean {
  // Topological sort using Kahn's algorithm
  const inDegree: Record<string, number> = {};
  const adj: Record<string, string[]> = {};

  for (const task of tasks) {
    inDegree[task.id] = 0;
    adj[task.id] = [];
  }

  for (const task of tasks) {
    for (const dep of task.depends_on ?? []) {
      if (adj[dep]) {
        adj[dep].push(task.id);
        inDegree[task.id] = (inDegree[task.id] ?? 0) + 1;
      }
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of Object.entries(inDegree)) {
    if (degree === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of adj[node] ?? []) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) queue.push(neighbor);
    }
  }

  if (visited !== tasks.length) {
    log.error("Circular dependency detected in task queue");
    return false;
  }
  return true;
}

export async function getTasksByStatus(
  statuses: TaskStatusValue[]
): Promise<string[]> {
  const state = await readState();
  return Object.entries(state.tasks_status)
    .filter(([_, taskStatus]) => statuses.includes(taskStatus.status))
    .map(([taskId, _]) => taskId);
}

/**
 * Count tasks by status across all 5 possible status values
 * @returns Object with counts for: pending, blocked, in_progress, completed, failed
 */
export async function countTasksByStatus(): Promise<Record<string, number>> {
  const state = await readState();
  const counts: Record<string, number> = {
    pending: 0,
    blocked: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
  };
  for (const [_, taskStatus] of Object.entries(state.tasks_status)) {
    counts[taskStatus.status] = (counts[taskStatus.status] || 0) + 1;
  }
  return counts;
}

export async function resetFailedTasks(): Promise<string[]> {
  const state = await readState();
  const resetIds: string[] = [];

  for (const [taskId, taskStatus] of Object.entries(state.tasks_status)) {
    if (taskStatus.status === "failed") {
      taskStatus.status = "pending";
      taskStatus.phase = undefined;
      resetIds.push(taskId);
    }
  }

  // Also reset blocked tasks (their dependencies may now be retried)
  for (const [taskId, taskStatus] of Object.entries(state.tasks_status)) {
    if (taskStatus.status === "blocked") {
      taskStatus.status = "pending";
      taskStatus.phase = undefined;
      resetIds.push(taskId);
    }
  }

  state.consecutive_failures = 0;
  state.last_updated = new Date().toISOString();
  await writeState(state);

  return resetIds;
}

export async function updatePrUrl(prUrl: string): Promise<void> {
  try {
    const state = await readState();
    state.pr_url = prUrl;
    await writeState(state);
  } catch (e) {
    // Non-fatal: log but don't throw
    console.warn(`Failed to update pr_url in state.json: ${e}`);
  }
}
