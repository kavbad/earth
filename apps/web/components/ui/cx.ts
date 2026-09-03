/** Joins class names, dropping falsy entries. */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ')
}
