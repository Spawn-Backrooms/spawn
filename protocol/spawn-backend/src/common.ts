import { sha256 } from "@noble/hashes/sha2.js";
/** Caller-facing error fields that may differ from internal retry semantics. */
export interface PublicErrorEnvelope {
  retryable?: boolean;
  details?: Record<string, unknown>;
}
export class DomainError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public retryable = false,
    message = code,
    /** Serialized to callers only; `retryable` above keeps server workflows terminal. */
    public envelope?: PublicErrorEnvelope,
  ) {
    super(message);
  }
}
/** Additive fields for an error body. Absent for ordinary errors, so existing shapes stay exact. */
export function publicErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof DomainError) || !error.envelope) return {};
  return {
    message: error.message,
    retryable: error.envelope.retryable ?? error.retryable,
    ...(error.envelope.details ? { details: error.envelope.details } : {}),
  };
}
/** Rebuild a remote error (internal hop) without losing its public envelope. */
export function remoteDomainError(
  status: number,
  error: { code?: string; message?: string; retryable?: boolean; details?: unknown } | undefined,
  fallbackCode: string,
): DomainError {
  const details =
    error?.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? (error.details as Record<string, unknown>)
      : undefined;
  const code = error?.code ?? fallbackCode;
  return new DomainError(
    code,
    status,
    details ? betaInternalRetryable(code, error?.retryable) : (error?.retryable ?? false),
    error?.message,
    details ? { retryable: error?.retryable, details } : undefined,
  );
}
function betaInternalRetryable(code: string, retryable: boolean | undefined) {
  // A shortfall is fixable by the user, never by an automatic server retry.
  return code === "BETA_TOKEN_REQUIRED" ? false : (retryable ?? false);
}
export function assert(
  condition: unknown,
  code: string,
  status = 400,
): asserts condition {
  if (!condition) throw new DomainError(code, status);
}
export function canonical(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return "[" + v.map((item) => item === undefined ? "null" : canonical(item)).join(",") + "]";
  return (
    "{" +
    Object.keys(v as object)
      .sort()
      // Match JSON.stringify: an optional field explicitly set to undefined
      // is not serialized, so digests do not depend on how the caller built it.
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonical((v as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}
export function hash(v: unknown): string {
  return (
    "sha256:" +
    Array.from(
      sha256(
        new TextEncoder().encode(typeof v === "string" ? v : canonical(v)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("")
  );
}
export function id(prefix: string): string {
  return prefix + "_" + crypto.randomUUID().replaceAll("-", "");
}
export function iso(now: number): string {
  return new Date(now).toISOString();
}
export interface SqlLike {
  exec<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Iterable<T>;
}
export function rows<T>(
  sql: SqlLike,
  query: string,
  ...params: unknown[]
): T[] {
  return Array.from(sql.exec<T>(query, ...params));
}
export function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}
export function noSecrets(s: string): boolean {
  return !/(?:\bBearer\s+[A-Za-z0-9._-]{12,}|\bsk-[A-Za-z0-9]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_ -]?key|access[_ -]?token|password)\s*[:=]\s*\S{8,})/i.test(
    s,
  );
}
