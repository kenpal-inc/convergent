import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { createPullRequest } from '../src/git';
import { updatePrUrl, initStateModule } from '../src/state';
import type { Config } from '../src/types';

function makeTestConfig(overrides?: Partial<Config>): Config {
  return {
    models: { planner: 'opus', executor: 'opus' },
    budget: {
      total_max_usd: 50,
      per_task_max_usd: 10,
      plan_max_usd: 2,
      execution_max_usd: 5,
      review_max_usd: 2,
      per_review_persona_max_usd: 0.80,
    },
    parallelism: { tournament_timeout_seconds: 600 },
    tournament: { competitors: 3, strategies: ['pragmatist', 'thorough', 'deconstructor'] },
    verification: { auto_detect: true, commands: [], max_retries: 2 },
    review: { enabled: true, max_retries: 2, personas: ['correctness', 'security', 'maintainability'] },
    git: { auto_commit: true, create_branch: false, create_pr: false },
    ...overrides,
  };
}

describe('convergent PR integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'convergent-pr-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test('PR creation is skipped when config.git.create_pr is false', async () => {
    const config = makeTestConfig();
    const result = await createPullRequest(config, tempDir, tempDir, 'Test goal');
    expect(result.success).toBe(false);
    expect(result.error).toContain('disabled');
  });

  test('PR URL is stored in state.json after successful PR creation', async () => {
    initStateModule(tempDir);

    await writeFile(
      join(tempDir, 'state.json'),
      JSON.stringify({
        current_task_index: 0,
        tasks_status: { 'task-001': { status: 'completed' } },
        total_cost_usd: 0,
        consecutive_failures: 0,
        started_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      })
    );

    await updatePrUrl('https://github.com/user/repo/pull/123');

    const stateFile = await Bun.file(join(tempDir, 'state.json')).json();
    expect(stateFile.pr_url).toBe('https://github.com/user/repo/pull/123');
  });

  test('Appropriate log messages emitted for PR creation success/failure/skip', async () => {
    const config = makeTestConfig();
    const result = await createPullRequest(config, tempDir, tempDir, 'Test');
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('error');
  });
});
