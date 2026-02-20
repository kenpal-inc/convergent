import { Glob } from "bun";
import { existsSync, statSync, readFileSync } from "fs";
import { resolve, relative } from "path";
import { log } from "./logger";
import { enrichContextFiles } from "./depgraph";
import type { Task } from "./types";

const EXCLUDE_DIRS = ["node_modules", ".next", "dist", ".convergent"];

const MAX_FILES = 80;
const MAX_LINES = 300;
// If total files in context ≤ this threshold, send full content instead of signatures
const FULL_CONTENT_THRESHOLD = 40;

function readFirstLines(filePath: string, maxLines: number): string {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  return lines.slice(0, maxLines).join("\n");
}

/**
 * Extract signature-level information from a source file.
 * Includes: export declarations, type/interface definitions, function/class signatures, and import statements.
 * Returns a condensed view of the file's public API rather than the first N lines.
 */
function extractSignatures(filePath: string): string {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const signaturePatterns = [
    /^\s*export\s+/,                     // export anything
    /^\s*(export\s+)?(type|interface|enum)\s+/,  // type definitions
    /^\s*(export\s+)?(async\s+)?function\s+/,     // function declarations
    /^\s*(export\s+)?(abstract\s+)?class\s+/,     // class declarations
    /^\s*(export\s+)?const\s+\w+\s*[=:]/,         // const declarations
    /^\s*import\s+/,                     // imports (for understanding dependencies)
  ];

  // Multi-line tracking (interface/type bodies are useful for context)
  const extracted: string[] = [];
  let inBlock = false;
  let braceDepth = 0;
  let blockLines: string[] = [];
  const MAX_BLOCK_LINES = 20;

  for (const line of lines) {
    // If we're tracking a block (interface/type body), follow braces
    if (inBlock) {
      blockLines.push(line);
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      if (braceDepth <= 0 || blockLines.length >= MAX_BLOCK_LINES) {
        if (blockLines.length >= MAX_BLOCK_LINES) {
          blockLines.push("  // ... (truncated)");
        }
        extracted.push(...blockLines);
        inBlock = false;
        blockLines = [];
        braceDepth = 0;
      }
      continue;
    }

    // Check if this line matches any signature pattern
    if (signaturePatterns.some(p => p.test(line))) {
      extracted.push(line);
      // Start block tracking for type/interface/class definitions
      if (/\{\s*$/.test(line) && /(type|interface|class|enum)\s+/.test(line)) {
        inBlock = true;
        braceDepth = 1;
        blockLines = [];
      }
    }
  }

  if (extracted.length === 0) {
    // Fallback: return first N lines if no signatures found
    return lines.slice(0, MAX_LINES).join("\n");
  }

  return extracted.join("\n");
}

function shouldExclude(filePath: string): boolean {
  return EXCLUDE_DIRS.some(
    (dir) => filePath.includes(`/${dir}/`) || filePath.includes(`\\${dir}\\`),
  );
}

const SIGNATURE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java"]);

function shouldUseSignatures(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return SIGNATURE_EXTENSIONS.has(ext);
}

export async function buildContext(
  paths: string[],
  projectRoot: string,
): Promise<string> {
  // First pass: collect all file paths to decide on strategy
  const allFiles: { path: string; isExplicit: boolean }[] = [];

  for (const rawPath of paths) {
    const resolvedPath = rawPath.startsWith("/")
      ? rawPath
      : resolve(projectRoot, rawPath);

    if (!existsSync(resolvedPath)) {
      log.warn(`Context path not found: ${rawPath}`);
      continue;
    }

    const stat = statSync(resolvedPath);

    if (stat.isDirectory()) {
      const glob = new Glob(
        "**/*.{ts,tsx,js,jsx,md,json,yml,yaml,py,go,rs,java}",
      );
      for await (const file of glob.scan({
        cwd: resolvedPath,
        absolute: true,
      })) {
        if (!shouldExclude(file)) {
          allFiles.push({ path: file, isExplicit: false });
        }
      }
    } else if (stat.isFile()) {
      allFiles.push({ path: resolvedPath, isExplicit: true });
    }
  }

  // Sort directory files (explicit files keep their order at front)
  const explicitFiles = allFiles.filter(f => f.isExplicit);
  const dirFiles = allFiles.filter(f => !f.isExplicit);
  dirFiles.sort((a, b) => a.path.localeCompare(b.path));
  const sortedFiles = [...explicitFiles, ...dirFiles].slice(0, MAX_FILES);

  // Strategy: if few enough files, send full content; otherwise use signatures for dir files
  const useFullContent = sortedFiles.length <= FULL_CONTENT_THRESHOLD;
  if (useFullContent) {
    log.debug(`Context: ${sortedFiles.length} files (≤${FULL_CONTENT_THRESHOLD}) — sending full content`);
  } else {
    log.debug(`Context: ${sortedFiles.length} files (>${FULL_CONTENT_THRESHOLD}) — using signatures for source files`);
  }

  let context = "";
  for (const { path: filePath, isExplicit } of sortedFiles) {
    const relPath = relative(projectRoot, filePath);

    if (isExplicit || useFullContent) {
      // Explicit files and small-project files: full content (up to MAX_LINES)
      context += `\n--- File: ${relPath} ---\n`;
      context += readFirstLines(filePath, MAX_LINES);
    } else if (shouldUseSignatures(filePath)) {
      // Large project, directory source files: signatures only
      context += `\n--- File: ${relPath} (signatures) ---\n`;
      context += extractSignatures(filePath);
    } else {
      // Large project, non-source files: first N lines
      context += `\n--- File: ${relPath} ---\n`;
      context += readFirstLines(filePath, MAX_LINES);
    }
    context += "\n";
  }

  log.debug(`Built context from ${sortedFiles.length} files`);
  return context;
}

export function buildTaskContext(
  task: Task,
  projectRoot: string,
  options?: { traceImports?: boolean },
): string {
  const rawFiles = task.context_files ?? [];
  let filePaths: string[];

  if (options?.traceImports && rawFiles.length > 0) {
    // Enrich with import graph dependencies
    const enriched = enrichContextFiles(rawFiles, projectRoot);
    filePaths = enriched.map((abs) => relative(projectRoot, abs));
    if (filePaths.length > rawFiles.length) {
      log.debug(`Import tracing: ${rawFiles.length} → ${filePaths.length} files`);
    }
  } else {
    filePaths = rawFiles;
  }

  let context = "";
  for (const filePath of filePaths) {
    const resolved = filePath.startsWith("/")
      ? filePath
      : resolve(projectRoot, filePath);

    if (existsSync(resolved) && statSync(resolved).isFile()) {
      context += `\n--- ${filePath} ---\n`;
      context += readFileSync(resolved, "utf-8");
      context += "\n";
    }
  }

  return context;
}
