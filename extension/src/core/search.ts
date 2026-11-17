// Full-text search terms. No Node APIs.

/** The words of a search, as the text index splits them: letters and digits. */
export const searchWords = (q: string): string[] => q.normalize('NFC').match(/[\p{L}\p{N}_]+/gu) ?? [];

/** An FTS5 query for what someone typed: every word must be there, the last one as a prefix
 *  (it may still be being typed). Null when there are no words. */
export function ftsQuery(q: string): string | null {
  const words = searchWords(q);
  if (!words.length) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}
