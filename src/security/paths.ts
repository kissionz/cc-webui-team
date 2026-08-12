import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export class PathOutsideAllowlistError extends Error {
  readonly code = "PATH_OUTSIDE_ALLOWLIST";

  constructor(
    readonly candidatePath: string,
    readonly allowedRoots: ReadonlyArray<string>,
  ) {
    super(`Path ${candidatePath} is outside the configured workspace roots.`);
    this.name = "PathOutsideAllowlistError";
  }
}

function isWithin(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

/**
 * Resolves both roots and candidate through the filesystem before comparison,
 * preventing a symlink inside a workspace from escaping to another directory.
 * The candidate and roots must already exist.
 */
export async function resolveAllowedRealPath(
  candidatePath: string,
  allowedRoots: ReadonlyArray<string>,
): Promise<string> {
  if (allowedRoots.length === 0) {
    throw new PathOutsideAllowlistError(candidatePath, allowedRoots);
  }

  const [candidate, ...roots] = await Promise.all([
    realpath(resolve(candidatePath)),
    ...allowedRoots.map((root) => realpath(resolve(root))),
  ]);
  if (!roots.some((root) => isWithin(candidate, root))) {
    throw new PathOutsideAllowlistError(candidate, roots);
  }
  return candidate;
}
