import type { Report } from "../shared/contracts";
export function usageProblem(report: Exclude<Report, { status: "available" }>): string {
  if (report.status === "error") return report.error;
  const problem = report.problem;
  if (problem.kind === "expired") return "认证已过期；请使用该 CODEX_HOME 的 Codex CLI 重新认证。";
  if (problem.kind === "rejected")
    return `认证被拒绝（HTTP ${problem.status}）；请检查该账号登录状态。`;
  return problem.detail;
}
export function percent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 10) / 10}%`
    : "未知";
}
export function localTime(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "未知";
}
