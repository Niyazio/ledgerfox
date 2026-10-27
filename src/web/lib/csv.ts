import { toCsv } from "@shared/csv";
import { buildXlsx } from "@shared/xlsx";

export type DownloadFormat = "xlsx" | "csv";
let pending: DownloadFormat | null = null;

/** Run a download callback (which may first fetch rows) in a given format; it ends by calling downloadCsv. */
export async function withFormat(format: DownloadFormat, fn: () => unknown) {
  pending = format;
  try { await fn(); } finally { pending = null; }
}

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.replace(/[^\w.-]+/g, "_");
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Build and download a table from already-authorised data: CSV, or Excel (.xlsx) when called through withFormat("xlsx")
 * (the "Excel" button). The filename's extension follows the format.
 */
export function downloadCsv(filename: string, header: string[], rows: unknown[][]) {
  const format = pending ?? "csv";
  const base = filename.replace(/\.(csv|xlsx)$/i, "");
  if (format === "xlsx") {
    const bytes = buildXlsx(header, rows, base.slice(0, 31));
    save(new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${base}.xlsx`);
  } else {
    save(new Blob(["﻿" + toCsv(header, rows)], { type: "text/csv;charset=utf-8" }), `${base}.csv`);
  }
}

export const downloadExcel = (filename: string, header: string[], rows: unknown[][]) => void withFormat("xlsx", () => downloadCsv(filename, header, rows));
