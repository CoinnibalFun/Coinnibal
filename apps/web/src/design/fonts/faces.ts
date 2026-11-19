/** Does a FontFace's `unicode-range` (any serialization: `U+0-FF`, `U+0000-00FF`, `U+4??`) cover the code point? */
export function rangeCovers(range: string, cp: number): boolean {
  return range.split(',').some((part) => {
    const m = /^\s*U\+([0-9a-f?]+)(?:-([0-9a-f]+))?\s*$/i.exec(part);
    if (!m) return false;
    const lo = parseInt(m[1].replace(/\?/g, '0'), 16);
    const hi = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, 'f'), 16);
    return cp >= lo && cp <= hi;
  });
}

/**
 * The faces latin text in these families and styles is drawn with: per family and style, the LAST face whose range
 * covers latin letters. The browser tries the face declared last first for a character, so for upright Fraunces that
 * is design/fonts/fraunces-soft.css (imported after fontsource's faces), not fontsource's own latin file.
 * (`document.fonts.load('800 80px "Fraunces Variable"')` would fetch both: it loads every face that matches.)
 */
export function latinFaces(fonts: Iterable<FontFace>, wanted: readonly (readonly [string, string])[]): FontFace[] {
  const faces = new Map<string, FontFace>();
  for (const f of fonts) {
    const key = `${f.family.replace(/["']/g, '')}|${f.style}`;
    if (wanted.some(([family, style]) => key === `${family}|${style}`) && rangeCovers(f.unicodeRange, 0x61)) faces.set(key, f);
  }
  return [...faces.values()];
}

/**
 * Loads the latin faces of these families and styles, for canvas text (the WL pass), which never makes the browser
 * fetch a font by itself.
 */
export async function loadLatinFaces(wanted: readonly (readonly [string, string])[]): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  const all: FontFace[] = [];
  document.fonts.forEach((f) => all.push(f));
  await Promise.all(latinFaces(all, wanted).map((f) => f.load()));
}
