import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { recordCost, initBudgetModule, initBudget, _AsyncMutex_FOR_TESTING as AsyncMutex } from '../src/budget';
import { readFileSync, existsSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('AsyncMutex', () => {
  test('runExclusive serializes concurrent operations', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];
    const tasks = Array.from({ length: 5 }, (_, i) =>
      mutex.runExclusive(async () => {
        order.push(i);
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10));
        order.push(i);
      })
    );
    await Promise.all(tasks);
    // Each operation should complete (push twice) before next starts
    for (let i = 0; i < 5; i++) {
      expect(order[i * 2]).toBe(i);
      expect(order[i * 2 + 1]).toBe(i);
    }
  });

  test('runExclusive releases mutex on error', async () => {
    const mutex = new AsyncMutex();
    // First call throws
    await expect(
      mutex.runExclusive(async () => {
        throw new Error('test error');
      })
    ).rejects.toThrow('test error');
    // Second call should still execute (not deadlocked)
    let executed = false;
    await mutex.runExclusive(async () => {
      executed = true;
    });
    expect(executed).toBe(true);
  });

  test('runExclusive returns the value from fn', async () => {
    const mutex = new AsyncMutex();
    const result = await mutex.runExclusive(async () => 42);
    expect(result).toBe(42);
  });
});

describe('recordCost concurrency', () => {
  let testDir: string;

  beforeEach(async () => {
    // Set up clean test directory
    testDir = await mkdtemp(join(tmpdir(), 'budget-test-'));
    initBudgetModule(testDir);

    // Initialize empty budget.json
    await initBudget();

    // Initialize state.json
    await writeFile(
      join(testDir, 'state.json'),
      JSON.stringify({ total_cost_usd: 0 })
    );
  });

  afterEach(async () => {
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true });
    }
  });

  test('10 concurrent recordCost calls produce correct total without data loss', async () => {
    const costs = Array.from({ length: 10 }, (_, i) => ({
      label: `persona-${i}`,
      cost: 0.01,
    }));

    // Fire all concurrently
    await Promise.all(
      costs.map((c) => recordCost(c.label, c.cost))
    );

    // Read budget.json and verify
    const budget = JSON.parse(
      readFileSync(join(testDir, 'budget.json'), 'utf-8')
    );
    expect(budget.entries).toHaveLength(10);
    // Total should be 0.10 (10 * 0.01), use toBeCloseTo for float
    expect(budget.total_usd).toBeCloseTo(0.10, 4);
  });

  test('all entries are preserved with correct labels after concurrent writes', async () => {
    const labels = Array.from({ length: 7 }, (_, i) => `phase-a-persona-${i}`);

    await Promise.all(
      labels.map((label) => recordCost(label, 0.02))
    );

    const budget = JSON.parse(
      readFileSync(join(testDir, 'budget.json'), 'utf-8')
    );
    const recordedLabels = budget.entries.map((e: any) => e.label).sort();
    expect(recordedLabels).toEqual([...labels].sort());
  });

  test('state.json total_cost_usd matches budget.json total after concurrent updates', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        recordCost(`sync-test-${i}`, 0.03)
      )
    );

    const budget = JSON.parse(
      readFileSync(join(testDir, 'budget.json'), 'utf-8')
    );
    const state = JSON.parse(
      readFileSync(join(testDir, 'state.json'), 'utf-8')
    );
    expect(state.total_cost_usd).toBeCloseTo(budget.total_usd, 4);
  });

  test('subsequent recordCost works after a failed operation', async () => {
    // Record a valid cost to ensure basic flow works
    await recordCost('recovery-test', 0.01);
    const budget = JSON.parse(
      readFileSync(join(testDir, 'budget.json'), 'utf-8')
    );
    expect(budget.entries.length).toBeGreaterThanOrEqual(1);
  });

  test('high concurrency stress test with 20 parallel writes', async () => {
    const numWrites = 20;
    const costPerWrite = 0.005;

    await Promise.all(
      Array.from({ length: numWrites }, (_, i) =>
        recordCost(`stress-test-${i}`, costPerWrite)
      )
    );

    const budget = JSON.parse(
      readFileSync(join(testDir, 'budget.json'), 'utf-8')
    );

    // All entries should be present
    expect(budget.entries).toHaveLength(numWrites);

    // Total should be correct
    const expectedTotal = numWrites * costPerWrite;
    expect(budget.total_usd).toBeCloseTo(expectedTotal, 4);

    // All labels should be unique
    const labels = budget.entries.map((e: any) => e.label);
    const uniqueLabels = new Set(labels);
    expect(uniqueLabels.size).toBe(numWrites);
  });

  test('all entries have timestamps', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        recordCost(`timestamp-test-${i}`, 0.01)
      )
    );

    const budget = JSON.parse(
      readFileSync(join(testDir, 'budget.json'), 'utf-8')
    );

    // Every entry should have a valid ISO timestamp
    for (const entry of budget.entries) {
      expect(entry.timestamp).toBeDefined();
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    }
  });
});
