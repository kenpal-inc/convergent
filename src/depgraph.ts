/**
 * Dependency graph tracer — given entry files, walk import/require statements
 * to discover related files up to a configurable depth. This enriches Phase A
 * context so personas see not just the explicitly listed files but also their
 * direct and transitive dependencies.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { resolve, dirname, extname } from "path";
import { Glob } from "bun";
import { log } from "./logger";

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const MAX_DEPTH = 3;
const MAX_RESOLVED_FILES = 80;

/**
 * Regex patterns for import/require in TS/JS files.
 * Captures the module specifier (relative paths only).
 */
const IMPORT_PATTERNS = [
  // import ... from "..."  or  import "..."
  /(?:import\s+(?:[\s\S]*?\s+from\s+)?["'])(\.[^"']+)["']/g,
  // require("...")
  /require\(["'](\.[^"']+)["']\)/g,
  // dynamic import("...")
  /import\(["'](\.[^"']+)["']\)/g,
];

/**
 * Resolve a relative import specifier to an actual file path.
 * Handles: exact path, .ts/.tsx/.js/.jsx extensions, /index.ts patterns.
 */
function resolveImport(specifier: string, fromFile: string): string | null {
  const dir = dirname(fromFile);
  const base = resolve(dir, specifier);

  // Exact match
  if (existsSync(base) && statSync(base).isFile()) return base;

  // Try adding extensions
  for (const ext of TS_EXTENSIONS) {
    const withExt = base + ext;
    if (existsSync(withExt) && statSync(withExt).isFile()) return withExt;
  }

  // Try /index.{ext}
  for (const ext of TS_EXTENSIONS) {
    const indexPath = resolve(base, `index${ext}`);
    if (existsSync(indexPath) && statSync(indexPath).isFile()) return indexPath;
  }

  return null;
}

/**
 * Extract relative import specifiers from a TypeScript/JavaScript file.
 */
function extractImports(filePath: string): string[] {
  const ext = extname(filePath);
  if (!TS_EXTENSIONS.includes(ext)) return [];

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const specifiers: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/**
 * Given a set of entry files, trace their import graph up to `maxDepth` levels.
 * Returns an ordered set of discovered file paths (entry files first, then deps).
 */
export function traceImportGraph(
  entryFiles: string[],
  projectRoot: string,
  maxDepth: number = MAX_DEPTH,
): string[] {
  const visited = new Set<string>();
  const result: string[] = [];

  // BFS with depth tracking
  interface QueueItem { file: string; depth: number }
  const queue: QueueItem[] = [];

  for (const entry of entryFiles) {
    const abs = entry.startsWith("/") ? entry : resolve(projectRoot, entry);
    if (existsSync(abs) && statSync(abs).isFile() && !visited.has(abs)) {
      visited.add(abs);
      result.push(abs);
      queue.push({ file: abs, depth: 0 });
    }
  }

  while (queue.length > 0 && result.length < MAX_RESOLVED_FILES) {
    const { file, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;

    const imports = extractImports(file);
    for (const spec of imports) {
      const resolved = resolveImport(spec, file);
      if (resolved && !visited.has(resolved)) {
        // Skip node_modules, .convergent, etc.
        if (resolved.includes("/node_modules/") || resolved.includes("/.convergent/")) continue;
        visited.add(resolved);
        result.push(resolved);
        queue.push({ file: resolved, depth: depth + 1 });
      }
    }
  }

  if (result.length >= MAX_RESOLVED_FILES) {
    log.debug(`Import graph truncated at ${MAX_RESOLVED_FILES} files`);
  }

  return result;
}

/**
 * Enrich a task's context_files by tracing their import graphs.
 * Returns the union of original files + discovered dependencies (deduplicated).
 */
export function enrichContextFiles(
  contextFiles: string[],
  projectRoot: string,
  maxDepth: number = MAX_DEPTH,
): string[] {
  if (!contextFiles || contextFiles.length === 0) return [];

  const traced = traceImportGraph(contextFiles, projectRoot, maxDepth);
  const seen = new Set<string>();
  const result: string[] = [];

  // Original files first (preserve order), then discovered deps
  for (const f of [...contextFiles.map(p => p.startsWith("/") ? p : resolve(projectRoot, p)), ...traced]) {
    const normalized = resolve(f); // normalize path
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}
