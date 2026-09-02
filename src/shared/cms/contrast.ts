/**
 * WCAG 2.x contrast math for theme validation.
 *
 * Deliberately dependency-free (no AppError, no env) so the admin portal can mirror this
 * file verbatim (`web-portal/src/lib/contrast.ts`) and both sides compute identical ratios.
 * Publish blocks a theme whose accent/ink or header pairs fall below WCAG_AA_MIN — a
 * festival skin that renders invisible text on a million phones is not an editorial choice.
 *
 * Formulas are from WCAG 2.1 (relative luminance + contrast ratio); #FFFFFF vs #000000
 * comes out at exactly 21:1, which the unit tests pin.
 */

/** Strict 6-digit hex only — contrast needs full channels; the theme schema enforces the same. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** WCAG relative luminance of an sRGB color, in [0, 1]. */
export function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const lin = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/** Contrast ratio in [1, 21], or null when either hex is unparseable. Symmetric. */
export function contrastRatio(a: string, b: string): number | null {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return null;
  const la = relativeLuminance(ra);
  const lb = relativeLuminance(rb);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for normal text. Theme publish requires at least this on ink-on-surface pairs. */
export const WCAG_AA_MIN = 4.5;
