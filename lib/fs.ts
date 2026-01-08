// lib/fs.ts
import { ensureDir } from "@std/fs";
import { dirname } from "@std/path";

/**
 * Ensure the parent directory for a file path exists.
 */
export async function ensureParentDir(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  if (dir && dir !== "." && dir !== "/") await ensureDir(dir);
}
