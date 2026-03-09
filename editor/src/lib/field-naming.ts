export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[()µ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

