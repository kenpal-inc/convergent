import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Set up mocks BEFORE importing the function under test
const mockCallClaude = mock(() => Promise.resolve({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '',
  total_cost_usd: 0.05,
}));

const mockRecordCost = mock(() => Promise.resolve());

mock.module('../src/claude', () => ({
  callClaude: mockCallClaude,
}));

mock.module('../src/budget', () => ({
  recordCost: mockRecordCost,
}));

// Import after mocks are registered
import { analyzeSemanticConvergence } from '../src/tournament';

// --- Shared fixtures ---

const mockTask = {
  id: 'test-001',
  title: 'Add auth middleware',
  description: 'Implement JWT auth',
  depends_on: [],
  context_files: ['src/auth.ts'],
  acceptance_criteria: ['tokens validated', 'errors handled'],
  estimated_complexity: 'standard' as const,
};

const mockCandidates = [
  { id: 0, strategy: 'thorough', diff: 'diff --git a/auth.ts ...+jwt.verify()' },
  { id: 1, strategy: 'minimal', diff: 'diff --git a/auth.ts ...+checkToken()' },
];

const mockConfig = {
  models: { planner: 'claude-sonnet-4-20250514', executor: 'claude-sonnet-4-20250514' },
  budget: { total_max_usd: 50, per_task_max_usd: 10, plan_max_usd: 2, execution_max_usd: 5, review_max_usd: 2, per_review_persona_max_usd: 0.8 },
  parallelism: { tournament_timeout_seconds: 600 },
  tournament: { competitors: 3, strategies: ['pragmatist', 'thorough', 'deconstructor'] },
  verification: { auto_detect: true, commands: [], max_retries: 2 },
  review: { enabled: true, max_retries: 2, personas: ['correctness'] },
  git: { auto_commit: true, create_branch: false, create_pr: false },
} as any;

const mockTaskDir = '/tmp/test-taskdir';

const mockConvergence = {
  convergence_ratio: 0.75,
  common_files: ['src/auth.ts'],
  divergent_files: ['src/utils.ts'],
  diff_lines: { 0: 50, 1: 30 },
};

const validAnalysis = {
  convergent_patterns: [{ pattern: 'Both use JWT verification', competitors: [0, 1], confidence: 0.9 }],
  divergent_approaches: ['Error handling: throw vs return null'],
  synthesis_viable: true,
  rationale: 'High convergence on core auth pattern',
};

const validAIResponse = JSON.stringify(validAnalysis);

describe('analyzeSemanticConvergence', () => {
  beforeEach(() => {
    mockCallClaude.mockReset();
    mockRecordCost.mockReset();
    // Default: successful response with valid JSON
    mockCallClaude.mockImplementation(() => Promise.resolve({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: validAIResponse,
      total_cost_usd: 0.12,
    }));
    mockRecordCost.mockImplementation(() => Promise.resolve());
  });

  it('returns parsed SemanticConvergenceAnalysis on valid AI response', async () => {
    const result = await analyzeSemanticConvergence(
      mockTask, mockCandidates, mockConfig, mockTaskDir, mockConvergence,
    );

    expect(result.synthesis_viable).toBe(true);
    expect(result.rationale).toBe('High convergence on core auth pattern');
    expect(result.convergent_patterns).toHaveLength(1);
    expect(result.convergent_patterns[0].pattern).toBe('Both use JWT verification');
    expect(result.convergent_patterns[0].competitors).toEqual([0, 1]);
    expect(result.convergent_patterns[0].confidence).toBe(0.9);
    expect(result.divergent_approaches).toEqual(['Error handling: throw vs return null']);
  });

  it('returns synthesis_viable=false when callClaude returns is_error=true', async () => {
    mockCallClaude.mockImplementation(() => Promise.resolve({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'API call failed',
      total_cost_usd: 0.03,
    }));

    const result = await analyzeSemanticConvergence(
      mockTask, mockCandidates, mockConfig, mockTaskDir, mockConvergence,
    );

    expect(result.synthesis_viable).toBe(false);
    expect(result.convergent_patterns).toEqual([]);
    expect(result.divergent_approaches).toEqual([]);
    // Cost should still be recorded even on is_error
    expect(mockRecordCost).toHaveBeenCalledWith('task-test-001-convergence-analysis', 0.03);
  });

  it('returns synthesis_viable=false when AI returns empty result', async () => {
    mockCallClaude.mockImplementation(() => Promise.resolve({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      total_cost_usd: 0.02,
    }));

    const result = await analyzeSemanticConvergence(
      mockTask, mockCandidates, mockConfig, mockTaskDir, mockConvergence,
    );

    expect(result.synthesis_viable).toBe(false);
    expect(result.convergent_patterns).toEqual([]);
    expect(result.divergent_approaches).toEqual([]);
  });

  it('strips markdown code fences before parsing', async () => {
    mockCallClaude.mockImplementation(() => Promise.resolve({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '```json\n' + validAIResponse + '\n```',
      total_cost_usd: 0.10,
    }));

    const result = await analyzeSemanticConvergence(
      mockTask, mockCandidates, mockConfig, mockTaskDir, mockConvergence,
    );

    expect(result.synthesis_viable).toBe(true);
    expect(result.convergent_patterns).toHaveLength(1);
    expect(result.convergent_patterns[0].pattern).toBe('Both use JWT verification');
  });

  it('returns synthesis_viable=false on malformed JSON', async () => {
    mockCallClaude.mockImplementation(() => Promise.resolve({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'not json at all, just some text',
      total_cost_usd: 0.08,
    }));

    const result = await analyzeSemanticConvergence(
      mockTask, mockCandidates, mockConfig, mockTaskDir, mockConvergence,
    );

    // Should not throw, should return fallback
    expect(result.synthesis_viable).toBe(false);
    expect(result.convergent_patterns).toEqual([]);
    expect(result.divergent_approaches).toEqual([]);
    expect(result.rationale).toContain('error');
  });

  it('records cost with correct label', async () => {
    await analyzeSemanticConvergence(
      mockTask, mockCandidates, mockConfig, mockTaskDir, mockConvergence,
    );

    expect(mockRecordCost).toHaveBeenCalledTimes(1);
    expect(mockRecordCost).toHaveBeenCalledWith('task-test-001-convergence-analysis', 0.12);
  });

  it('passes correct logFile path to callClaude', async () => {
    await analyzeSemanticConvergence(
      mockTask, mockCandidates, mockConfig, mockTaskDir, mockConvergence,
    );

    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    const callArgs = mockCallClaude.mock.calls[0][0] as any;
    expect(callArgs.logFile).toBe('/tmp/test-taskdir/convergence-analysis.log');
  });

  it('prompt includes candidate diffs, task info, and convergence_ratio', async () => {
    await analyzeSemanticConvergence(
      mockTask, mockCandidates, mockConfig, mockTaskDir, mockConvergence,
    );

    const callArgs = mockCallClaude.mock.calls[0][0] as any;
    const prompt = callArgs.prompt as string;
    expect(prompt).toContain('thorough');
    expect(prompt).toContain('minimal');
    expect(prompt).toContain('Add auth middleware');
    expect(prompt).toContain('Implement JWT auth');
    expect(prompt).toContain('0.75');
  });

  it('prompt requests semantic/directional analysis', async () => {
    await analyzeSemanticConvergence(
      mockTask, mockCandidates, mockConfig, mockTaskDir, mockConvergence,
    );

    const callArgs = mockCallClaude.mock.calls[0][0] as any;
    const prompt = callArgs.prompt as string;
    // Should contain semantic/architectural analysis language
    expect(prompt).toMatch(/convergent design decisions|architectural choices/i);
  });

  it('uses planner model and $0.50 budget', async () => {
    await analyzeSemanticConvergence(
      mockTask, mockCandidates, mockConfig, mockTaskDir, mockConvergence,
    );

    const callArgs = mockCallClaude.mock.calls[0][0] as any;
    expect(callArgs.model).toBe('claude-sonnet-4-20250514');
    expect(callArgs.maxBudgetUsd).toBe(0.50);
  });

  it('applies defaults for missing optional fields', async () => {
    mockCallClaude.mockImplementation(() => Promise.resolve({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify({ synthesis_viable: true, rationale: 'ok' }),
      total_cost_usd: 0.05,
    }));

    const result = await analyzeSemanticConvergence(
      mockTask, mockCandidates, mockConfig, mockTaskDir, mockConvergence,
    );

    // Missing convergent_patterns → defaults to []
    expect(result.convergent_patterns).toEqual([]);
    // Missing divergent_approaches → defaults to []
    expect(result.divergent_approaches).toEqual([]);
    // synthesis_viable and rationale should be parsed
    expect(result.synthesis_viable).toBe(true);
    expect(result.rationale).toBe('ok');
  });

  it('returns synthesis_viable=false when callClaude throws exception', async () => {
    mockCallClaude.mockImplementation(() => {
      throw new Error('Network connection refused');
    });

    const result = await analyzeSemanticConvergence(
      mockTask, mockCandidates, mockConfig, mockTaskDir, mockConvergence,
    );

    expect(result.synthesis_viable).toBe(false);
    expect(result.convergent_patterns).toEqual([]);
    expect(result.divergent_approaches).toEqual([]);
    expect(result.rationale).toContain('Network connection refused');
    // recordCost should NOT be called since no response exists
    expect(mockRecordCost).not.toHaveBeenCalled();
  });

  it('prompt includes common_files and divergent_files from ConvergenceAnalysis', async () => {
    await analyzeSemanticConvergence(
      mockTask, mockCandidates, mockConfig, mockTaskDir, mockConvergence,
    );

    const callArgs = mockCallClaude.mock.calls[0][0] as any;
    const prompt = callArgs.prompt as string;
    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('src/utils.ts');
  });
});
