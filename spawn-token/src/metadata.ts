import type { PublicMetadata } from './types.js';
export class LaunchError extends Error { constructor(public readonly code: string) { super(code); this.name = 'LaunchError'; } }
export function requireCondition(condition: unknown, code: string): asserts condition { if (!condition) throw new LaunchError(code); }
export function validateText(value: unknown, maxBytes: number, code: string): asserts value is string {
  requireCondition(typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) && new TextEncoder().encode(value).length <= maxBytes, code);
}
/** Syntactic public URL gate. Storage must separately verify public DNS, content type, immutability and fetchability. */
export function validatePublicHttps(value: unknown, maxBytes = 2048): asserts value is string {
  validateText(value, maxBytes, 'INVALID_URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new LaunchError('INVALID_URL'); }
  // A trailing dot is the same DNS name (WHATWG keeps it on domain names but
  // strips it on IPv4), so normalize it away before the public-host checks;
  // otherwise `https://localhost./x` slips past the reserved-name list.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  requireCondition(url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search
    && !host.includes(':') && !/^\d+(\.\d+)*$/.test(host) && host.includes('.')
    && !['localhost','local','internal','test','invalid'].some(s => host === s || host.endsWith(`.${s}`))
    && (!url.port || url.port === '443'), 'INVALID_PUBLIC_URL');
}
export function validatePublicMetadata(value: unknown): PublicMetadata {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_METADATA');
  const obj = value as Record<string,unknown>;
  const fields = new Set(['name','symbol','description','image','showName','createdOn','website']);
  requireCondition(Object.keys(obj).every(k => fields.has(k)), 'PRIVATE_OR_UNKNOWN_METADATA_FIELD');
  validateText(obj.name,32,'INVALID_NAME'); validateText(obj.symbol,13,'INVALID_SYMBOL');
  requireCondition(typeof obj.description === 'string' && new TextEncoder().encode(obj.description).length <= 2048 && !/\u0000/.test(obj.description), 'INVALID_DESCRIPTION');
  validatePublicHttps(obj.image); validatePublicHttps(obj.createdOn);
  if (obj.website !== undefined) validatePublicHttps(obj.website);
  requireCondition(typeof obj.showName === 'boolean', 'INVALID_METADATA');
  return Object.freeze({...obj}) as unknown as PublicMetadata;
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { requireCondition(Number.isSafeInteger(value), 'NON_CANONICAL_NUMBER'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  requireCondition(typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'NON_CANONICAL_VALUE');
  const object = value as Record<string,unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return `sha256:${Array.from(new Uint8Array(digest), b=>b.toString(16).padStart(2,'0')).join('')}`;
}
