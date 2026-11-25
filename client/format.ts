import type { Report } from "../shared/contracts";
export function usageProblem(report: Exclude<Report, { status: "available" }>): string {
  if (report.status === "error") return report.error;
  const problem = report.problem;
  if (problem.kind === "expired")
    return "Authentication has expired. Sign in again with the Codex CLI using this CODEX_HOME.";
  if (problem.kind === "rejected")
    return `Authentication was rejected (HTTP ${problem.status}). Check whether this account is signed in.`;
  return problem.detail;
}
export function percent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 10) / 10}%`
    : "Unknown";
}
export function localTime(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Unknown";
}
