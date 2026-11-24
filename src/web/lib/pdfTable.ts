/**
 * Reads a table (a price list, product list or rate card) out of a PDF, in the browser. pdf.js gives each piece of
 * text with its position; pieces on the same line become a row, and the header row (the line with words such as
 * "Name", "Rate", "HSN", "Description") decides the columns. Lines that only continue a long description are joined
 * to the row above; section titles between the rows are left out. Works for PDFs made from Word, Excel or billing
 * software; a scanned PDF (a photo of paper) has no text to read.
 */

export interface TextPiece { str: string; x: number; y: number; w: number; h: number; page: number }

const HEADER_WORD = /\b(no|s\.?\s?no|sr|name|items?|products?|services?|particulars|description|details|sku|code|hsn|sac|unit|uom|qty|quantity|rate|price|mrp|amount|gst|tax|cost|barcode|type|category)\b/gi;
const NUMBER = /^(₹|rs\.?|inr)?\s*\d[\d,]*(\.\d+)?\b/i;
const headerWords = (t: string) => (t.match(HEADER_WORD) ?? []).length;

type P = TextPiece & { text: string };

/** Pieces on (about) the same height of one page, top to bottom. */
function lines(ps: P[]): P[][] {
  const out: P[][] = [];
  for (const p of [...ps].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)) {
    const l = out[out.length - 1];
    if (l && l[0].page === p.page && Math.abs(l[0].y - p.y) <= Math.max(2, p.h * 0.4)) l.push(p); else out.push([p]);
  }
  for (const l of out) l.sort((a, b) => a.x - b.x);
  return out;
}

/** Left edges where many data pieces start (the real column starts). */
function clusters(xs: number[]): number[] {
  const sorted = [...xs].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const x of sorted) { const g = groups[groups.length - 1]; if (g && x - g[g.length - 1] <= 4) g.push(x); else groups.push([x]); }
  return groups.filter((g) => g.length >= 2).map((g) => g[0]);
}

const join = (a: string, b: string) => (!a ? b : a.endsWith("-") && /^[A-Za-z0-9]/.test(b) ? a + b : `${a} ${b}`);

/**
 * The table as rows of text, the first row being the header; [] when no header row is found. Each row is built around
 * a piece of the numbered column (No., Rate, Price): text of the other columns belongs to the nearest row, so cells
 * that wrap over several lines, top-aligned or centred, stay together.
 */
export function tableFromPieces(pieces: TextPiece[]): string[][] {
  const ps: P[] = pieces.map((p) => ({ ...p, text: p.str.replace(/\s+/g, " ").trim() })).filter((p) => p.text);
  const all = lines(ps);
  const hl = all.find((l) => l.length >= 1 && headerWords(l.map((p) => p.text).join(" ")) >= 2);
  if (!hl) return [];
  const headerPage = hl[0].page, headerY = hl[0].y;
  const below = (p: P) => p.page > headerPage || (p.page === headerPage && p.y < headerY - 2);
  const starts = clusters(ps.filter(below).map((p) => p.x));
  // Header cells; a piece holding several headings ("No. Service / SKU") is split where data columns start inside it.
  const head: { x: number; text: string }[] = [];
  for (const p of hl) {
    const words = [...p.text.matchAll(/\S+/g)].map((m) => ({ w: m[0], x: p.x + (m.index! / p.text.length) * p.w }));
    let cur = { x: p.x, text: "" };
    for (const [k, wd] of words.entries()) {
      if (k > 0 && starts.some((s) => s > p.x + 4 && Math.abs(s - wd.x) <= 12 && wd.x > cur.x + 4)) { head.push(cur); cur = { x: starts.find((s) => Math.abs(s - wd.x) <= 12)!, text: "" }; }
      cur.text = cur.text ? `${cur.text} ${wd.w}` : wd.w;
    }
    head.push(cur);
  }
  head.sort((a, b) => a.x - b.x);
  const headText = head.map((h) => h.text);
  const col = (x: number) => { let k = 0; head.forEach((h, i) => { if (x >= h.x - 6) k = i; }); return k; };
  // Data pieces: below the header line of their page, not a repeated header, not a title running across columns.
  const pageHeader = new Map<number, number>();
  for (const l of all) if (!pageHeader.has(l[0].page) && headerWords(l.map((p) => p.text).join(" ")) >= 2 && (l[0].page !== headerPage || l[0].y === headerY)) pageHeader.set(l[0].page, l[0].y);
  const data = ps.filter((p) => {
    const top = pageHeader.get(p.page);
    if (top !== undefined ? p.y >= top - 2 : p.page < headerPage) return false;
    const k = col(p.x);
    return k === head.length - 1 || p.x + p.w <= head[k + 1].x + 5;
  });
  // The numbered column: the one with the most number-like pieces (leftmost on a tie).
  const counts = head.map((_, i) => data.filter((p) => col(p.x) === i && NUMBER.test(p.text)).length);
  const anchorCol = counts.indexOf(Math.max(...counts));
  const rows: string[][] = [headText];
  for (const page of [...new Set(data.map((p) => p.page))].sort((a, b) => a - b)) {
    const onPage = data.filter((p) => p.page === page);
    const anchors = onPage.filter((p) => col(p.x) === anchorCol && NUMBER.test(p.text)).sort((a, b) => b.y - a.y);
    if (!anchors.length) continue;
    const tol = anchors[0].h * 0.5;
    const centred = onPage.some((p) => col(p.x) !== anchorCol && p.y > anchors[0].y + tol);
    const cells = anchors.map(() => headText.map(() => [] as P[]));
    for (const p of onPage) {
      let best = -1, dist = Infinity;
      anchors.forEach((a, i) => {
        const d = a.y - p.y; // > 0: the piece is below the anchor
        if (Math.abs(d) > 60) return;
        if (!centred && d < -tol) return; // top-aligned rows: nothing of a row sits above its number
        const score = centred ? Math.abs(d) : d;
        if (score < dist) { dist = score; best = i; }
      });
      if (best >= 0) cells[best][col(p.x)].push(p);
    }
    for (const r of cells) rows.push(r.map((c) => c.sort((a, b) => b.y - a.y || a.x - b.x).reduce((t, p) => join(t, p.text), "")));
  }
  return rows.filter((r, i) => i === 0 || r.filter(Boolean).length >= 2);
}

/** Text pieces of every page of a PDF file (pdf.js is loaded only when a PDF is chosen). */
export async function pdfPieces(data: ArrayBuffer): Promise<TextPiece[]> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(data), enableXfa: false });
  const doc = await task.promise;
  const out: TextPiece[] = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, 200); n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      for (const it of tc.items) {
        if (!("str" in it)) continue;
        out.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || it.height || 10, page: n });
      }
    }
  } finally { await task.destroy(); }
  return out;
}

export async function parsePdfTable(data: ArrayBuffer): Promise<string[][]> {
  const pieces = await pdfPieces(data);
  if (!pieces.some((p) => p.str.trim())) throw new Error("This PDF has no text to read (it looks like a scan). Use the Excel template instead, or a PDF made from Word, Excel or billing software.");
  const rows = tableFromPieces(pieces);
  if (rows.length < 2) throw new Error("No table with column names (like Name, Rate, HSN, Description) was found in this PDF. Use the Excel template instead.");
  return rows;
}
