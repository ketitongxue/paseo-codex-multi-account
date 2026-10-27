export class PublicError extends Error {}
export function safeMessage(error: unknown): string {
  return error instanceof PublicError
    ? error.message
    : "操作失败；请检查 Codex CLI、目录权限与系统安全存储。";
}
export async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(safeMessage(error));
  }
}
