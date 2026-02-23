import { existsSync, readFileSync, writeFileSync } from "fs";
import { log } from "./logger";
import type { Budget, Config } from "./types";

/**
 * Simple async mutex using promise chaining.
 * Serializes async operations to prevent race conditions on shared resources.
 * NOTE: This is an in-memory mutex - it only protects against concurrent access
 * within the same process. It does not protect against multi-process writes.
 */
class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  /**
   * Execute an async function exclusively. Only one function runs at a time;
   * subsequent calls wait in FIFO order for the previous one to complete.
   * The mutex is always released, even if fn throws.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitForPrevious = this.queue;
    this.queue = gate;
    await waitForPrevious;
    try {
      return await fn();
    } finally {
      release!();
    }
  }
}

/** Mutex serializing all budget.json read-modify-write operations */
const budgetMutex = new AsyncMutex();

let outputDir = "";

function budgetPath(): string {
  return `${outputDir}/budget.json`;
}

function statePath(): string {
  return `${outputDir}/state.json`;
}

function readBudget(): Budget {
  if (!existsSync(budgetPath())) {
    return { entries: [], total_usd: 0 };
  }
  return JSON.parse(readFileSync(budgetPath(), "utf-8"));
}

function writeBudget(budget: Budget): void {
  writeFileSync(budgetPath(), JSON.stringify(budget, null, 2));
}

export function initBudgetModule(dir: string): void {
  outputDir = dir;
}

export async function initBudget(): Promise<void> {
  writeBudget({ entries: [], total_usd: 0 });
}

/**
 * Record a cost entry to budget.json and update state.json.
 * Thread-safe: concurrent calls are serialized via an async mutex
 * to prevent lost updates from interleaved read-modify-write cycles.
 */
export async function recordCost(label: string, cost: number): Promise<void> {
  return budgetMutex.runExclusive(async () => {
    const budget = readBudget();
    budget.entries.push({
      label,
      cost_usd: cost,
      timestamp: new Date().toISOString(),
    });
    budget.total_usd += cost;
    writeBudget(budget);

    // Update state total as well
    if (existsSync(statePath())) {
      const state = JSON.parse(readFileSync(statePath(), "utf-8"));
      state.total_cost_usd = (state.total_cost_usd || 0) + cost;
      writeFileSync(statePath(), JSON.stringify(state, null, 2));
    }
  });
}

export async function getTotalCost(): Promise<number> {
  return readBudget().total_usd;
}

export async function checkBudgetAvailable(config: Config): Promise<boolean> {
  const totalSpent = await getTotalCost();
  if (totalSpent >= config.budget.total_max_usd) {
    log.error(`Budget exhausted: $${totalSpent.toFixed(2)} / $${config.budget.total_max_usd.toFixed(2)}`);
    return false;
  }
  return true;
}

// Exported for testing only
export { AsyncMutex as _AsyncMutex_FOR_TESTING };
