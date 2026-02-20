import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { formatReportMarkdown, generateDiffSummary, generateTaskReport } from '../src/reports';

// Mock the claude module
const mockCallClaude = mock(() => Promise.resolve({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'This task added a new reports module with git diff integration.',
  total_cost_usd: 0.05,
}));

mock.module('../src/claude', () => ({
  callClaude: mockCallClaude,
}));

const TEST_DIR = join(import.meta.dir, '.test-reports-tmp');

describe('formatReportMarkdown', () => {
  test('generates valid markdown with all required sections', () => {
    const result = formatReportMarkdown('001', 'Add reports feature', 'file.ts | 10 +', 'Added reporting.', '2024-01-01T00:00:00.000Z');
    expect(result).toContain('# Task Report: 001');
    expect(result).toContain('**Task:** Add reports feature');
    expect(result).toContain('**Generated:** 2024-01-01T00:00:00.000Z');
    expect(result).toContain('## Changes Summary');
    expect(result).toContain('Added reporting.');
    expect(result).toContain('## Diff Statistics');
    expect(result).toContain('file.ts | 10 +');
  });

  test('wraps diff stats in a code block', () => {
    const result = formatReportMarkdown('002', 'Test', 'stats here', 'summary', '2024-01-01T00:00:00.000Z');
    expect(result).toContain('```\nstats here\n```');
  });

  test('handles empty diff stats', () => {
    const result = formatReportMarkdown('003', 'Test', '', 'No changes.', '2024-01-01T00:00:00.000Z');
    expect(result).toContain('## Diff Statistics');
  });

  test('handles special characters in task title', () => {
    const result = formatReportMarkdown('004', 'Fix `bug` in **parser**', 'stats', 'summary', '2024-01-01T00:00:00.000Z');
    expect(result).toContain('Fix `bug` in **parser**');
  });
});

describe('generateDiffSummary', () => {
  const mockConfig = {
    models: {
      planner: 'claude-3-5-sonnet-20241022',
      persona: 'claude-3-5-sonnet-20241022',
      synthesizer: 'claude-3-5-sonnet-20241022',
      executor: 'claude-3-5-sonnet-20241022',
    },
    budget: {
      total_max_usd: 50.0,
      per_task_max_usd: 10.0,
      per_persona_max_usd: 2.0,
      synthesis_max_usd: 1.0,
      execution_max_usd: 5.0,
    },
    parallelism: {
      persona_timeout_seconds: 300,
    },
    verification: {
      commands: ['bun test'],
      max_retries: 2,
    },
    personas: {
      trivial: ['pragmatist'],
      standard: ['pragmatist', 'security'],
      complex: ['pragmatist', 'security', 'tdd'],
    },
    git: {
      auto_commit: true,
    },
  };

  beforeEach(() => {
    mockCallClaude.mockClear();
  });

  test('returns AI-generated summary when Claude succeeds', async () => {
    mockCallClaude.mockResolvedValueOnce({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'This task implemented the reporting feature.',
      total_cost_usd: 0.05,
    });
    const result = await generateDiffSummary('some diff content', 'Add reports', mockConfig);
    expect(result).toBe('This task implemented the reporting feature.');
  });

  test('returns fallback message when diff content is empty', async () => {
    const result = await generateDiffSummary('', 'Empty task', mockConfig);
    expect(result).toBe('No changes detected for this task.');
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  test('returns fallback message when Claude fails', async () => {
    mockCallClaude.mockRejectedValueOnce(new Error('API error'));
    const result = await generateDiffSummary('diff content', 'Failing task', mockConfig);
    expect(result).toBe('Summary generation failed. Please review the diff stats above.');
  });

  test('returns fallback message when Claude returns empty string', async () => {
    mockCallClaude.mockResolvedValueOnce({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      total_cost_usd: 0.05,
    });
    const result = await generateDiffSummary('diff content', 'Task', mockConfig);
    expect(result).toBe('Summary generation failed. Please review the diff stats above.');
  });

  test('passes task title in prompt to Claude', async () => {
    mockCallClaude.mockResolvedValueOnce({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Summary.',
      total_cost_usd: 0.05,
    });
    await generateDiffSummary('diff', 'My Special Task', mockConfig);
    const callArgs = mockCallClaude.mock.calls[0];
    expect(callArgs[0].prompt).toContain('My Special Task');
  });

  test('passes budget of 0.10 to Claude', async () => {
    mockCallClaude.mockResolvedValueOnce({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Summary.',
      total_cost_usd: 0.05,
    });
    await generateDiffSummary('diff', 'Task', mockConfig);
    const callArgs = mockCallClaude.mock.calls[0];
    expect(callArgs[0].maxBudgetUsd).toBe(0.10);
  });
});

describe('generateTaskReport', () => {
  const mockConfig = {
    models: {
      planner: 'claude-3-5-sonnet-20241022',
      persona: 'claude-3-5-sonnet-20241022',
      synthesizer: 'claude-3-5-sonnet-20241022',
      executor: 'claude-3-5-sonnet-20241022',
    },
    budget: {
      total_max_usd: 50.0,
      per_task_max_usd: 10.0,
      per_persona_max_usd: 2.0,
      synthesis_max_usd: 1.0,
      execution_max_usd: 5.0,
    },
    parallelism: {
      persona_timeout_seconds: 300,
    },
    verification: {
      commands: ['bun test'],
      max_retries: 2,
    },
    personas: {
      trivial: ['pragmatist'],
      standard: ['pragmatist', 'security'],
      complex: ['pragmatist', 'security', 'tdd'],
    },
    git: {
      auto_commit: true,
    },
  };

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mockCallClaude.mockClear();
    mockCallClaude.mockResolvedValue({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'AI generated summary of changes.',
      total_cost_usd: 0.05,
    });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('creates report file at correct path', async () => {
    const result = await generateTaskReport('001', 'Test Task', mockConfig, TEST_DIR, TEST_DIR);
    expect(result).toBe(true);
    const reportPath = join(TEST_DIR, 'reports', '001.md');
    expect(existsSync(reportPath)).toBe(true);
  });

  test('report content includes all sections', async () => {
    await generateTaskReport('002', 'Another Task', mockConfig, TEST_DIR, TEST_DIR);
    const content = readFileSync(join(TEST_DIR, 'reports', '002.md'), 'utf-8');
    expect(content).toContain('# Task Report: 002');
    expect(content).toContain('**Task:** Another Task');
    expect(content).toContain('## Changes Summary');
    expect(content).toContain('## Diff Statistics');
  });

  test('creates reports directory if it does not exist', async () => {
    const reportsDir = join(TEST_DIR, 'reports');
    expect(existsSync(reportsDir)).toBe(false);
    await generateTaskReport('003', 'Task', mockConfig, TEST_DIR, TEST_DIR);
    expect(existsSync(reportsDir)).toBe(true);
  });

  test('returns false on failure without throwing', async () => {
    // Use an invalid path that will cause writeFileSync to fail
    const result = await generateTaskReport('004', 'Task', mockConfig, TEST_DIR, '/nonexistent/readonly/path');
    expect(result).toBe(false);
  });

  test('multiple reports create separate files', async () => {
    await generateTaskReport('010', 'Task A', mockConfig, TEST_DIR, TEST_DIR);
    await generateTaskReport('011', 'Task B', mockConfig, TEST_DIR, TEST_DIR);
    expect(existsSync(join(TEST_DIR, 'reports', '010.md'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'reports', '011.md'))).toBe(true);
  });

  test('returns true on successful report generation', async () => {
    const result = await generateTaskReport('005', 'Task', mockConfig, TEST_DIR, TEST_DIR);
    expect(result).toBe(true);
  });
});
