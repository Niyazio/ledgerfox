/**
 * Code 128 (subset B) barcode encoder: printable ASCII to bar widths, drawn as SVG by the labels page.
 * Any USB or camera barcode scanner reads it. The product QR payload is `LF1|P|<code>`: identity only, never prices or costs.
 */

// Bar/space widths for symbol values 0–106 (106 = stop, followed by a 2-module termination bar).
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313", "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const START_B = 104;
const STOP = 106;

export const productQrPayload = (code: string) => `LF1|P|${code}`;

/** Module widths (alternating bar, space, … starting with a bar) for `text`, including start, checksum and stop. */
export function code128(text: string): number[] {
  if (!text) throw new Error("Nothing to encode");
  const values = [START_B];
  for (const ch of text) {
    const v = ch.charCodeAt(0) - 32;
    if (v < 0 || v > 95) throw new Error(`Character "${ch}" cannot be printed in a Code 128 barcode`);
    values.push(v);
  }
  const check = values.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103;
  values.push(check, STOP);
  return values.flatMap((v) => [...PATTERNS[v]].map(Number));
}

/** SVG markup for a barcode `height` units tall with quiet zones; width scales with the text length. */
export function code128Svg(text: string, height = 40): string {
  const widths = code128(text);
  const quiet = 10;
  let x = quiet;
  const rects: string[] = [];
  widths.forEach((w, i) => { if (i % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${w}" height="${height}"/>`); x += w; });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x + quiet} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges"><g fill="#000">${rects.join("")}</g></svg>`;
}
