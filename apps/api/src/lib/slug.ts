/**
 * Organization slug: lowercase, no accents, hyphen-separated.
 * Used in the `x-awah-org` header as a readable alternative to the UUID.
 */
export function slugify(input: string): string {
  const base = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  return base.length > 0 ? base : 'org'
}
