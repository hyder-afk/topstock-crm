// Turns the check's codes into plain sentences in the screen's language (the problems file and the issue list use the
// same words). Codes come from the database and the rules library; unknown codes fall back to a general sentence.
import type { ImportIssue } from "@/lib/import-server";

type T = {
  (key: string, values?: Record<string, string | number>): string;
  has: (key: string) => boolean;
};

function say(t: T, key: string, values?: Record<string, string | number>) {
  return t.has(key) ? t(key, values) : t("problems.unknown");
}

export function issueMessages(t: T, issue: ImportIssue): string[] {
  if (issue.outcome === "rejected") {
    const out = issue.problems.map((code) => say(t, `problems.${code}`));
    if (issue.reason) out.push(say(t, `reasons.${issue.reason}`));
    return out.length > 0 ? out : [t("problems.unknown")];
  }
  if (issue.outcome === "duplicate_file" && issue.match_key) {
    return [say(t, `dupes.file.${issue.match_key}`, { row: issue.match_row_no ?? 0 })];
  }
  if (issue.outcome === "duplicate_existing" && issue.match_key) {
    return [
      issue.match_company_name
        ? say(t, `dupes.existing.${issue.match_key}`, { name: issue.match_company_name })
        : say(t, `dupes.existingNoName.${issue.match_key}`),
    ];
  }
  // Ready (or imported) with a fix: the lead comes in, without the field named here.
  return issue.fixes.map((code) => say(t, `fixes.${code}`));
}

export type IssueKind = "rejected" | "duplicate_file" | "duplicate_existing" | "fixed";

export function issueKind(issue: ImportIssue): IssueKind {
  if (issue.outcome === "rejected" || issue.outcome === "duplicate_file" || issue.outcome === "duplicate_existing") {
    return issue.outcome;
  }
  return "fixed";
}
