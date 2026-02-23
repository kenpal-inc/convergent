import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { Task, Config, SemanticConvergenceAnalysis } from '../src/types';

// --- Mocks (set up BEFORE importing function under test) ---

const mockCallClaude = mock(() =>
  Promise.resolve({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Synthesis done',
    total_cost_usd: 1.5,
  }),
);

const mockRecordCost = mock(() => Promise.resolve());

const mockCreateWorktree = mock(() => Promise.resolve(true));
const mockGetWorktreeChangedFiles = mock(() => Promise.resolve(['file1.ts']));
const mockGetWorktreeDiff = mock(() => Promise.resolve('diff content'));
const mockRemoveWorktree = mock(() => Promise.resolve());

const mockResolveVerificationCommands = mock(() => ['bun test']);
const mockScoreVerification = mock(() =>
  Promise.resolve({
    totalScore: 80,
    maxScore: 100,
    allPassed: false,
    details: [],
  }),
);

mock.module('../src/claude', () => ({
  callClaude: mockCallClaude,
}));

mock.module('../src/budget', () => ({
  recordCost: mockRecordCost,
}));

mock.module('../src/git', () => ({
  createWorktree: mockCreateWorktree,
  removeWorktree: mockRemoveWorktree,
  getWorktreeChangedFiles: mockGetWorktreeChangedFiles,
  getWorktreeDiff: mockGetWorktreeDiff,
}));

mock.module('../src/verify', () => ({
  resolveVerificationCommands: mockResolveVerificationCommands,
  scoreVerification: mockScoreVerification,
}));

mock.module('../src/learnings', () => ({
  buildLearningsContext: mock(() => Promise.resolve('')),
}));

// Import after mocks are registered
import { synthesizeImplementation } from '../src/tournament';

// --- Test Fixtures ---

const baseTask: Task = {
  id: 'test-001',
  title: 'Test Task',
  description: 'Implement a test feature',
  depends_on: [],
  context_files: ['src/feature.ts'],
  acceptance_criteria: ['Criterion 1', 'Criterion 2'],
  estimated_complexity: 'standard',
};

const baseCandidates = [
  { id: 1, strategy: 'thorough', diff: 'diff --git a/file1.ts\n+added line 1' },
  { id: 2, strategy: 'minimal', diff: 'diff --git a/file1.ts\n+added line 2' },
];

const baseSemanticAnalysis: SemanticConvergenceAnalysis = {
  convergent_patterns: [
    { pattern: 'Added null check for input', confidence: 0.95, competitors: [1, 2] },
    { pattern: 'Used async/await pattern', confidence: 0.85, competitors: [1, 2] },
  ],
  divergent_approaches: ['Error handling style differs'],
  synthesis_viable: true,
  rationale: 'High convergence detected',
};

const baseConfig = {
  models: { executor: 'claude-sonnet-4-20250514', planner: 'claude-sonnet-4-20250514' },
  budget: {
    execution_max_usd: 5.0,
    total_max_usd: 50.0,
    per_task_max_usd: 10.0,
    plan_max_usd: 2.0,
    review_max_usd: 2.0,
    per_review_persona_max_usd: 0.8,
  },
  parallelism: { tournament_timeout_seconds: 600 },
  tournament: { competitors: 3, strategies: ['pragmatist', 'thorough', 'deconstructor'] },
  verification: { auto_detect: true, commands: [], max_retries: 2 },
  review: { enabled: true, max_retries: 2, personas: ['correctness'] },
  git: { auto_commit: true, create_branch: false, create_pr: false },
} as Config;

const projectRoot = '/tmp/test-project';
const tournamentDir = '/tmp/convergent-tournament-test-001-123';
const taskDir = '/tmp/test-project/.convergent/tasks/test-001';
const baseCommit = 'abc123';

describe('synthesizeImplementation', () => {
  beforeEach(() => {
    mockCreateWorktree.mockReset();
    mockCreateWorktree.mockResolvedValue(true);
    mockGetWorktreeChangedFiles.mockReset();
    mockGetWorktreeChangedFiles.mockResolvedValue(['file1.ts']);
    mockGetWorktreeDiff.mockReset();
    mockGetWorktreeDiff.mockResolvedValue('diff content');
    mockCallClaude.mockReset();
    mockCallClaude.mockResolvedValue({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Synthesis done',
      total_cost_usd: 1.5,
    });
    mockRecordCost.mockReset();
    mockRecordCost.mockResolvedValue(undefined);
    mockResolveVerificationCommands.mockReset();
    mockResolveVerificationCommands.mockReturnValue(['bun test']);
    mockScoreVerification.mockReset();
    mockScoreVerification.mockResolvedValue({
      totalScore: 80,
      maxScore: 100,
      allPassed: false,
      details: [],
    });
  });

  it('returns success=true with correct fields on happy path', async () => {
    const result = await synthesizeImplementation(
      baseTask, baseCandidates, baseSemanticAnalysis,
      baseConfig, projectRoot, tournamentDir, taskDir, baseCommit,
    );
    expect(result.success).toBe(true);
    expect(result.diff).toBe('diff content');
    expect(result.verification_score).toBe(80);
    expect(result.worktreePath).toContain('synthesis');
    expect(result.cost).toBe(1.5);
    expect(result.patterns_incorporated).toEqual([
      'Added null check for input',
      'Used async/await pattern',
    ]);
  });

  it('creates worktree at tournamentDir/synthesis with correct baseCommit', async () => {
    await synthesizeImplementation(
      baseTask, baseCandidates, baseSemanticAnalysis,
      baseConfig, projectRoot, tournamentDir, taskDir, baseCommit,
    );
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      projectRoot,
      expect.stringContaining('synthesis'),
      baseCommit,
    );
  });

  it('returns success=false when createWorktree fails, without worktreePath', async () => {
    mockCreateWorktree.mockResolvedValue(false);
    const result = await synthesizeImplementation(
      baseTask, baseCandidates, baseSemanticAnalysis,
      baseConfig, projectRoot, tournamentDir, taskDir, baseCommit,
    );
    expect(result.success).toBe(false);
    expect(result.rationale).toContain('worktree');
    expect(result.worktreePath).toBeUndefined();
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  it('returns success=false with worktreePath when Claude returns is_error', async () => {
    mockCallClaude.mockResolvedValue({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'API error occurred',
      total_cost_usd: 0.5,
    });
    const result = await synthesizeImplementation(
      baseTask, baseCandidates, baseSemanticAnalysis,
      baseConfig, projectRoot, tournamentDir, taskDir, baseCommit,
    );
    expect(result.success).toBe(false);
    expect(result.worktreePath).toBeDefined();
    expect(result.cost).toBe(0.5);
    expect(result.rationale).toContain('failed');
  });

  it('returns success=false when no files are changed', async () => {
    mockGetWorktreeChangedFiles.mockResolvedValue([]);
    const result = await synthesizeImplementation(
      baseTask, baseCandidates, baseSemanticAnalysis,
      baseConfig, projectRoot, tournamentDir, taskDir, baseCommit,
    );
    expect(result.success).toBe(false);
    expect(result.rationale).toContain('no file changes');
    expect(result.worktreePath).toBeDefined();
  });

  it('returns success=false when verification score is 0 and verify commands exist', async () => {
    mockScoreVerification.mockResolvedValue({
      totalScore: 0, maxScore: 100, allPassed: false, details: [],
    });
    const result = await synthesizeImplementation(
      baseTask, baseCandidates, baseSemanticAnalysis,
      baseConfig, projectRoot, tournamentDir, taskDir, baseCommit,
    );
    expect(result.success).toBe(false);
    expect(result.verification_score).toBe(0);
  });

  it('returns success=true when verification score is 0 but no verify commands', async () => {
    mockResolveVerificationCommands.mockReturnValue([]);
    mockScoreVerification.mockResolvedValue({
      totalScore: 0, maxScore: 0, allPassed: true, details: [],
    });
    const result = await synthesizeImplementation(
      baseTask, baseCandidates, baseSemanticAnalysis,
      baseConfig, projectRoot, tournamentDir, taskDir, baseCommit,
    );
    expect(result.success).toBe(true);
  });

  it('never throws — catches exceptions and returns success=false', async () => {
    mockCallClaude.mockRejectedValue(new Error('Network timeout'));
    const result = await synthesizeImplementation(
      baseTask, baseCandidates, baseSemanticAnalysis,
      baseConfig, projectRoot, tournamentDir, taskDir, baseCommit,
    );
    expect(result.success).toBe(false);
    expect(result.rationale).toContain('Network timeout');
    expect(result.worktreePath).toBeDefined(); // worktree was created before error
  });

  it('calls callClaude with executor model, execution_max_usd, tools, dangerouslySkipPermissions, and synthesis worktree cwd', async () => {
    await synthesizeImplementation(
      baseTask, baseCandidates, baseSemanticAnalysis,
      baseConfig, projectRoot, tournamentDir, taskDir, baseCommit,
    );
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    const callArgs = mockCallClaude.mock.calls[0][0] as any;
    expect(callArgs.model).toBe(baseConfig.models.executor);
    expect(callArgs.maxBudgetUsd).toBe(baseConfig.budget.execution_max_usd);
    expect(callArgs.tools).toBe('Read,Write,Edit,Glob,Grep,Bash');
    expect(callArgs.dangerouslySkipPermissions).toBe(true);
    expect(callArgs.cwd).toContain('synthesis');
  });

  it('records cost via recordCost with correct label even on AI failure', async () => {
    mockCallClaude.mockResolvedValue({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'error',
      total_cost_usd: 0.3,
    });
    await synthesizeImplementation(
      baseTask, baseCandidates, baseSemanticAnalysis,
      baseConfig, projectRoot, tournamentDir, taskDir, baseCommit,
    );
    expect(mockRecordCost).toHaveBeenCalledWith('task-test-001-synthesis', 0.3);
  });

  it('prompt includes all candidate diffs, convergent patterns, and task description', async () => {
    await synthesizeImplementation(
      baseTask, baseCandidates, baseSemanticAnalysis,
      baseConfig, projectRoot, tournamentDir, taskDir, baseCommit,
    );
    const prompt = (mockCallClaude.mock.calls[0][0] as any).prompt as string;
    expect(prompt).toContain('Test Task');
    expect(prompt).toContain('Criterion 1');
    expect(prompt).toContain('thorough');
    expect(prompt).toContain('minimal');
    expect(prompt).toContain('Added null check for input');
    expect(prompt).toContain('Used async/await pattern');
    expect(prompt).toContain('Error handling style differs');
    expect(prompt).toContain('added line 1');
    expect(prompt).toContain('added line 2');
  });

  it('truncates long candidate diffs to MAX_DIFF_LENGTH', async () => {
    const longDiff = 'x'.repeat(50_000);
    const longCandidates = [
      { id: 1, strategy: 'thorough', diff: longDiff },
    ];
    await synthesizeImplementation(
      baseTask, longCandidates, baseSemanticAnalysis,
      baseConfig, projectRoot, tournamentDir, taskDir, baseCommit,
    );
    const prompt = (mockCallClaude.mock.calls[0][0] as any).prompt as string;
    expect(prompt).toContain('[truncated]');
    // Prompt should be significantly less than 50K for the diff portion
    expect(prompt.length).toBeLessThan(50_000);
  });
});
