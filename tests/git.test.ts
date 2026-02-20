import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createBranch, isGitRepository } from '../src/git';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

describe('createBranch', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'git-test-'));
    // Initialize a git repo with an initial commit
    // Use spawnSync with stdout:'ignore' to avoid ReadableStream issues in Bun
    Bun.spawnSync(['git', 'init'], { cwd: tempDir, stdout: 'ignore', stderr: 'ignore' });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@test.com'], { cwd: tempDir, stdout: 'ignore', stderr: 'ignore' });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: tempDir, stdout: 'ignore', stderr: 'ignore' });
    await Bun.write(path.join(tempDir, 'README.md'), '# Test');
    Bun.spawnSync(['git', 'add', '.'], { cwd: tempDir, stdout: 'ignore', stderr: 'ignore' });
    Bun.spawnSync(['git', 'commit', '-m', 'init'], { cwd: tempDir, stdout: 'ignore', stderr: 'ignore' });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('creates branch with correct timestamp format', async () => {
    const fixedDate = new Date(2024, 0, 15, 9, 5, 3); // 2024-01-15 09:05:03
    const result = await createBranch(tempDir, fixedDate);
    expect(result.success).toBe(true);
    expect(result.branchName).toBe('convergent/run-20240115090503');
  });

  test('branch name is exactly 14 digits in timestamp portion', async () => {
    const result = await createBranch(tempDir, new Date(2024, 11, 31, 23, 59, 59));
    expect(result.success).toBe(true);
    const timestamp = result.branchName.replace('convergent/run-', '');
    expect(timestamp).toMatch(/^\d{14}$/);
  });

  test('actually checks out the new branch', async () => {
    const result = await createBranch(tempDir, new Date());
    expect(result.success).toBe(true);
    const proc = Bun.spawnSync(['git', 'branch', '--show-current'], { cwd: tempDir, stdout: 'pipe', stderr: 'pipe' });
    const currentBranch = proc.stdout.toString().trim();
    expect(currentBranch).toBe(result.branchName);
  });

  test('fails gracefully when not in git repository', async () => {
    const nonGitDir = await mkdtemp(path.join(tmpdir(), 'non-git-'));
    try {
      const result = await createBranch(nonGitDir);
      expect(result.success).toBe(false);
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });

  test('fails gracefully when branch already exists', async () => {
    const fixedDate = new Date(2024, 5, 1, 12, 0, 0);
    const first = await createBranch(tempDir, fixedDate);
    expect(first.success).toBe(true);
    // Checkout back to main/master to allow creating again
    Bun.spawnSync(['git', 'checkout', '-'], { cwd: tempDir, stdout: 'ignore', stderr: 'ignore' });
    const second = await createBranch(tempDir, fixedDate);
    expect(second.success).toBe(false);
    expect(second.error).toContain('already exists');
  });
});

describe('isGitRepository', () => {
  test('returns true for valid git repo', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'git-test-'));
    Bun.spawnSync(['git', 'init'], { cwd: tempDir, stdout: 'ignore', stderr: 'ignore' });
    expect(await isGitRepository(tempDir)).toBe(true);
    await rm(tempDir, { recursive: true, force: true });
  });

  test('returns false for non-git directory', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'non-git-'));
    expect(await isGitRepository(tempDir)).toBe(false);
    await rm(tempDir, { recursive: true, force: true });
  });
});
