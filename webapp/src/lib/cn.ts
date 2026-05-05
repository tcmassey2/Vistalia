// Tiny className helper. Avoids pulling in clsx as a dep.
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
