/**
 * Slug de organização: minúsculas, sem acento, separado por hífen.
 * Usado no header `x-awah-org` como alternativa legível ao UUID.
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
