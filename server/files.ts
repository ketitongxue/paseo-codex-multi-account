import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PublicError } from "./errors";

export function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
export async function optionalText(path: string): Promise<string | null> {
  try {
    // Follow external config/auth symlinks, but bound the opened target, not the symlink.
    // Nonblocking open also prevents a FIFO masquerading as auth.json from hanging the daemon.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile())
        throw new PublicError(
          "Authentication and configuration paths must point to regular files.",
        );
      const maximum = 1024 * 1024;
      if (info.size > maximum) throw new PublicError("The file is too large to read safely.");
      const buffer = Buffer.allocUnsafe(maximum + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > maximum) throw new PublicError("The file is too large to read safely.");
      return buffer.toString("utf8", 0, size);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
export async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new PublicError(
      "The operation was denied because the plugin data directory was redirected.",
    );
  await chmod(path, 0o700);
}
export async function atomicWrite(path: string, data: string): Promise<void> {
  await privateDir(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function canonicalHome(value: string, userHome: string): Promise<string> {
  const expanded =
    value === "~" ? userHome : value.startsWith("~/") ? join(userHome, value.slice(2)) : value;
  if (!isAbsolute(expanded) || /[\x00-\x1f\x7f]/.test(expanded))
    throw new PublicError("CODEX_HOME must be an absolute directory path or start with ~/.");
  const path = await realpath(resolve(expanded));
  if (!(await lstat(path)).isDirectory()) throw new PublicError("CODEX_HOME must be a directory.");
  return path;
}
