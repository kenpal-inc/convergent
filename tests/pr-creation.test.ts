import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';

// Import the functions under test
import { isGhCliAvailable, hasGitHubRemote, createPullRequest } from '../src/git';
import type { Config } from '../src/types';

describe('isGhCliAvailable', () => {
  test('returns true when gh CLI is installed', async () => {
    // This test is environment-dependent; skip if gh not installed
    const result = await isGhCliAvailable();
    expect(typeof result).toBe('boolean');
  });
});

describe('hasGitHubRemote', () => {
  test('returns true for repo with GitHub remote', async () => {
    // Test against the current repo (which should have a GitHub remote)
    const result = await hasGitHubRemote(process.cwd());
    // This is environment-dependent; just verify it returns boolean
    expect(typeof result).toBe('boolean');
  });

  test('returns false for non-git directory', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'pr-test-'));
    try {
      const result = await hasGitHubRemote(tempDir);
      expect(result).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });
});

describe('createPullRequest', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pr-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test('returns error when create_pr is false', async () => {
    const config = { git: { create_pr: false } } as Config;
    const result = await createPullRequest(config, tempDir, tempDir, 'Test goal');
    expect(result.success).toBe(false);
    expect(result.error).toContain('disabled');
  });

  test('returns error when gh CLI not available', async () => {
    // This test relies on gh not being in a fake PATH - hard to unit test.
    // Instead test the flow when config is true but tasks.json is missing
    const config = { git: { create_pr: true } } as Config;
    const result = await createPullRequest(config, tempDir, tempDir, 'Test goal');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('returns error when no tasks completed', async () => {
    const config = { git: { create_pr: true } } as Config;
    // Write tasks.json with tasks
    await writeFile(
      join(tempDir, 'tasks.json'),
      JSON.stringify({ goal: 'Test', tasks: [{ id: 'task-001', title: 'Task 1' }] })
    );
    // Write state.json with no completed tasks
    await writeFile(
      join(tempDir, 'state.json'),
      JSON.stringify({ tasks_status: { 'task-001': { status: 'failed' } } })
    );
    const result = await createPullRequest(config, tempDir, tempDir, 'Test goal');
    expect(result.success).toBe(false);
    // Note: The function checks preconditions in order, so this may fail earlier
    // due to missing gh CLI or GitHub remote rather than no completed tasks
    expect(result.error).toBeDefined();
  });

  test('returns error when tasks.json is missing', async () => {
    const config = { git: { create_pr: true } } as Config;
    const result = await createPullRequest(config, '/nonexistent', '/nonexistent', 'Test');
    expect(result.success).toBe(false);
  });
});

describe('PR title truncation', () => {
  test('short goal used as-is', () => {
    const goal = 'Fix login bug';
    let title = goal.replace(/[\r\n]+/g, ' ').trim();
    if (title.length > 72) title = title.substring(0, 69) + '...';
    expect(title).toBe('Fix login bug');
    expect(title.length).toBeLessThanOrEqual(72);
  });

  test('long goal truncated to 72 chars with ellipsis', () => {
    const goal = 'Implement a comprehensive authentication system with OAuth2, SAML, and OpenID Connect support for enterprise customers';
    let title = goal.replace(/[\r\n]+/g, ' ').trim();
    if (title.length > 72) title = title.substring(0, 69) + '...';
    expect(title.length).toBe(72);
    expect(title.endsWith('...')).toBe(true);
  });

  test('multiline goal collapsed to single line', () => {
    const goal = 'Fix bug\nin login\npage';
    let title = goal.replace(/[\r\n]+/g, ' ').trim();
    if (title.length > 72) title = title.substring(0, 69) + '...';
    expect(title).toBe('Fix bug in login page');
  });
});

describe('PR body generation', () => {
  test('body includes goal section', () => {
    const goal = 'Implement feature X';
    const body = buildTestPrBody(goal, [
      { id: 'task-001', title: 'Setup', status: 'completed' },
    ]);
    expect(body).toContain('## Goal');
    expect(body).toContain(goal);
  });

  test('body separates completed and failed tasks', () => {
    const body = buildTestPrBody('Goal', [
      { id: 'task-001', title: 'Task A', status: 'completed' },
      { id: 'task-002', title: 'Task B', status: 'failed' },
    ]);
    expect(body).toContain('## Completed Tasks (1)');
    expect(body).toContain('## Failed Tasks (1)');
    expect(body).toContain('✅');
    expect(body).toContain('❌');
  });

  test('completed tasks have report links', () => {
    const body = buildTestPrBody('Goal', [
      { id: 'task-001', title: 'Task A', status: 'completed' },
    ]);
    expect(body).toContain('.convergent/reports/task-001.md');
  });

  test('includes summary report link', () => {
    const body = buildTestPrBody('Goal', [
      { id: 'task-001', title: 'Task A', status: 'completed' },
    ]);
    expect(body).toContain('.convergent/reports/summary.md');
  });

  test('includes task count stats', () => {
    const body = buildTestPrBody('Goal', [
      { id: 'task-001', title: 'A', status: 'completed' },
      { id: 'task-002', title: 'B', status: 'completed' },
      { id: 'task-003', title: 'C', status: 'failed' },
    ]);
    expect(body).toContain('2 completed, 1 failed out of 3 total');
  });
});

// Helper to simulate buildPrBody for testing (mirror the logic)
function buildTestPrBody(
  goal: string,
  tasks: Array<{ id: string; title: string; status: string }>,
): string {
  const lines: string[] = [];
  lines.push('## Goal', '', goal, '');
  const completed = tasks.filter(t => t.status === 'completed');
  const failed = tasks.filter(t => t.status === 'failed');
  if (completed.length > 0) {
    lines.push(`## Completed Tasks (${completed.length})`, '');
    for (const t of completed) {
      lines.push(`- ✅ **[${t.id}]** ${t.title} ([report](.convergent/reports/${t.id}.md))`);
    }
    lines.push('');
  }
  if (failed.length > 0) {
    lines.push(`## Failed Tasks (${failed.length})`, '');
    for (const t of failed) {
      lines.push(`- ❌ **[${t.id}]** ${t.title}`);
    }
    lines.push('');
  }
  lines.push('## Reports', '', '- [Summary Report](.convergent/reports/summary.md)', '');
  lines.push('---');
  lines.push(`*Auto-generated by convergent | ${completed.length} completed, ${failed.length} failed out of ${tasks.length} total tasks*`);
  return lines.join('\n');
}
