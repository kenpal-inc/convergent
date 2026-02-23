import { mkdirSync } from "fs";
import { dirname } from "path";
import { log } from "./logger";
import type { ClaudeCallOptions, ClaudeResponse } from "./types";

const TIMEOUT_SENTINEL = Symbol('timeout');

const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 3_000;

function isTransientError(response: ClaudeResponse): boolean {
  if (!response.is_error) return false;
  const msg = (response.result ?? "").toLowerCase();

  // API-level transient errors
  if (
    msg.includes("rate limit") ||
    msg.includes("overloaded") ||
    msg.includes("429") ||
    msg.includes("529") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("connection") ||
    msg.includes("timed out") ||
    msg.includes("request timeout") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up")
  ) return true;

  // Timeout with $0 cost = API never responded (not a genuinely slow task)
  if (response.total_cost_usd === 0 && msg.includes("exceeded") && msg.includes("limit")) {
    return true;
  }

  return false;
}

export async function callClaude(
  options: ClaudeCallOptions,
): Promise<ClaudeResponse> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await callClaudeOnce(options);

    if (attempt < MAX_RETRIES && isTransientError(response)) {
      // Use longer backoff for timeout errors (API was completely unresponsive)
      const isTimeout = (response.result ?? "").toLowerCase().includes("exceeded");
      const baseMs = isTimeout ? 15_000 : INITIAL_BACKOFF_MS;
      const backoffMs = baseMs * Math.pow(2, attempt);
      log.warn(`Transient error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${response.result?.slice(0, 120)}`);
      log.warn(`Retrying in ${(backoffMs / 1000).toFixed(0)}s...`);
      await Bun.sleep(backoffMs);
      continue;
    }

    return response;
  }

  // Unreachable, but satisfies TypeScript
  return { type: "result", subtype: "error", is_error: true, result: "Max retries exceeded", total_cost_usd: 0 };
}

async function callClaudeOnce(
  options: ClaudeCallOptions,
): Promise<ClaudeResponse> {
  let timedOut = false;

  // Validate timeoutMs if provided
  if (options.timeoutMs !== undefined && (typeof options.timeoutMs !== 'number' || options.timeoutMs <= 0 || !Number.isFinite(options.timeoutMs))) {
    return {
      type: "result",
      subtype: "error",
      is_error: true,
      result: 'Error: timeoutMs must be a positive finite number',
      total_cost_usd: 0,
    };
  }

  const args = ["claude", "--print", "--output-format", "json", "--no-session-persistence"];

  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.maxBudgetUsd) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }
  if (options.systemPrompt) {
    args.push("--system-prompt", options.systemPrompt);
  }
  if (options.jsonSchema) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }
  if (options.tools !== undefined) {
    args.push("--tools", options.tools);
  }
  // In --print (headless) mode, tool use requires permission bypass.
  // Auto-enable when tools are specified and non-empty to prevent hangs.
  if (options.dangerouslySkipPermissions || (options.tools && options.tools.length > 0)) {
    args.push("--dangerously-skip-permissions");
  }

  log.debug(`Calling claude with model=${options.model}`);

  // Strip Claude Code session vars to prevent "nested session" detection
  // when convergent is run from within a Claude Code session.
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE"
    ),
  );

  // Pass prompt as in-memory buffer to avoid file system race conditions
  // when multiple processes are spawned concurrently.
  const stdinBuffer = Buffer.from(options.prompt, "utf-8");
  log.debug(`Spawning claude: stdin=${stdinBuffer.length} bytes, args=${args.length} items`);

  const proc = Bun.spawn(args, {
    stdin: stdinBuffer,
    stdout: "pipe",
    stderr: "pipe",
    env: cleanEnv,
    cwd: options.cwd,
  });
  log.debug(`Spawned claude pid=${proc.pid}`);

  // Create timeout promise if timeoutMs is specified
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    if (options.timeoutMs !== undefined) {
      const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          proc.kill();
          resolve(TIMEOUT_SENTINEL);
        }, options.timeoutMs);
      });

      // Race between process exit and timeout
      await Promise.race([proc.exited, timeoutPromise]);
    } else {
      // No timeout specified, just wait for process to exit
      await proc.exited;
    }
  } finally {
    // Always clear the timeout to prevent memory leaks
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    // Check for timeout first, before other error handling
    if (timedOut) {
      const timeoutMsg = `Claude process exceeded ${options.timeoutMs}ms limit (killed)`;

      // Write timeout info to log file if specified
      if (options.logFile) {
        const logDir = dirname(options.logFile);
        mkdirSync(logDir, { recursive: true });
        const logContent = `TIMEOUT after ${options.timeoutMs}ms\nPartial stdout: ${stdout}\nStderr: ${stderr}\n`;
        await Bun.write(options.logFile, logContent);
      }

      return {
        type: "result",
        subtype: "error",
        is_error: true,
        result: timeoutMsg,
        total_cost_usd: 0,
      };
    }

    // Write detailed log if logFile is specified
    if (options.logFile) {
      const logDir = dirname(options.logFile);
      mkdirSync(logDir, { recursive: true });
      const logContent = [
        `=== PROMPT (stdin) ===`,
        options.prompt,
        ``,
        `=== ARGS ===`,
        args.join(" "),
        ``,
        `=== STDOUT ===`,
        stdout,
        ``,
        `=== STDERR ===`,
        stderr,
      ].join("\n");
      await Bun.write(options.logFile, logContent);
    }

    const exitCode = await proc.exited;

    if (exitCode !== 0 && !stdout) {
      log.error(`claude exited with code ${exitCode}`);
      if (stderr) log.debug(`stderr: ${stderr.slice(0, 500)}`);
      return {
        type: "result",
        subtype: "error",
        is_error: true,
        result: stderr || `Process exited with code ${exitCode}`,
        total_cost_usd: 0,
      };
    }

    // Parse JSON response
    try {
      return JSON.parse(stdout) as ClaudeResponse;
    } catch {
      log.error("Failed to parse claude JSON response");
      log.debug(`Raw stdout (first 500 chars): ${stdout.slice(0, 500)}`);
      return {
        type: "result",
        subtype: "error",
        is_error: true,
        result: stdout || "Empty response",
        total_cost_usd: 0,
      };
    }
  } catch (err) {
    if (timedOut) {
      return {
        type: "result",
        subtype: "error",
        is_error: true,
        result: `Claude process exceeded ${options.timeoutMs}ms limit (killed)`,
        total_cost_usd: 0,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Claude call failed: ${msg}`);
    return {
      type: "result",
      subtype: "error",
      is_error: true,
      result: msg,
      total_cost_usd: 0,
    };
  }
}

export function getStructuredOutput<T>(response: ClaudeResponse): T | null {
  if (response.structured_output != null) {
    return response.structured_output as T;
  }
  return null;
}
