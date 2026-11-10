export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export function ok<T>(value: T): Result<T> { return { ok: true, value }; }
export function err<T = never>(error: string): Result<T> { return { ok: false, error }; }

export type Score = any;
export type FileItem = any;
export type MixedItem = any;
export type MixedSearchResult = any;
export type GrepMatch = any;
export type GrepResult = any;
export type ScanProgress = any;
export type HealthCheck = any;

export type Health = HealthCheck & {
  sdkPackage: string;
  binaryPackage: string;
  binaryPath: string | null;
  binaryExists: boolean;
};
