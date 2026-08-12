const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

export function shouldUpdateStatus(current: string | undefined, next: string | null): boolean {
  return Boolean(next && current !== next && !(current && terminalStatuses.has(current)));
}
