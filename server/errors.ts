export class PublicError extends Error {}
export function safeMessage(error: unknown): string {
  return error instanceof PublicError
    ? error.message
    : "The operation failed. Check the Codex CLI, directory permissions, and system credential storage.";
}
export async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(safeMessage(error));
  }
}
