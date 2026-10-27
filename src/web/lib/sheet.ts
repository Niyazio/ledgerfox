/**
 * Reads the first worksheet of an .xlsx file, or a .csv file, into rows keyed by the header row.
 * No library: .xlsx is a ZIP of XML files, unpacked with the browser's DecompressionStream.
 * Old binary .xls files are not supported (save them as .xlsx or .csv first).
 */

export type SheetRow = Record<string, string>;

/** RFC 4180 CSV (quotes, doubled quotes, newlines inside quotes); also accepts ; or tab separated files. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = [",", ";", "\t"].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Minimal ZIP reader: central directory → named entries (stored or deflated). */
async function unzip(buf: ArrayBuffer, wanted: (name: string) => boolean): Promise<Map<string, string>> {
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("This is not an .xlsx file. Save it from Excel as .xlsx or .csv.");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = new Uint8Array(buf, start, size);
    out.set(name, dec.decode(method === 0 ? raw : await inflate(raw)));
  }
  return out;
}

const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, "&");
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join("");
const colIndex = (ref: string) => [...ref.replace(/\d+$/, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export async function parseXlsx(buf: ArrayBuffer): Promise<string[][]> {
  const files = await unzip(buf, (n) => n === "xl/sharedStrings.xml" || n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = [...(files.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  // The first sheet in the workbook (by tab order), resolved through the workbook relationships.
  const firstRid = /<sheet\b[^>]*r:id="([^"]+)"/.exec(files.get("xl/workbook.xml") ?? "")?.[1];
  const target = firstRid ? new RegExp(`Id="${firstRid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${firstRid}"`).exec(files.get("xl/_rels/workbook.xml.rels") ?? "") : null;
  const path = target ? `xl/${(target[1] ?? target[2]).replace(/^\/?xl\//, "")}` : "xl/worksheets/sheet1.xml";
  const sheet = files.get(path) ?? files.get("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("The workbook has no worksheet");
  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const val = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      const value = type === "s" ? shared[Number(val)] ?? "" : type === "inlineStr" ? texts(inner) : type === "b" ? (val === "1" ? "TRUE" : "FALSE") : unescapeXml(val ?? "");
      row[ref ? colIndex(ref) : row.length] = value;
    }
    rows.push(Array.from(row, (x) => x ?? ""));
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Header row + data rows → objects; blank headers are ignored. */
export function toObjects(rows: string[][]): SheetRow[] {
  const [head = [], ...data] = rows;
  return data.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()]).filter(([h]) => h)));
}

export async function readSheet(file: File): Promise<SheetRow[]> {
  if (/\.xls$/i.test(file.name)) throw new Error("Old .xls files are not supported. In Excel choose File → Save As → .xlsx (or .csv) and try again.");
  const rows = /\.(csv|txt)$/i.test(file.name) ? parseCsv(await file.text()) : await parseXlsx(await file.arrayBuffer());
  if (rows.length < 2) throw new Error("The file needs a header row and at least one data row");
  return toObjects(rows);
}
