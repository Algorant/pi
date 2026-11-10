import { isAbsolute } from "node:path";

export const FIND_PROMPT_SNIPPET =
  "Prefer find for file-path search; use specific patterns and limits. FFF find is the primary/default file search.";

export const GREP_PROMPT_SNIPPET =
  "Prefer grep for content search; avoid wildcard-only patterns and use path/exclude constraints when possible. FFF grep is the primary/default content search.";

function zeroFileReason(value: any): string {
  const searchedZero = value?.totalFilesSearched === 0;
  const filteredZero = value?.filteredFileCount === 0;
  if (searchedZero && filteredZero) return "FFF searched 0/0 files";
  if (searchedZero) return "FFF searched 0 files";
  return "FFF had 0 candidate files";
}

function hasAbsolutePathish(value?: string): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed && (trimmed.startsWith("~/") || isAbsolute(trimmed) || /(?:^|\s)(?:\/|~\/)\S+/.test(trimmed)));
}

export function grepFallbackHint(value: any, _pattern: string, _path?: string): string | null {
  if (value?.totalFilesSearched !== 0 && value?.filteredFileCount !== 0) return null;
  return `Warning: ${zeroFileReason(value)}. If unexpected, check the path/exclude constraint; FFF does not index gitignored files. Use the read tool to inspect a known file.`;
}

export function findFallbackHint(value: any, pattern: string, path?: string): string | null {
  const suspicious = value?.totalFiles === 0 || (value?.totalMatched === 0 && (hasAbsolutePathish(pattern) || hasAbsolutePathish(path)));
  if (!suspicious) return null;
  return "Warning: FFF returned no matches for this path. If unexpected, check that the path exists and is not gitignored; FFF does not index ignored files. Use the read tool to inspect a known file.";
}
