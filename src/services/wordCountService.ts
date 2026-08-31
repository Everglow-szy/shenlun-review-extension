/**
 * Counts Unicode code points after removing whitespace. `Array.from` keeps a
 * surrogate pair (for example an emoji or a rare CJK character) as one item.
 */
export function countShenlunCharacters(text: string): number {
  return Array.from(text.replace(/\s/gu, "")).length;
}

export function formatShenlunCharacterCount(text: string, wordLimit: number | null): string {
  const count = countShenlunCharacters(text);
  return wordLimit === null ? `${count} 字` : `${count} / ${wordLimit} 字`;
}
