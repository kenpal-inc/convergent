import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { generateSummaryReport } from '../src/reports';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

function createTestDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'summary-test-'));
}

function writeJson(dir: string, filename: string, data: unknown): void {
  writeFileSync(path.join(dir, filename), JSON.stringify(data), 'utf-8');
}

function makeConfig(autoCommit = false) {
  return {
    git: { auto_commit: autoCommit, branch: 'test' },
  } as any;
}

function makeTasks(tasks: Array<{ id: string; title: string }>) {
  return tasks;
}

function makeState(taskStatuses: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    tasks_status: Object.fromEntries(
      Object.entries(taskStatuses).map(([id, status]) => [id, { status }])
    ),
    started_at: '2024-01-01T00:00:00Z',
    last_updated: '2024-01-01T00:30:00Z',
    stopped_reason: 'all_complete',
    iterations: 5,
    ...extra,
  };
}

function makeBudget(totalCost: number) {
  return { total_usd: totalCost };
}

describe('generateSummaryReport', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('creates summary.md with correct structure', async () => {
    writeJson(testDir, 'tasks.json', { tasks: makeTasks([{ id: 'task-001', title: 'Test Task' }]) });
    writeJson(testDir, 'state.json', makeState({ 'task-001': 'completed' }));
    writeJson(testDir, 'budget.json', makeBudget(1.50));

    const result = await generateSummaryReport(makeConfig(), testDir, testDir);
    expect(result).toBe(true);

    const content = readFileSync(path.join(testDir, 'reports', 'summary.md'), 'utf-8');
    expect(content).toContain('# Execution Summary Report');
    expect(content).toContain('## Overview');
    expect(content).toContain('## Task Status Summary');
    expect(content).toContain('## Task Details');
    expect(content).toContain('| Task ID | Title | Status | Report |');
  });

  test('includes all task statuses correctly', async () => {
    writeJson(testDir, 'tasks.json', { tasks: makeTasks([
      { id: 'task-001', title: 'T1' },
      { id: 'task-002', title: 'T2' },
      { id: 'task-003', title: 'T3' },
      { id: 'task-004', title: 'T4' },
      { id: 'task-005', title: 'T5' },
    ]) });
    writeJson(testDir, 'state.json', makeState({
      'task-001': 'completed',
      'task-002': 'failed',
      'task-003': 'blocked',
      'task-004': 'pending',
      'task-005': 'in_progress',
    }));
    writeJson(testDir, 'budget.json', makeBudget(0));

    await generateSummaryReport(makeConfig(), testDir, testDir);
    const content = readFileSync(path.join(testDir, 'reports', 'summary.md'), 'utf-8');
    expect(content).toContain('completed');
    expect(content).toContain('failed');
    expect(content).toContain('blocked');
    expect(content).toContain('pending');
    expect(content).toContain('in_progress');
  });

  test('includes total cost formatted as dollar amount', async () => {
    writeJson(testDir, 'tasks.json', { tasks: makeTasks([{ id: 'task-001', title: 'T' }]) });
    writeJson(testDir, 'state.json', makeState({ 'task-001': 'completed' }));
    writeJson(testDir, 'budget.json', makeBudget(1.5));

    await generateSummaryReport(makeConfig(), testDir, testDir);
    const content = readFileSync(path.join(testDir, 'reports', 'summary.md'), 'utf-8');
    expect(content).toContain('$1.50');
  });

  test('links to existing individual task reports', async () => {
    writeJson(testDir, 'tasks.json', { tasks: makeTasks([{ id: 'task-001', title: 'T' }]) });
    writeJson(testDir, 'state.json', makeState({ 'task-001': 'completed' }));
    writeJson(testDir, 'budget.json', makeBudget(0));
    // Create the individual report
    mkdirSync(path.join(testDir, 'reports'), { recursive: true });
    writeFileSync(path.join(testDir, 'reports', 'task-001.md'), '# Report', 'utf-8');

    await generateSummaryReport(makeConfig(), testDir, testDir);
    const content = readFileSync(path.join(testDir, 'reports', 'summary.md'), 'utf-8');
    expect(content).toContain('[task-001.md](./task-001.md)');
  });

  test('shows dash for missing individual task reports', async () => {
    writeJson(testDir, 'tasks.json', { tasks: makeTasks([{ id: 'task-001', title: 'T' }]) });
    writeJson(testDir, 'state.json', makeState({ 'task-001': 'completed' }));
    writeJson(testDir, 'budget.json', makeBudget(0));

    await generateSummaryReport(makeConfig(), testDir, testDir);
    const content = readFileSync(path.join(testDir, 'reports', 'summary.md'), 'utf-8');
    expect(content).toContain('| task-001 | T | completed | - |');
  });

  test('omits git history section when auto_commit is false', async () => {
    writeJson(testDir, 'tasks.json', { tasks: makeTasks([{ id: 'task-001', title: 'T' }]) });
    writeJson(testDir, 'state.json', makeState({ 'task-001': 'completed' }));
    writeJson(testDir, 'budget.json', makeBudget(0));

    await generateSummaryReport(makeConfig(false), testDir, testDir);
    const content = readFileSync(path.join(testDir, 'reports', 'summary.md'), 'utf-8');
    expect(content).not.toContain('## Git Commit History');
  });

  test('includes git history section when auto_commit is true', async () => {
    writeJson(testDir, 'tasks.json', { tasks: makeTasks([{ id: 'task-001', title: 'T' }]) });
    writeJson(testDir, 'state.json', makeState({ 'task-001': 'completed' }));
    writeJson(testDir, 'budget.json', makeBudget(0));

    await generateSummaryReport(makeConfig(true), testDir, testDir);
    const content = readFileSync(path.join(testDir, 'reports', 'summary.md'), 'utf-8');
    expect(content).toContain('## Git Commit History');
  });

  test('returns false when state.json is missing', async () => {
    writeJson(testDir, 'tasks.json', { tasks: makeTasks([]) });
    const result = await generateSummaryReport(makeConfig(), testDir, testDir);
    expect(result).toBe(false);
  });

  test('returns false when tasks.json is missing', async () => {
    writeJson(testDir, 'state.json', makeState({}));
    const result = await generateSummaryReport(makeConfig(), testDir, testDir);
    expect(result).toBe(false);
  });

  test('handles empty task list without crashing', async () => {
    writeJson(testDir, 'tasks.json', { tasks: makeTasks([]) });
    writeJson(testDir, 'state.json', makeState({}));
    writeJson(testDir, 'budget.json', makeBudget(0));

    const result = await generateSummaryReport(makeConfig(), testDir, testDir);
    expect(result).toBe(true);
    const content = readFileSync(path.join(testDir, 'reports', 'summary.md'), 'utf-8');
    expect(content).toContain('## Task Details');
  });

  test('handles missing budget.json gracefully with $0.00 cost', async () => {
    writeJson(testDir, 'tasks.json', { tasks: makeTasks([{ id: 'task-001', title: 'T' }]) });
    writeJson(testDir, 'state.json', makeState({ 'task-001': 'completed' }));
    // No budget.json

    const result = await generateSummaryReport(makeConfig(), testDir, testDir);
    expect(result).toBe(true);
    const content = readFileSync(path.join(testDir, 'reports', 'summary.md'), 'utf-8');
    expect(content).toContain('$0.00');
  });

  test('creates reports directory if it does not exist', async () => {
    writeJson(testDir, 'tasks.json', { tasks: makeTasks([{ id: 'task-001', title: 'T' }]) });
    writeJson(testDir, 'state.json', makeState({ 'task-001': 'completed' }));
    writeJson(testDir, 'budget.json', makeBudget(0));

    // reports dir should not exist yet
    expect(existsSync(path.join(testDir, 'reports'))).toBe(false);
    await generateSummaryReport(makeConfig(), testDir, testDir);
    expect(existsSync(path.join(testDir, 'reports', 'summary.md'))).toBe(true);
  });

  test('includes stop_reason in overview', async () => {
    writeJson(testDir, 'tasks.json', { tasks: makeTasks([]) });
    writeJson(testDir, 'state.json', makeState({}, { stopped_reason: 'budget_exhausted' }));
    writeJson(testDir, 'budget.json', makeBudget(2.00));

    await generateSummaryReport(makeConfig(), testDir, testDir);
    const content = readFileSync(path.join(testDir, 'reports', 'summary.md'), 'utf-8');
    expect(content).toContain('budget_exhausted');
  });

  test('escapes pipe characters in task titles for markdown table', async () => {
    writeJson(testDir, 'tasks.json', { tasks: makeTasks([{ id: 'task-001', title: 'A | B | C' }]) });
    writeJson(testDir, 'state.json', makeState({ 'task-001': 'completed' }));
    writeJson(testDir, 'budget.json', makeBudget(0));

    await generateSummaryReport(makeConfig(), testDir, testDir);
    const content = readFileSync(path.join(testDir, 'reports', 'summary.md'), 'utf-8');
    expect(content).toContain('A \\| B \\| C');
    // The table should still have exactly the right number of columns
  });
});
