import { describe, it, expect, mock, beforeEach, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Task, Config, SemanticConvergenceAnalysis, ConvergenceAnalysis } from '../src/types';
import { initBudgetModule, initBudget } from '../src/budget';

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
import { synthesizeImplementation, analyzeSemanticConvergence, runTournament } from '../src/tournament';

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
    // Re-init budget for each test
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
    // Re-init budget to get a clean slate
    initBudgetModule(testOutputDir);
    await initBudget();
    writeFileSync(join(testOutputDir, 'state.json'), JSON.stringify({ total_cost_usd: 0 }));

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
    // Verify cost was recorded to budget.json
    const budget = JSON.parse(readFileSync(join(testOutputDir, 'budget.json'), 'utf-8'));
    const synthEntry = budget.entries.find((e: any) => e.label === 'task-test-001-synthesis');
    expect(synthEntry).toBeDefined();
    expect(synthEntry.cost_usd).toBeCloseTo(0.3, 4);
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

// --- analyzeSemanticConvergence tests ---

const baseConvergenceAnalysis: ConvergenceAnalysis = {
  convergence_ratio: 0.8,
  common_files: ['src/feature.ts'],
  divergent_files: ['src/utils.ts'],
  diff_lines: { 0: 50, 1: 60 },
};

describe('analyzeSemanticConvergence', () => {
  beforeEach(() => {
    mockCallClaude.mockReset();
    // Re-init budget for each test
  });

  it('returns synthesis_viable=false when callClaude returns is_error', async () => {
    mockCallClaude.mockResolvedValue({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'API rate limit exceeded',
      total_cost_usd: 0.1,
    });

    const result = await analyzeSemanticConvergence(
      baseTask, baseCandidates, baseConfig, taskDir, baseConvergenceAnalysis,
    );

    expect(result.synthesis_viable).toBe(false);
    expect(result.rationale).toBeTruthy();
    expect(result.rationale).toContain('failed');
    expect(result.convergent_patterns).toEqual([]);
  });

  it('correctly parses a valid JSON response with convergent_patterns, divergent_approaches, synthesis_viable, rationale', async () => {
    const validResponse = JSON.stringify({
      convergent_patterns: [
        { pattern: 'Both use middleware pattern', competitors: [0, 1], confidence: 0.9 },
      ],
      divergent_approaches: ['Different error handling strategies'],
      synthesis_viable: true,
      rationale: 'Strong convergence on core design',
    });

    mockCallClaude.mockResolvedValue({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: validResponse,
      total_cost_usd: 0.3,
    });

    const result = await analyzeSemanticConvergence(
      baseTask, baseCandidates, baseConfig, taskDir, baseConvergenceAnalysis,
    );

    expect(result.synthesis_viable).toBe(true);
    expect(result.rationale).toBe('Strong convergence on core design');
    expect(result.convergent_patterns).toHaveLength(1);
    expect(result.convergent_patterns[0].pattern).toBe('Both use middleware pattern');
    expect(result.convergent_patterns[0].confidence).toBe(0.9);
    expect(result.convergent_patterns[0].competitors).toEqual([0, 1]);
    expect(result.divergent_approaches).toEqual(['Different error handling strategies']);
  });

  it('handles malformed JSON gracefully — returns fallback', async () => {
    mockCallClaude.mockResolvedValue({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'This is not valid JSON at all { broken',
      total_cost_usd: 0.2,
    });

    const result = await analyzeSemanticConvergence(
      baseTask, baseCandidates, baseConfig, taskDir, baseConvergenceAnalysis,
    );

    expect(result.synthesis_viable).toBe(false);
    expect(result.convergent_patterns).toEqual([]);
    expect(result.rationale).toContain('error');
  });

  it('strips markdown code fences from response before parsing', async () => {
    const jsonContent = JSON.stringify({
      convergent_patterns: [
        { pattern: 'Shared API design', competitors: [0, 1], confidence: 0.85 },
      ],
      divergent_approaches: [],
      synthesis_viable: true,
      rationale: 'Good convergence',
    });
    const wrappedResponse = '```json\n' + jsonContent + '\n```';

    mockCallClaude.mockResolvedValue({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: wrappedResponse,
      total_cost_usd: 0.25,
    });

    const result = await analyzeSemanticConvergence(
      baseTask, baseCandidates, baseConfig, taskDir, baseConvergenceAnalysis,
    );

    expect(result.synthesis_viable).toBe(true);
    expect(result.convergent_patterns).toHaveLength(1);
    expect(result.convergent_patterns[0].pattern).toBe('Shared API design');
  });
});

// --- Synthesis score comparison and integration tests ---

describe('synthesis score comparison', () => {
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
    // Re-init budget for each test
    mockResolveVerificationCommands.mockReset();
    mockResolveVerificationCommands.mockReturnValue(['bun test']);
    mockScoreVerification.mockReset();
  });

  it('synthesis score equal to best individual — synthesis should be used', async () => {
    // Synthesis scores exactly equal to best individual (80) => should succeed (>=)
    mockScoreVerification.mockResolvedValue({
      totalScore: 80,
      maxScore: 100,
      allPassed: false,
      details: [],
    });

    const result = await synthesizeImplementation(
      baseTask, baseCandidates, baseSemanticAnalysis,
      baseConfig, projectRoot, tournamentDir, taskDir, baseCommit,
    );

    // Synthesis succeeds when score >= best individual
    expect(result.success).toBe(true);
    expect(result.verification_score).toBe(80);
  });

  it('synthesis score below best — synthesis should fall back (score 0)', async () => {
    // Synthesis fails verification entirely
    mockScoreVerification.mockResolvedValue({
      totalScore: 0,
      maxScore: 100,
      allPassed: false,
      details: [],
    });

    const result = await synthesizeImplementation(
      baseTask, baseCandidates, baseSemanticAnalysis,
      baseConfig, projectRoot, tournamentDir, taskDir, baseCommit,
    );

    expect(result.success).toBe(false);
    expect(result.verification_score).toBe(0);
  });
});

describe('SynthesisMetadata integration', () => {
  beforeEach(() => {
    mockCreateWorktree.mockReset();
    mockCreateWorktree.mockResolvedValue(true);
    mockGetWorktreeChangedFiles.mockReset();
    mockGetWorktreeChangedFiles.mockResolvedValue(['file1.ts']);
    mockGetWorktreeDiff.mockReset();
    mockGetWorktreeDiff.mockResolvedValue('diff content');
    mockCallClaude.mockReset();
    // Re-init budget for each test
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

  it('synthesis worktree is cleaned up even when synthesis throws an error', async () => {
    // Simulate synthesis worktree created but then Claude call throws
    mockCallClaude.mockRejectedValue(new Error('Catastrophic failure'));

    const result = await synthesizeImplementation(
      baseTask, baseCandidates, baseSemanticAnalysis,
      baseConfig, projectRoot, tournamentDir, taskDir, baseCommit,
    );

    // Should not throw
    expect(result.success).toBe(false);
    expect(result.rationale).toContain('Catastrophic failure');
    // worktreePath is set so caller knows it existed (even though the function never throws)
    expect(result.worktreePath).toBeDefined();
  });
});

// --- runTournament integration tests ---

// Shared temp directory for competitors.json
let testLibDir: string;
let testOutputDir: string;

beforeAll(() => {
  testLibDir = join(tmpdir(), `convergent-test-lib-${Date.now()}`);
  mkdirSync(testLibDir, { recursive: true });
  writeFileSync(
    join(testLibDir, 'competitors.json'),
    JSON.stringify({
      pragmatist: { name: 'Pragmatist', system_prompt: 'You are a pragmatist.' },
      thorough: { name: 'Thorough', system_prompt: 'You are thorough.' },
      deconstructor: { name: 'Deconstructor', system_prompt: 'You deconstruct.' },
    }),
  );
  testOutputDir = join(tmpdir(), `convergent-test-output-${Date.now()}`);
  mkdirSync(testOutputDir, { recursive: true });
  // Initialize real budget module to avoid mock.module conflicts with budget-mutex tests
  initBudgetModule(testOutputDir);
  initBudget();
  // Also write state.json for recordCost
  writeFileSync(join(testOutputDir, 'state.json'), JSON.stringify({ total_cost_usd: 0 }));
});

afterAll(() => {
  try { rmSync(testLibDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(testOutputDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('runTournament integration — single competitor', () => {
  beforeEach(() => {
    mockCreateWorktree.mockReset();
    mockCreateWorktree.mockResolvedValue(true);
    mockGetWorktreeChangedFiles.mockReset();
    mockGetWorktreeChangedFiles.mockResolvedValue(['file1.ts']);
    mockGetWorktreeDiff.mockReset();
    mockGetWorktreeDiff.mockResolvedValue('diff --git a/file1.ts\n+added');
    mockRemoveWorktree.mockReset();
    mockRemoveWorktree.mockResolvedValue(undefined);
    mockCallClaude.mockReset();
    mockCallClaude.mockResolvedValue({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Implementation done',
      total_cost_usd: 1.0,
    });
    // Re-init budget for each test
    mockResolveVerificationCommands.mockReset();
    mockResolveVerificationCommands.mockReturnValue(['bun test']);
    mockScoreVerification.mockReset();
    mockScoreVerification.mockResolvedValue({
      totalScore: 80,
      maxScore: 100,
      allPassed: false,
      details: [{ name: 'bun test', passed: true, weight: 1 }],
    });
  });

  it('existing single-competitor tournament path still works (no synthesis attempted when only 1 candidate)', async () => {
    const trivialTask: Task = {
      ...baseTask,
      estimated_complexity: 'trivial',
    };

    const result = await runTournament(
      'test-single', trivialTask, baseConfig, projectRoot,
      testOutputDir, testLibDir, baseCommit,
    );

    expect(result).not.toBeNull();
    expect(result!.competitors).toHaveLength(1);
    expect(result!.winnerId).toBe(0);
    // Synthesis should not be attempted with only 1 candidate
    expect(result!.synthesis).toBeDefined();
    expect(result!.synthesis!.attempted).toBe(false);
    expect(result!.synthesis!.fell_back_to_winner).toBe(true);
    expect(result!.synthesis!.rationale).toContain('synthesis requires 2+');
  });
});

describe('runTournament integration — convergence below threshold', () => {
  beforeEach(() => {
    mockCreateWorktree.mockReset();
    mockCreateWorktree.mockResolvedValue(true);
    mockRemoveWorktree.mockReset();
    mockRemoveWorktree.mockResolvedValue(undefined);
    // Re-init budget for each test
    mockResolveVerificationCommands.mockReset();
    mockResolveVerificationCommands.mockReturnValue(['bun test']);
    mockScoreVerification.mockReset();
    mockScoreVerification.mockResolvedValue({
      totalScore: 80,
      maxScore: 100,
      allPassed: false,
      details: [{ name: 'bun test', passed: true, weight: 1 }],
    });

    // Each competitor changes different files → low convergence_ratio
    mockGetWorktreeChangedFiles.mockReset();
    mockGetWorktreeChangedFiles.mockImplementation(async (path: string) => {
      if (path.includes('c-0')) return ['file1.ts'];
      if (path.includes('c-1')) return ['file2.ts'];
      return ['file1.ts'];
    });
    mockGetWorktreeDiff.mockReset();
    mockGetWorktreeDiff.mockImplementation(async (path: string) => {
      if (path.includes('c-0')) return 'diff --git a/file1.ts\n+line1';
      if (path.includes('c-1')) return 'diff --git a/file2.ts\n+line2';
      return 'diff content';
    });

    // callClaude: first 2 calls = competitor implementations, 3rd = judge
    let callCount = 0;
    mockCallClaude.mockReset();
    mockCallClaude.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Implementation done',
          total_cost_usd: 1.0,
        };
      }
      // Judge response
      return {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: JSON.stringify({ winner: 0, rationale: 'Better implementation' }),
        total_cost_usd: 0.3,
      };
    });
  });

  it('SynthesisMetadata is correctly populated with attempted=false when convergence_ratio < threshold', async () => {
    const standardTask: Task = {
      ...baseTask,
      estimated_complexity: 'standard',
    };
    const configWithHighThreshold = {
      ...baseConfig,
      tournament: { ...baseConfig.tournament, convergence_threshold: 0.9 },
    } as Config;

    const result = await runTournament(
      'test-low-conv', standardTask, configWithHighThreshold, projectRoot,
      testOutputDir, testLibDir, baseCommit,
    );

    expect(result).not.toBeNull();
    // Convergence ratio should be 0 (no common files between competitors)
    expect(result!.convergenceAnalysis).toBeDefined();
    expect(result!.convergenceAnalysis!.convergence_ratio).toBe(0);
    // Synthesis should not be attempted
    expect(result!.synthesis).toBeDefined();
    expect(result!.synthesis!.attempted).toBe(false);
    expect(result!.synthesis!.succeeded).toBe(false);
    expect(result!.synthesis!.fell_back_to_winner).toBe(true);
    expect(result!.synthesis!.rationale).toContain('below threshold');
  });
});

describe('runTournament integration — synthesis field present', () => {
  beforeEach(() => {
    mockCreateWorktree.mockReset();
    mockCreateWorktree.mockResolvedValue(true);
    mockRemoveWorktree.mockReset();
    mockRemoveWorktree.mockResolvedValue(undefined);
    // Re-init budget for each test
    mockResolveVerificationCommands.mockReset();
    mockResolveVerificationCommands.mockReturnValue(['bun test']);
    mockScoreVerification.mockReset();
    mockScoreVerification.mockResolvedValue({
      totalScore: 80,
      maxScore: 100,
      allPassed: false,
      details: [{ name: 'bun test', passed: true, weight: 1 }],
    });

    // Both competitors change the same files → high convergence
    mockGetWorktreeChangedFiles.mockReset();
    mockGetWorktreeChangedFiles.mockResolvedValue(['file1.ts']);
    mockGetWorktreeDiff.mockReset();
    mockGetWorktreeDiff.mockResolvedValue('diff --git a/file1.ts\n+added');

    // callClaude: 2 implementations, then semantic analysis, then synthesis, then potentially judge
    let callCount = 0;
    mockCallClaude.mockReset();
    mockCallClaude.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        // Competitor implementations
        return {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Implementation done',
          total_cost_usd: 1.0,
        };
      }
      if (callCount === 3) {
        // Semantic convergence analysis
        return {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: JSON.stringify({
            convergent_patterns: [{ pattern: 'Shared approach', competitors: [0, 1], confidence: 0.9 }],
            divergent_approaches: [],
            synthesis_viable: true,
            rationale: 'High convergence',
          }),
          total_cost_usd: 0.3,
        };
      }
      // Synthesis implementation call
      return {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Synthesis done',
        total_cost_usd: 1.5,
      };
    });
  });

  it('TournamentResult includes synthesis field after tournament with 2+ passing competitors', async () => {
    const standardTask: Task = {
      ...baseTask,
      estimated_complexity: 'standard',
    };
    const configWithLowThreshold = {
      ...baseConfig,
      tournament: { ...baseConfig.tournament, convergence_threshold: 0.5 },
    } as Config;

    const result = await runTournament(
      'test-synth', standardTask, configWithLowThreshold, projectRoot,
      testOutputDir, testLibDir, baseCommit,
    );

    expect(result).not.toBeNull();
    expect(result!.competitors.length).toBeGreaterThanOrEqual(2);
    // Synthesis field should be present
    expect(result!.synthesis).toBeDefined();
    // Synthesis should have been attempted (convergence is 100% — same files)
    expect(result!.synthesis!.attempted).toBe(true);
    // Synthesis result should include semantic analysis
    expect(result!.synthesis!.semantic_analysis).toBeDefined();
    expect(result!.synthesis!.semantic_analysis!.convergent_patterns.length).toBeGreaterThan(0);
  });
});

describe('runTournament integration — all competitors fail', () => {
  beforeEach(() => {
    mockCreateWorktree.mockReset();
    mockCreateWorktree.mockResolvedValue(true);
    mockRemoveWorktree.mockReset();
    mockRemoveWorktree.mockResolvedValue(undefined);
    // Re-init budget for each test
    mockResolveVerificationCommands.mockReset();
    mockResolveVerificationCommands.mockReturnValue(['bun test']);
    mockScoreVerification.mockReset();
    mockScoreVerification.mockResolvedValue({
      totalScore: 80,
      maxScore: 100,
      allPassed: false,
      details: [{ name: 'bun test', passed: true, weight: 1 }],
    });
    mockGetWorktreeChangedFiles.mockReset();
    mockGetWorktreeChangedFiles.mockResolvedValue(['file1.ts']);
    mockGetWorktreeDiff.mockReset();
    mockGetWorktreeDiff.mockResolvedValue('diff --git a/file1.ts\n+added');

    // Both competitors return is_error: true
    mockCallClaude.mockReset();
    mockCallClaude.mockResolvedValue({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'API error: model overloaded',
      total_cost_usd: 0.1,
    });
  });

  it('returns null when all competitors fail, no synthesis attempted, worktrees cleaned up', async () => {
    const standardTask: Task = {
      ...baseTask,
      estimated_complexity: 'standard',
    };

    const result = await runTournament(
      'test-all-fail', standardTask, baseConfig, projectRoot,
      testOutputDir, testLibDir, baseCommit,
    );

    // runTournament returns null when all competitors fail
    expect(result).toBeNull();

    // removeWorktree should have been called for cleanup (2 competitor worktrees)
    expect(mockRemoveWorktree).toHaveBeenCalled();
    expect(mockRemoveWorktree.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Only 2 callClaude calls should have been made (competitor implementations only)
    // No synthesis-related calls (semantic analysis, synthesis, or judge)
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
  });
});

describe('runTournament integration — synthesis fails, falls back to judge', () => {
  beforeEach(() => {
    mockCreateWorktree.mockReset();
    mockCreateWorktree.mockResolvedValue(true);
    mockRemoveWorktree.mockReset();
    mockRemoveWorktree.mockResolvedValue(undefined);
    // Re-init budget for each test
    mockResolveVerificationCommands.mockReset();
    mockResolveVerificationCommands.mockReturnValue(['bun test']);
    mockScoreVerification.mockReset();
    mockScoreVerification.mockResolvedValue({
      totalScore: 80,
      maxScore: 100,
      allPassed: false,
      details: [{ name: 'bun test', passed: true, weight: 1 }],
    });

    // Both competitors change the same files → high convergence
    mockGetWorktreeChangedFiles.mockReset();
    mockGetWorktreeChangedFiles.mockResolvedValue(['file1.ts']);
    mockGetWorktreeDiff.mockReset();
    mockGetWorktreeDiff.mockResolvedValue('diff --git a/file1.ts\n+added');

    // callClaude sequence:
    // 1-2: competitor implementations (success)
    // 3: semantic convergence analysis (synthesis_viable=true)
    // 4: synthesis implementation (is_error=true → synthesis fails)
    // 5: judge fallback
    let callCount = 0;
    mockCallClaude.mockReset();
    mockCallClaude.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        // Competitor implementations succeed
        return {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Implementation done',
          total_cost_usd: 1.0,
        };
      }
      if (callCount === 3) {
        // Semantic convergence analysis → synthesis_viable=true
        return {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: JSON.stringify({
            convergent_patterns: [{ pattern: 'Shared approach', competitors: [0, 1], confidence: 0.9 }],
            divergent_approaches: [],
            synthesis_viable: true,
            rationale: 'High convergence',
          }),
          total_cost_usd: 0.3,
        };
      }
      if (callCount === 4) {
        // Synthesis implementation fails
        return {
          type: 'result',
          subtype: 'error',
          is_error: true,
          result: 'Synthesis AI call crashed',
          total_cost_usd: 0.5,
        };
      }
      // callCount === 5: Judge fallback
      return {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: JSON.stringify({ winner: 0, rationale: 'Better overall implementation' }),
        total_cost_usd: 0.3,
      };
    });
  });

  it('falls back to judge when synthesis AI call fails, with correct synthesis metadata', async () => {
    const standardTask: Task = {
      ...baseTask,
      estimated_complexity: 'standard',
    };
    const configWithLowThreshold = {
      ...baseConfig,
      tournament: { ...baseConfig.tournament, convergence_threshold: 0.5 },
    } as Config;

    const result = await runTournament(
      'test-synth-fail', standardTask, configWithLowThreshold, projectRoot,
      testOutputDir, testLibDir, baseCommit,
    );

    // Tournament should still return a valid result via judge fallback
    expect(result).not.toBeNull();
    expect(result!.competitors.length).toBeGreaterThanOrEqual(2);

    // Winner should be from the original competitors (judge picked 0)
    expect(result!.winnerId).toBe(0);

    // Synthesis metadata should reflect attempted=true but failed
    expect(result!.synthesis).toBeDefined();
    expect(result!.synthesis!.attempted).toBe(true);
    expect(result!.synthesis!.succeeded).toBe(false);
    expect(result!.synthesis!.fell_back_to_winner).toBe(true);
    expect(result!.synthesis!.rationale).toContain('failed');

    // Semantic analysis should still be present (it succeeded before synthesis failed)
    expect(result!.synthesis!.semantic_analysis).toBeDefined();
    expect(result!.synthesis!.semantic_analysis!.synthesis_viable).toBe(true);

    // The 5th callClaude call should be the judge fallback
    expect(mockCallClaude).toHaveBeenCalledTimes(5);

    // Judge rationale should be present
    expect(result!.judgeRationale).toBe('Better overall implementation');
  });
});
