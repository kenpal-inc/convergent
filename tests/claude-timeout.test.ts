import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { callClaude } from '../src/claude';

// Helper to create a mock process
function createMockProc({
  exitCode = 0,
  exitDelayMs = 10,
  stdout = '',
  stderr = '',
  shouldKillHang = false,
}: {
  exitCode?: number;
  exitDelayMs?: number;
  stdout?: string;
  stderr?: string;
  shouldKillHang?: boolean;
} = {}) {
  const stdoutStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(stdout));
      controller.close();
    },
  });

  const stderrStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(stderr));
      controller.close();
    },
  });

  let killed = false;
  const killMock = mock(() => {
    killed = true;
  });

  const exitedPromise = new Promise<number>((resolve) => {
    setTimeout(() => {
      // If shouldKillHang is true, only resolve if killed
      if (shouldKillHang) {
        const checkKilled = () => {
          if (killed) {
            resolve(exitCode);
          } else {
            setTimeout(checkKilled, 10);
          }
        };
        checkKilled();
      } else {
        resolve(exitCode);
      }
    }, exitDelayMs);
  });

  return {
    stdout: stdoutStream,
    stderr: stderrStream,
    exitCode: null as number | null,
    exited: exitedPromise,
    kill: killMock,
    pid: 12345,
  };
}

describe('callClaude timeout detection', () => {
  let originalBunSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalBunSpawn = Bun.spawn;
  });

  test('returns explicit timeout error when process exceeds timeoutMs', async () => {
    // Mock Bun.spawn with a slow process (500ms) and short timeout (100ms)
    const mockProc = createMockProc({
      exitDelayMs: 500,
      exitCode: 0,
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'success',
        total_cost_usd: 0.01,
      }),
      shouldKillHang: true,
    });

    Bun.spawn = mock(() => mockProc) as any;

    const result = await callClaude({
      prompt: 'test prompt',
      systemPrompt: 'test system',
      model: 'claude-3-5-sonnet-20241022',
      maxBudgetUsd: 1,
      timeoutMs: 100,
    });

    expect(result.is_error).toBe(true);
    expect(result.result).toContain('timed out');
    expect(result.result).toContain('100ms');
    expect(result.total_cost_usd).toBe(0);
    expect(mockProc.kill).toHaveBeenCalled();

    Bun.spawn = originalBunSpawn;
  });

  test('completes successfully when process finishes before timeout', async () => {
    // Mock Bun.spawn with fast process (10ms) and long timeout (5000ms)
    const mockProc = createMockProc({
      exitDelayMs: 10,
      exitCode: 0,
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'success response',
        total_cost_usd: 0.02,
      }),
    });

    Bun.spawn = mock(() => mockProc) as any;

    const result = await callClaude({
      prompt: 'test prompt',
      systemPrompt: 'test system',
      model: 'claude-3-5-sonnet-20241022',
      maxBudgetUsd: 1,
      timeoutMs: 5000,
    });

    expect(result.is_error).toBe(false);
    expect(result.result).toBe('success response');
    expect(result.total_cost_usd).toBe(0.02);

    Bun.spawn = originalBunSpawn;
  });

  test('returns non-timeout error when process fails with non-zero exit before timeout', async () => {
    // Mock Bun.spawn with exit code 1, fast exit (10ms), timeout 5000ms
    const mockProc = createMockProc({
      exitDelayMs: 10,
      exitCode: 1,
      stdout: '',
      stderr: 'Error: something went wrong',
    });

    Bun.spawn = mock(() => mockProc) as any;

    const result = await callClaude({
      prompt: 'test prompt',
      systemPrompt: 'test system',
      model: 'claude-3-5-sonnet-20241022',
      maxBudgetUsd: 1,
      timeoutMs: 5000,
    });

    expect(result.is_error).toBe(true);
    expect(result.result).toContain('something went wrong');
    expect(result.result).not.toContain('timed out');

    Bun.spawn = originalBunSpawn;
  });

  test('handles race condition when process exits near timeout boundary', async () => {
    // Mock Bun.spawn with exit at ~100ms, timeout at 100ms
    const mockProc = createMockProc({
      exitDelayMs: 100,
      exitCode: 0,
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'boundary response',
        total_cost_usd: 0.01,
      }),
      shouldKillHang: true,
    });

    Bun.spawn = mock(() => mockProc) as any;

    const result = await callClaude({
      prompt: 'test prompt',
      systemPrompt: 'test system',
      model: 'claude-3-5-sonnet-20241022',
      maxBudgetUsd: 1,
      timeoutMs: 100,
    });

    // Assert no crash/unhandled rejection
    expect(result).toBeDefined();
    // Either timeout or success is acceptable at boundary
    expect(result.is_error).toBeDefined();

    Bun.spawn = originalBunSpawn;
  });

  test('works normally when timeoutMs is not specified', async () => {
    // Mock Bun.spawn with a process that completes normally, no timeoutMs
    const mockProc = createMockProc({
      exitDelayMs: 50,
      exitCode: 0,
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'no timeout response',
        total_cost_usd: 0.03,
      }),
    });

    Bun.spawn = mock(() => mockProc) as any;

    const result = await callClaude({
      prompt: 'test prompt',
      systemPrompt: 'test system',
      model: 'claude-3-5-sonnet-20241022',
      maxBudgetUsd: 1,
      // no timeoutMs specified
    });

    expect(result.is_error).toBe(false);
    expect(result.result).toBe('no timeout response');
    expect(result.total_cost_usd).toBe(0.03);

    Bun.spawn = originalBunSpawn;
  });

  test('returns error for invalid timeoutMs values', async () => {
    // Test with timeoutMs = -1
    const result1 = await callClaude({
      prompt: 'test',
      systemPrompt: 'test',
      model: 'claude-3-5-sonnet-20241022',
      maxBudgetUsd: 1,
      timeoutMs: -1,
    });
    expect(result1.is_error).toBe(true);
    expect(result1.result).toContain('timeoutMs must be a positive');

    // Test with timeoutMs = 0
    const result2 = await callClaude({
      prompt: 'test',
      systemPrompt: 'test',
      model: 'claude-3-5-sonnet-20241022',
      maxBudgetUsd: 1,
      timeoutMs: 0,
    });
    expect(result2.is_error).toBe(true);
    expect(result2.result).toContain('timeoutMs must be a positive');

    // Test with timeoutMs = NaN
    const result3 = await callClaude({
      prompt: 'test',
      systemPrompt: 'test',
      model: 'claude-3-5-sonnet-20241022',
      maxBudgetUsd: 1,
      timeoutMs: NaN,
    });
    expect(result3.is_error).toBe(true);
    expect(result3.result).toContain('timeoutMs must be a positive');

    // Test with timeoutMs = Infinity
    const result4 = await callClaude({
      prompt: 'test',
      systemPrompt: 'test',
      model: 'claude-3-5-sonnet-20241022',
      maxBudgetUsd: 1,
      timeoutMs: Infinity,
    });
    expect(result4.is_error).toBe(true);
    expect(result4.result).toContain('timeoutMs must be a positive');
  });

  test('total_cost_usd is 0 on timeout', async () => {
    // Mock slow process with short timeout
    const mockProc = createMockProc({
      exitDelayMs: 500,
      exitCode: 0,
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'success',
        total_cost_usd: 0.99, // This should be ignored
      }),
      shouldKillHang: true,
    });

    Bun.spawn = mock(() => mockProc) as any;

    const result = await callClaude({
      prompt: 'test prompt',
      systemPrompt: 'test system',
      model: 'claude-3-5-sonnet-20241022',
      maxBudgetUsd: 1,
      timeoutMs: 100,
    });

    expect(result.total_cost_usd).toBe(0);

    Bun.spawn = originalBunSpawn;
  });

  test('timeout error message includes duration value', async () => {
    // Mock with timeoutMs = 3000
    const mockProc = createMockProc({
      exitDelayMs: 5000,
      exitCode: 0,
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'success',
        total_cost_usd: 0.01,
      }),
      shouldKillHang: true,
    });

    Bun.spawn = mock(() => mockProc) as any;

    const result = await callClaude({
      prompt: 'test prompt',
      systemPrompt: 'test system',
      model: 'claude-3-5-sonnet-20241022',
      maxBudgetUsd: 1,
      timeoutMs: 3000,
    });

    expect(result.result).toContain('3000ms');

    Bun.spawn = originalBunSpawn;
  });

  test('proc.kill() is called when timeout fires', async () => {
    // Mock slow process, short timeout
    const mockProc = createMockProc({
      exitDelayMs: 500,
      exitCode: 0,
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'success',
        total_cost_usd: 0.01,
      }),
      shouldKillHang: true,
    });

    Bun.spawn = mock(() => mockProc) as any;

    await callClaude({
      prompt: 'test prompt',
      systemPrompt: 'test system',
      model: 'claude-3-5-sonnet-20241022',
      maxBudgetUsd: 1,
      timeoutMs: 100,
    });

    expect(mockProc.kill).toHaveBeenCalled();

    Bun.spawn = originalBunSpawn;
  });
});
