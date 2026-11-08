/** Storage limits for UTF-8 text files, with a bounded exception for record cores. */
export const MAX_TEXT_FILE_BYTES = 1_000_000;
export const MAX_RECORD_CORE_BYTES = 8 * 1024 * 1024;

const CANONICAL_RECORD_CORE_PATH = /^memory\/records\/\d{4}\/\d{2}\/\d{2}\/\d{4}\/core\.md$/;

export function isCanonicalRecordCorePath(path: string): boolean {
  return CANONICAL_RECORD_CORE_PATH.test(path);
}

export function maxTextFileBytes(path: string): number {
  return isCanonicalRecordCorePath(path) ? MAX_RECORD_CORE_BYTES : MAX_TEXT_FILE_BYTES;
}
