import { mkdirSync } from "fs";
import { spawn } from "child_process";
import { join, relative } from "path";
import { readFile, writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { log } from "./logger";
import { callClaude } from "./claude";
import type { Config } from "./types";

async function run(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    date.getFullYear().toString() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

export async function isGitRepository(projectRoot: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['git', 'rev-parse', '--git-dir'], {
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

function sanitizeGitError(error: string, projectRoot: string): string {
  // Remove absolute paths from error messages
  return error.replace(new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '.');
}

export async function createBranch(
  projectRoot: string,
  timestamp?: Date
): Promise<{ success: boolean; branchName: string; error?: string }> {
  const ts = formatTimestamp(timestamp);
  const branchName = `convergent/run-${ts}`;

  // Check if this is a git repository
  if (!(await isGitRepository(projectRoot))) {
    return { success: false, branchName, error: 'Not a git repository' };
  }

  try {
    const proc = Bun.spawn(['git', 'checkout', '-b', branchName], {
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    if (exitCode === 0) {
      return { success: true, branchName };
    }

    // Parse specific error cases
    const sanitizedError = sanitizeGitError(stderr.trim(), projectRoot);
    if (stderr.includes('already exists')) {
      return { success: false, branchName, error: `Branch '${branchName}' already exists` };
    }
    return { success: false, branchName, error: sanitizedError || 'Failed to create branch' };
  } catch (err) {
    return {
      success: false,
      branchName,
      error: err instanceof Error ? sanitizeGitError(err.message, projectRoot) : 'Unknown error creating branch',
    };
  }
}

/**
 * Detect if a commit message is actually a Claude CLI error rather than a real message.
 * Prevents errors like "Prompt is too long" from being committed as-is.
 */
function looksLikeClaudeError(msg: string): boolean {
  const lower = msg.toLowerCase();
  const errorPatterns = [
    "prompt is too long",
    "rate limit",
    "overloaded",
    "context window",
    "max tokens",
    "request timeout",
    "exceeded",
    "error:",
    "failed to",
    "process exited",
    "empty response",
  ];
  return errorPatterns.some(p => lower.includes(p));
}

export async function gitCommitTask(
  taskId: string,
  taskTitle: string,
  config: Config,
  projectRoot: string,
  outputDir: string,
): Promise<boolean> {
  if (!config.git.auto_commit) {
    log.info("Auto-commit disabled, skipping");
    return true;
  }

  // Check for changes
  const diffResult = await run(["diff", "--name-only"], projectRoot);
  const diffCached = await run(["diff", "--cached", "--name-only"], projectRoot);
  const untracked = await run(["ls-files", "--others", "--exclude-standard"], projectRoot);

  if (!diffResult.stdout.trim() && !diffCached.stdout.trim() && !untracked.stdout.trim()) {
    log.warn(`No changes to commit for task ${taskId}`);
    return true;
  }

  // Generate commit message
  const diffStat = await run(["diff", "--stat"], projectRoot);

  const response = await callClaude({
    prompt: `Generate a concise git commit message (1-2 lines) for the following changes. The task was: ${taskTitle}

Changed files:
${diffStat.stdout}

New files:
${untracked.stdout}

Write only the commit message, nothing else. Do not use conventional commit prefixes like feat: or fix: unless it clearly fits. Write a message that helps someone understand the change when reading git log.`,
    systemPrompt: "You are a helpful assistant that generates git commit messages. Output only the commit message text, nothing else.",
    model: config.models.planner,
    maxBudgetUsd: 0.10,
    tools: "",
  });

  let commitMsg = response.result?.trim();
  if (!commitMsg || response.is_error || looksLikeClaudeError(commitMsg)) {
    commitMsg = `implement: ${taskTitle}`;
  }

  // Stage and commit
  const addResult = await run(["add", "-A"], projectRoot);
  if (addResult.exitCode !== 0) {
    log.error(`Git add failed (exit ${addResult.exitCode})`);
    log.error(`stdout: ${addResult.stdout}`);
    log.error(`stderr: ${addResult.stderr}`);
    return false;
  }

  const commitResult = await run(["commit", "-m", commitMsg], projectRoot);

  const taskDir = `${outputDir}/logs/task-${taskId}`;
  mkdirSync(taskDir, { recursive: true });

  if (commitResult.exitCode !== 0) {
    log.error(`Git commit failed (exit ${commitResult.exitCode})`);
    log.error(`stdout: ${commitResult.stdout}`);
    log.error(`stderr: ${commitResult.stderr}`);
    // Write both stdout and stderr to git.log
    await Bun.write(
      `${taskDir}/git.log`,
      `COMMIT FAILED (exit ${commitResult.exitCode})\n--- stdout ---\n${commitResult.stdout}\n--- stderr ---\n${commitResult.stderr}\n`
    );
    return false;
  }

  await Bun.write(`${taskDir}/git.log`, `${commitResult.stdout}\n${commitResult.stderr}`);
  log.ok(`Committed: ${commitMsg.split("\n")[0]}`);
  return true;
}

export async function gitRevertChanges(projectRoot: string, baseCommit?: string): Promise<void> {
  if (baseCommit) {
    // Reset to base commit — undoes both uncommitted changes AND intermediate commits
    // made by review fix executors that may have shifted HEAD
    log.warn(`Reverting all changes back to base commit ${baseCommit.slice(0, 8)}`);
    await run(["reset", "--hard", baseCommit], projectRoot);
    await run(["clean", "-fd", "-e", ".convergent"], projectRoot);
  } else {
    log.warn("Reverting uncommitted changes");
    await run(["checkout", "--", "."], projectRoot);
    await run(["clean", "-fd", "-e", ".convergent"], projectRoot);
  }
}

// --- Worktree operations for tournament ---

export async function createWorktree(
  projectRoot: string,
  worktreePath: string,
  baseCommit: string,
): Promise<boolean> {
  const result = await run(
    ["worktree", "add", worktreePath, baseCommit, "--detach"],
    projectRoot,
  );
  if (result.exitCode !== 0) {
    log.error(`Failed to create worktree at ${worktreePath}: ${result.stderr}`);
    return false;
  }
  return true;
}

export async function removeWorktree(
  projectRoot: string,
  worktreePath: string,
): Promise<void> {
  await run(["worktree", "remove", worktreePath, "--force"], projectRoot);
}

export async function getWorktreeDiff(worktreePath: string): Promise<string> {
  const result = await run(["diff", "HEAD", "--", ".", ":!.convergent"], worktreePath);
  return result.stdout;
}

export async function getWorktreeChangedFiles(worktreePath: string): Promise<string[]> {
  const tracked = await run(["diff", "--name-only", "HEAD"], worktreePath);
  const untracked = await run(["ls-files", "--others", "--exclude-standard"], worktreePath);
  return [
    ...tracked.stdout.trim().split("\n"),
    ...untracked.stdout.trim().split("\n"),
  ].filter(f => f && !f.startsWith(".convergent/"));
}

export async function getHeadCommit(projectRoot: string): Promise<string> {
  const result = await run(["rev-parse", "HEAD"], projectRoot);
  return result.stdout.trim();
}

export async function getGitLog(
  projectRoot: string,
  sinceTimestamp?: string,
  maxCommits: number = 50
): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const args = [
      'log',
      `--max-count=${maxCommits}`,
      '--format=%h %ai %s',
      '--no-merges',
    ];
    if (sinceTimestamp) {
      args.push(`--since=${sinceTimestamp}`);
    }

    const proc = spawn('git', args, {
      cwd: projectRoot,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout.trim() });
      } else {
        resolve({ success: false, output: '', error: stderr.trim() || `git log exited with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, output: '', error: err.message });
    });
  });
}

export async function isGhCliAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['which', 'gh'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

export async function hasGitHubRemote(projectRoot: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['git', 'remote', '-v'], {
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return false;
    return output.includes('github.com');
  } catch {
    return false;
  }
}

interface PrBodyInput {
  goal: string;
  tasks: Array<{ id: string; title: string }>;
  tasksStatus: Record<string, string>;
  outputDir: string;
  projectRoot: string;
  branchName?: string;
}

function buildPrBody(input: PrBodyInput): string {
  const { goal, tasks, tasksStatus, outputDir, projectRoot, branchName } = input;
  const relOutputDir = relative(projectRoot, outputDir);
  const lines: string[] = [];

  lines.push(`## Goal`);
  lines.push('');
  lines.push(goal);
  lines.push('');

  // Completed tasks
  const completedTasks = tasks.filter(t => tasksStatus[t.id] === 'completed');
  const failedTasks = tasks.filter(t => tasksStatus[t.id] === 'failed');

  if (completedTasks.length > 0) {
    lines.push(`## Completed Tasks (${completedTasks.length})`);
    lines.push('');
    for (const task of completedTasks) {
      const reportPath = `${relOutputDir}/reports/${task.id}.md`;
      lines.push(`- ✅ **[${task.id}]** ${task.title} ([report](${reportPath}))`);
    }
    lines.push('');
  }

  if (failedTasks.length > 0) {
    lines.push(`## Failed Tasks (${failedTasks.length})`);
    lines.push('');
    for (const task of failedTasks) {
      lines.push(`- ❌ **[${task.id}]** ${task.title}`);
    }
    lines.push('');
  }

  // Summary link
  lines.push(`## Reports`);
  lines.push('');
  lines.push(`- [Summary Report](${relOutputDir}/reports/summary.md)`);
  lines.push('');

  // Stats
  lines.push(`---`);
  lines.push(`*Auto-generated by convergent | ${completedTasks.length} completed, ${failedTasks.length} failed out of ${tasks.length} total tasks*`);
  if (branchName) {
    lines.push(`*Branch: \`${branchName}\`*`);
  }

  return lines.join('\n');
}

export async function createPullRequest(
  config: Config,
  projectRoot: string,
  outputDir: string,
  goal: string,
): Promise<{ success: boolean; prUrl?: string; error?: string }> {
  // 1. Check config
  if (!config.git?.create_pr) {
    return { success: false, error: 'PR creation is disabled in config (git.create_pr is false)' };
  }

  // 2. Check gh CLI availability
  if (!(await isGhCliAvailable())) {
    return { success: false, error: 'gh CLI is not installed. Install it from https://cli.github.com/ to enable PR creation.' };
  }

  // 3. Check GitHub remote
  if (!(await hasGitHubRemote(projectRoot))) {
    return { success: false, error: 'No GitHub remote found. PR creation requires a GitHub remote.' };
  }

  // 4. Load task data
  let tasks: Array<{ id: string; title: string }> = [];
  let tasksStatus: Record<string, string> = {};
  let branchName: string | undefined;

  try {
    const tasksJson = JSON.parse(await readFile(join(outputDir, 'tasks.json'), 'utf-8'));
    tasks = (tasksJson.tasks || []).map((t: any) => ({ id: t.id, title: t.title }));
  } catch (e) {
    return { success: false, error: 'Failed to read tasks.json' };
  }

  try {
    const stateJson = JSON.parse(await readFile(join(outputDir, 'state.json'), 'utf-8'));
    tasksStatus = Object.fromEntries(
      Object.entries(stateJson.tasks_status || {}).map(([id, status]: [string, any]) => [id, status.status])
    );
    branchName = stateJson.branch_name;
  } catch (e) {
    return { success: false, error: 'Failed to read state.json' };
  }

  // 5. Check at least one task completed
  const completedCount = Object.values(tasksStatus).filter(s => s === 'completed').length;
  if (completedCount === 0) {
    return { success: false, error: 'No tasks completed successfully. Skipping PR creation.' };
  }

  // 6. Build PR title (truncate to 72 chars)
  let prTitle = goal.replace(/[\r\n]+/g, ' ').trim();
  if (prTitle.length > 72) {
    prTitle = prTitle.substring(0, 69) + '...';
  }

  // 7. Build PR body
  const prBody = buildPrBody({ goal, tasks, tasksStatus, outputDir, projectRoot, branchName });

  // 8. Write body to temp file
  const bodyFilePath = join(tmpdir(), `convergent-pr-body-${Date.now()}.md`);
  try {
    await writeFile(bodyFilePath, prBody, 'utf-8');

    // 9. Execute gh pr create
    const proc = Bun.spawn(
      ['gh', 'pr', 'create', '--title', prTitle, '--body-file', bodyFilePath],
      {
        cwd: projectRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    // 10. Apply timeout
    const timeout = setTimeout(() => {
      proc.kill();
    }, 30_000);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode !== 0) {
      const errorMsg = stderr.trim() || stdout.trim();
      // Provide guidance for common errors
      if (errorMsg.includes('auth') || errorMsg.includes('login')) {
        return { success: false, error: `GitHub authentication required. Run 'gh auth login' first. Details: ${sanitizeGitError(errorMsg, projectRoot)}` };
      }
      return { success: false, error: sanitizeGitError(errorMsg, projectRoot) };
    }

    // 11. Parse PR URL from output
    const prUrl = stdout.trim().split('\n').find(line => line.startsWith('https://'));
    return { success: true, prUrl: prUrl || stdout.trim() };
  } finally {
    // Clean up temp file
    try { await unlink(bodyFilePath); } catch { /* ignore */ }
  }
}
