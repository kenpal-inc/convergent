import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { callClaude } from './claude';
import { getGitLog } from './git';
import type { Config, TournamentMetrics } from './types';

const MAX_DIFF_CHARS = 10_000;
const REPORT_BUDGET_USD = 0.10;

/**
 * Execute git command using Bun.spawn
 */
async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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

/**
 * Get git diff statistics for the last commit
 */
async function getGitDiffStat(projectRoot: string): Promise<string> {
  try {
    const result = await runGit(['diff', 'HEAD~1', '--stat'], projectRoot);
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
    // Fallback for first commit: diff against empty tree
    const emptyTree = '4b825dc642cb6eb9a060e54bf899d15f6778aa03';
    const fallback = await runGit(['diff', '--stat', emptyTree, 'HEAD'], projectRoot);
    return fallback.exitCode === 0 ? fallback.stdout.trim() : 'No diff stats available';
  } catch {
    return 'No diff stats available';
  }
}

/**
 * Get full git diff for the last commit (truncated if too large)
 */
async function getGitDiff(projectRoot: string): Promise<string> {
  try {
    const result = await runGit(['diff', 'HEAD~1'], projectRoot);
    if (result.exitCode === 0 && result.stdout.trim()) {
      const diff = result.stdout;
      if (diff.length > MAX_DIFF_CHARS) {
        return diff.slice(0, MAX_DIFF_CHARS) + '\n... [truncated, ' + diff.length + ' total chars]';
      }
      return diff;
    }
    // Fallback for first commit
    const emptyTree = '4b825dc642cb6eb9a060e54bf899d15f6778aa03';
    const fallback = await runGit(['diff', emptyTree, 'HEAD'], projectRoot);
    if (fallback.exitCode === 0) {
      const diff = fallback.stdout;
      if (diff.length > MAX_DIFF_CHARS) {
        return diff.slice(0, MAX_DIFF_CHARS) + '\n... [truncated, ' + diff.length + ' total chars]';
      }
      return diff;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Generate AI summary of changes using Claude
 */
export async function generateDiffSummary(
  diffContent: string,
  taskTitle: string,
  config: Config
): Promise<string> {
  if (!diffContent.trim()) {
    return 'No changes detected for this task.';
  }
  try {
    const prompt = `You are summarizing code changes for a development task. The task was: "${taskTitle}"

Here is the git diff:

${diffContent}

Provide a concise 2-3 sentence summary of what was changed and why. Focus on the key modifications.`;
    const result = await callClaude({
      prompt,
      systemPrompt: 'You are a helpful assistant that summarizes code changes. Be concise and focus on the what and why.',
      model: config.models.planner,
      maxBudgetUsd: REPORT_BUDGET_USD,
      tools: '',
    });
    if (result && result.result && result.result.trim()) {
      return result.result.trim();
    }
    return 'Summary generation failed. Please review the diff stats above.';
  } catch (error) {
    console.warn('Failed to generate AI summary:', error);
    return 'Summary generation failed. Please review the diff stats above.';
  }
}

/**
 * Format synthesis metadata into a markdown section.
 * Accepts either a TournamentResult (from tournament.json) with a `synthesis` field,
 * or a tournament_metrics object with synthesis_* fields.
 * Returns empty string if no synthesis data is present.
 */
export function formatSynthesisSection(tournamentData: any): string {
  if (!tournamentData) return '';

  // Handle TournamentResult (from tournament.json) — has `synthesis` field
  const synthesis = tournamentData.synthesis;
  // Handle TournamentMetrics — has `synthesis_attempted` field
  const metrics = tournamentData as Partial<TournamentMetrics> | undefined;

  // Determine if we have any synthesis data to display
  const hasFullSynthesis = synthesis && typeof synthesis === 'object';
  const hasMetricsSynthesis = metrics?.synthesis_attempted !== undefined;

  if (!hasFullSynthesis && !hasMetricsSynthesis) return '';

  const lines: string[] = [];
  lines.push('## Convergence Synthesis');
  lines.push('');

  if (hasFullSynthesis) {
    // Full synthesis data from tournament.json
    const attempted = synthesis.attempted ?? false;
    const succeeded = synthesis.succeeded ?? false;
    const fellBack = synthesis.fell_back_to_winner ?? false;

    if (!attempted) {
      lines.push(`**Outcome**: Not attempted`);
    } else if (succeeded) {
      lines.push(`**Outcome**: ✓ Synthesis succeeded`);
    } else if (fellBack) {
      lines.push(`**Outcome**: ✗ Fell back to single winner`);
    } else {
      lines.push(`**Outcome**: Attempted`);
    }

    if (synthesis.rationale) {
      lines.push(`**Rationale**: ${synthesis.rationale}`);
    }
    lines.push('');

    // Convergent patterns from semantic_analysis
    const patterns = synthesis.semantic_analysis?.convergent_patterns;
    if (Array.isArray(patterns) && patterns.length > 0) {
      lines.push('### Convergent Patterns');
      lines.push('');
      for (const p of patterns) {
        const confidence = typeof p.confidence === 'number' ? ` (confidence: ${p.confidence.toFixed(2)})` : '';
        const desc = typeof p === 'string' ? p : (p.pattern ?? String(p));
        lines.push(`- ${desc}${confidence}`);
      }
      lines.push('');
    }
  } else if (hasMetricsSynthesis) {
    // Metrics-only synthesis data
    const attempted = metrics!.synthesis_attempted ?? false;
    const succeeded = metrics!.synthesis_succeeded ?? false;
    const fellBack = metrics!.synthesis_fell_back ?? false;

    if (!attempted) {
      lines.push(`**Outcome**: Not attempted`);
    } else if (succeeded) {
      lines.push(`**Outcome**: ✓ Synthesis succeeded`);
    } else if (fellBack) {
      lines.push(`**Outcome**: ✗ Fell back to single winner`);
    } else {
      lines.push(`**Outcome**: Attempted`);
    }

    if (metrics!.synthesis_rationale) {
      lines.push(`**Rationale**: ${metrics!.synthesis_rationale}`);
    }
    lines.push('');

    // Convergent patterns from metrics
    const patterns = metrics!.synthesis_convergent_patterns;
    if (Array.isArray(patterns) && patterns.length > 0) {
      lines.push('### Convergent Patterns');
      lines.push('');
      for (const p of patterns) {
        lines.push(`- ${p}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Format report as markdown
 */
export function formatReportMarkdown(
  taskId: string,
  taskTitle: string,
  diffStat: string,
  summary: string,
  timestamp: string,
  extraSections?: string,
): string {
  let md = `# Task Report: ${taskId}\n\n` +
    `**Task:** ${taskTitle}\n` +
    `**Generated:** ${timestamp}\n\n` +
    `## Changes Summary\n\n${summary}\n\n`;

  if (extraSections) {
    md += extraSections + '\n';
  }

  md += `## Diff Statistics\n\n\`\`\`\n${diffStat}\n\`\`\`\n`;
  return md;
}

/**
 * Generate a task completion report after git commit
 */
export async function generateTaskReport(
  taskId: string,
  taskTitle: string,
  config: Config,
  projectRoot: string,
  outputDir: string
): Promise<boolean> {
  try {
    // Ensure reports directory exists
    const reportsDir = join(outputDir, 'reports');
    mkdirSync(reportsDir, { recursive: true });

    // Get git diff information
    const diffStat = await getGitDiffStat(projectRoot);
    const diffContent = await getGitDiff(projectRoot);

    // Generate AI summary
    const summary = await generateDiffSummary(diffContent, taskTitle, config);

    // Try to read tournament.json for synthesis metadata
    let extraSections = '';
    try {
      const tournamentPath = join(outputDir, 'logs', `task-${taskId}`, 'tournament.json');
      if (existsSync(tournamentPath)) {
        const tournamentData = JSON.parse(readFileSync(tournamentPath, 'utf-8'));
        extraSections = formatSynthesisSection(tournamentData);
      }
    } catch {
      // Non-fatal: skip synthesis section if tournament.json can't be read
    }

    // Format and write report
    const timestamp = new Date().toISOString();
    const markdown = formatReportMarkdown(taskId, taskTitle, diffStat, summary, timestamp, extraSections || undefined);
    const reportPath = join(reportsDir, `${taskId}.md`);
    writeFileSync(reportPath, markdown, 'utf-8');

    console.log(`Report generated: ${reportPath}`);
    return true;
  } catch (error) {
    console.warn(`Failed to generate report for task ${taskId}:`, error);
    return false;
  }
}

function escapeTableCell(text: string): string {
  return text
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '');
}

function isValidTaskId(taskId: string): boolean {
  return /^task-\d{3,}$/.test(taskId);
}

export async function generateSummaryReport(
  config: Config,
  projectRoot: string,
  outputDir: string
): Promise<boolean> {
  try {
    // 1. Read required data files
    const stateFilePath = join(outputDir, 'state.json');
    const tasksFilePath = join(outputDir, 'tasks.json');
    const budgetFilePath = join(outputDir, 'budget.json');

    if (!existsSync(stateFilePath) || !existsSync(tasksFilePath)) {
      console.error('[SummaryReport] Required files (state.json or tasks.json) not found');
      return false;
    }

    const state = JSON.parse(readFileSync(stateFilePath, 'utf-8'));
    const tasks = JSON.parse(readFileSync(tasksFilePath, 'utf-8'));

    let totalCost = 0;
    if (existsSync(budgetFilePath)) {
      const budget = JSON.parse(readFileSync(budgetFilePath, 'utf-8'));
      totalCost = budget.total_usd ?? budget.totalCost ?? 0;
    }

    // 2. Build task list from state and tasks data
    const taskStatuses: Record<string, string> = state.tasks_status ?? state.taskStatus ?? {};
    const taskList: Array<{ id: string; title: string; status: string }> = [];

    // tasks may be an array or object; normalize
    const tasksArray = Array.isArray(tasks) ? tasks : (tasks.tasks ?? []);

    for (const task of tasksArray) {
      const id = task.id ?? task.task_id;
      const title = task.title ?? task.description ?? id;
      const statusObj = taskStatuses[id];
      const status = (typeof statusObj === 'object' ? statusObj.status : statusObj) ?? task.status ?? 'pending';
      taskList.push({ id, title, status });
    }

    // 3. Compute summary statistics
    const statusCounts: Record<string, number> = {};
    for (const t of taskList) {
      statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
    }

    // 4. Determine stop reason
    const stopReason = state.stopped_reason ?? state.stoppedReason ?? 'unknown';
    const startedAt = state.started_at ?? state.startedAt ?? '';
    const lastUpdated = state.last_updated ?? state.lastUpdated ?? new Date().toISOString();
    const iterations = state.iterations ?? state.iteration ?? 'N/A';

    // 5. Ensure reports directory exists
    const reportsDir = join(outputDir, 'reports');
    mkdirSync(reportsDir, { recursive: true });

    // 6. Build markdown
    const lines: string[] = [];
    lines.push('# Execution Summary Report');
    lines.push('');
    lines.push('## Overview');
    lines.push('');
    lines.push(`- **Started**: ${startedAt || 'N/A'}`);
    lines.push(`- **Completed**: ${lastUpdated}`);
    lines.push(`- **Stop Reason**: ${stopReason}`);
    lines.push(`- **Total Iterations**: ${iterations}`);
    lines.push(`- **Total Cost**: $${totalCost.toFixed(2)}`);
    lines.push('');

    // Status summary
    lines.push('## Task Status Summary');
    lines.push('');
    for (const [status, count] of Object.entries(statusCounts)) {
      lines.push(`- **${status}**: ${count}`);
    }
    lines.push('');

    // Task table
    lines.push('## Task Details');
    lines.push('');
    lines.push('| Task ID | Title | Status | Report |');
    lines.push('|---------|-------|--------|--------|');

    for (const task of taskList) {
      const safeTitle = escapeTableCell(task.title);
      let reportLink = '-';
      if (isValidTaskId(task.id)) {
        const reportFileName = `${task.id}.md`;
        const reportFilePath = join(reportsDir, reportFileName);
        if (existsSync(reportFilePath)) {
          reportLink = `[${reportFileName}](./${reportFileName})`;
        }
      }
      lines.push(`| ${task.id} | ${safeTitle} | ${task.status} | ${reportLink} |`);
    }
    lines.push('');

    // 6b. Tournament metrics
    const tasksWithMetrics = taskList
      .map(t => {
        const statusObj = taskStatuses[t.id];
        const metrics = typeof statusObj === 'object' ? (statusObj as any).tournament_metrics : undefined;
        return { id: t.id, metrics };
      })
      .filter(t => t.metrics);

    if (tasksWithMetrics.length > 0) {
      lines.push('## Tournament Results');
      lines.push('');
      lines.push('| Task | Competitors | Succeeded | Winner | Score | Convergence | Synthesis | Diff Lines |');
      lines.push('|------|-------------|-----------|--------|-------|-------------|-----------|------------|');

      for (const { id, metrics: m } of tasksWithMetrics) {
        const conv = m.convergence_ratio !== undefined ? `${(m.convergence_ratio * 100).toFixed(0)}%` : '-';
        const diffLines = m.diff_lines_winner !== undefined ? String(m.diff_lines_winner) : '-';
        const synth = m.synthesis_attempted ? (m.synthesis_succeeded ? '✓ used' : '✗ fell back') : '-';
        lines.push(`| ${id} | ${m.competitors_count} | ${m.implementations_succeeded} | ${m.winner_strategy} | ${m.winner_score} | ${conv} | ${synth} | ${diffLines} |`);
      }

      const avgScore = tasksWithMetrics.reduce((s, t) => s + t.metrics.winner_score, 0) / tasksWithMetrics.length;
      const withConvergence = tasksWithMetrics.filter(t => t.metrics.convergence_ratio !== undefined);
      const avgConvergence = withConvergence.length > 0
        ? withConvergence.reduce((s, t) => s + t.metrics.convergence_ratio, 0) / withConvergence.length
        : undefined;

      lines.push('');
      let summary = `**Summary**: ${tasksWithMetrics.length} tournaments. Average winner score: ${avgScore.toFixed(0)}.`;
      if (avgConvergence !== undefined) {
        summary += ` Average convergence: ${(avgConvergence * 100).toFixed(0)}%.`;
      }

      // Add synthesis stats to the summary line
      const synthAttempted = tasksWithMetrics.filter(t => t.metrics.synthesis_attempted === true);
      if (synthAttempted.length > 0) {
        const synthSucceeded = synthAttempted.filter(t => t.metrics.synthesis_succeeded === true);
        summary += ` ${synthAttempted.length} synthesis attempts, ${synthSucceeded.length} succeeded.`;
      }

      lines.push(summary);
      lines.push('');

      // Synthesis Details subsection
      const tasksWithSynthesis = tasksWithMetrics.filter(t => t.metrics.synthesis_attempted === true);
      if (tasksWithSynthesis.length > 0) {
        lines.push('### Convergence Synthesis Details');
        lines.push('');
        for (const { id, metrics: m } of tasksWithSynthesis) {
          const outcome = m.synthesis_succeeded ? '✓ Synthesis succeeded' : (m.synthesis_fell_back ? '✗ Fell back to single winner' : 'Attempted');
          lines.push(`**${id}**: ${outcome}`);
          if (m.synthesis_rationale) {
            lines.push(`- Rationale: ${m.synthesis_rationale}`);
          }
          const patterns = m.synthesis_convergent_patterns;
          if (Array.isArray(patterns) && patterns.length > 0) {
            lines.push('- Convergent patterns:');
            for (const p of patterns) {
              lines.push(`  - ${p}`);
            }
          }
          lines.push('');
        }
      }
    }

    // 7. Git history (conditional)
    if (config.git?.auto_commit || config.git?.autoCommit) {
      lines.push('## Git Commit History');
      lines.push('');
      const gitResult = await getGitLog(projectRoot, startedAt || undefined);
      if (gitResult.success && gitResult.output) {
        lines.push('```');
        lines.push(gitResult.output);
        lines.push('```');
      } else if (gitResult.success && !gitResult.output) {
        lines.push('_No commits found for this execution session._');
      } else {
        lines.push(`_Git log unavailable: ${gitResult.error ?? 'unknown error'}_`);
      }
      lines.push('');
    }

    // 8. Footer
    lines.push('---');
    lines.push(`_Generated at ${new Date().toISOString()}_`);
    lines.push('');

    // 9. Write file
    const summaryPath = join(reportsDir, 'summary.md');
    writeFileSync(summaryPath, lines.join('\n'), 'utf-8');
    console.log(`[SummaryReport] Summary report generated: ${summaryPath}`);
    return true;
  } catch (error) {
    console.error('[SummaryReport] Failed to generate summary report:', error);
    return false;
  }
}
