/**
 * Pure TypeScript ISO/IEC 15417 Code-128B Barcode Encoder & SVG Renderer.
 * Zero Node-only bindings — runs identically in browser, Cloudflare Workers (`workerd`), and Node.
 */

const START_CODE_B = 104;
const STOP_CODE = 106;
const QUIET_ZONE_MODULES = 10;

/**
 * Full 107-pattern ISO/IEC 15417 Code-128 symbol table (values 0..106).
 * Patterns 0..105 have 6 alternating Bar/Space widths summing to 11 modules.
 * Pattern 106 (Stop) has 7 alternating Bar/Space widths summing to 13 modules.
 */
export const CODE128_PATTERNS: readonly string[] = [
  '212222', // 00: SP
  '222122', // 01: !
  '222221', // 02: "
  '121223', // 03: #
  '121322', // 04: $
  '131222', // 05: %
  '122213', // 06: &
  '122312', // 07: '
  '132212', // 08: (
  '221213', // 09: )
  '221312', // 10: *
  '231212', // 11: +
  '112232', // 12: ,
  '122132', // 13: -
  '122231', // 14: .
  '113222', // 15: /
  '123122', // 16: 0
  '123221', // 17: 1
  '223211', // 18: 2
  '221132', // 19: 3
  '221231', // 20: 4
  '213212', // 21: 5
  '223112', // 22: 6
  '312131', // 23: 7
  '311222', // 24: 8
  '321122', // 25: 9
  '321221', // 26: :
  '312212', // 27: ;
  '322112', // 28: <
  '322211', // 29: =
  '212123', // 30: >
  '212321', // 31: ?
  '232121', // 32: @
  '111323', // 33: A
  '131123', // 34: B
  '131321', // 35: C
  '112313', // 36: D
  '132113', // 37: E
  '132311', // 38: F
  '211313', // 39: G
  '231113', // 40: H
  '231311', // 41: I
  '112133', // 42: J
  '112331', // 43: K
  '132131', // 44: L
  '113123', // 45: M
  '113321', // 46: N
  '133121', // 47: O
  '313121', // 48: P
  '211331', // 49: Q
  '231131', // 50: R
  '213113', // 51: S
  '213311', // 52: T
  '213131', // 53: U
  '311123', // 54: V
  '311321', // 55: W
  '331121', // 56: X
  '312113', // 57: Y
  '312311', // 58: Z
  '332111', // 59: [
  '314111', // 60: \
  '221411', // 61: ]
  '431111', // 62: ^
  '111224', // 63: _
  '111422', // 64: `
  '121124', // 65: a
  '121421', // 66: b
  '141122', // 67: c
  '141221', // 68: d
  '112214', // 69: e
  '112412', // 70: f
  '122114', // 71: g
  '122411', // 72: h
  '142112', // 73: i
  '142211', // 74: j
  '241211', // 75: k
  '221114', // 76: l
  '413111', // 77: m
  '241112', // 78: n
  '134111', // 79: o
  '111242', // 80: p
  '121142', // 81: q
  '121241', // 82: r
  '114212', // 83: s
  '124112', // 84: t
  '124211', // 85: u
  '411212', // 86: v
  '421112', // 87: w
  '421211', // 88: x
  '212141', // 89: y
  '214121', // 90: z
  '412121', // 91: {
  '111143', // 92: |
  '111341', // 93: }
  '131141', // 94: ~
  '114113', // 95: DEL
  '114311', // 96: FNC 3
  '411113', // 97: FNC 2
  '411311', // 98: SHIFT A
  '113141', // 99: CODE C
  '114131', // 100: FNC 4 / CODE B
  '311141', // 101: CODE A
  '411131', // 102: FNC 1
  '211412', // 103: START A
  '211214', // 104: START B
  '211232', // 105: START C
  '2331112', // 106: STOP (13 modules)
] as const;

export interface Code128Encoded {
  /** Binary module sequence (`1` = dark bar, `0` = white space). */
  modules: number[];
  /** Weighted modulo-103 ISO/IEC 15417 check character value (0..102). */
  checksum: number;
}

export interface Code128SvgOptions {
  height?: number;
  moduleWidth?: number;
  includeText?: boolean;
}

function appendPatternModules(target: number[], patternIndex: number): void {
  const pattern = CODE128_PATTERNS[patternIndex];
  if (!pattern) {
    throw new RangeError(`Invalid Code-128 symbol value: ${patternIndex}`);
  }
  for (let i = 0; i < pattern.length; i++) {
    const bit = i % 2 === 0 ? 1 : 0; // Even indices are bars (1), odd indices are spaces (0)
    const width = pattern.charCodeAt(i) - 48;
    for (let w = 0; w < width; w++) {
      target.push(bit);
    }
  }
}

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Encodes printable ASCII text (codes 32..126) into ISO/IEC 15417 Code-128B modules
 * with Start Code B (104), weighted modulo-103 checksum, and Stop pattern (106).
 */
export function encodeCode128B(text: string): Code128Encoded {
  if (text.length === 0) {
    throw new RangeError('Code-128B input text must not be empty.');
  }

  const symbolValues: number[] = [START_CODE_B];
  let weightedSum = START_CODE_B;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 || code > 126) {
      throw new RangeError(
        `Character '${text[i]}' (U+${code.toString(16).toUpperCase().padStart(4, '0')}) is outside Code-128B printable ASCII range (32..126).`,
      );
    }
    const value = code - 32;
    symbolValues.push(value);
    weightedSum += value * (i + 1);
  }

  const checksum = weightedSum % 103;
  symbolValues.push(checksum, STOP_CODE);

  const modules: number[] = [];
  for (const sym of symbolValues) {
    appendPatternModules(modules, sym);
  }

  return { modules, checksum };
}

/**
 * Renders a crisp, laser-scannable inline SVG Code-128B barcode with pure black bars
 * over a pure white ISO 10X quiet zone.
 */
export function renderCode128Svg(text: string, options: Code128SvgOptions = {}): string {
  const height = Math.max(16, Math.round(options.height ?? 64));
  const moduleWidth = Math.max(0.5, options.moduleWidth ?? 2);
  const includeText = options.includeText ?? true;

  const { modules } = encodeCode128B(text);
  const quietPx = QUIET_ZONE_MODULES * moduleWidth;
  const barcodeWidthPx = modules.length * moduleWidth;
  const totalWidth = Number((barcodeWidthPx + quietPx * 2).toFixed(2));
  const topPadding = 8;
  const textAreaHeight = includeText ? 20 : 8;
  const totalHeight = topPadding + height + textAreaHeight;

  const rects: string[] = [];
  let i = 0;
  while (i < modules.length) {
    if (modules[i] === 1) {
      const start = i;
      while (i < modules.length && modules[i] === 1) {
        i++;
      }
      const runLen = i - start;
      const x = Number((quietPx + start * moduleWidth).toFixed(2));
      const w = Number((runLen * moduleWidth).toFixed(2));
      rects.push(`<rect x="${x}" y="${topPadding}" width="${w}" height="${height}" fill="#000000"/>`);
    } else {
      i++;
    }
  }

  const safeLabel = escapeXml(text);
  const textNode = includeText
    ? `<text x="${Number((totalWidth / 2).toFixed(2))}" y="${topPadding + height + 15}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="12" font-weight="700" letter-spacing="1.2" fill="#000000">${safeLabel}</text>`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" width="${totalWidth}" height="${totalHeight}" role="img" aria-label="Code-128B barcode for ${safeLabel}" shape-rendering="crispEdges">`,
    `<rect x="0" y="0" width="${totalWidth}" height="${totalHeight}" fill="#ffffff"/>`,
    ...rects,
    textNode,
    '</svg>',
  ]
    .filter(Boolean)
    .join('');
}
