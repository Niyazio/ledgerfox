import { toCsv } from "@shared/csv";
import { buildXlsx } from "@shared/xlsx";
import { saveFile } from "./download";

export type DownloadFormat = "xlsx" | "csv";

/** Education mode: downloads from a practice company start with a line saying so. */
let practiceMark = false;
export const setPracticeExports = (on: boolean) => { practiceMark = on; };
const PRACTICE_LINE = "PRACTICE COMPANY (education mode) - not a valid business or tax document";
let pending: DownloadFormat | null = null;

/** Run a download callback (which may first fetch rows) in a given format; it ends by calling downloadCsv. */
export async function withFormat(format: DownloadFormat, fn: () => unknown) {
  pending = format;
  try { await fn(); } finally { pending = null; }
}

/**
 * Build and download a table from already-authorised data: CSV, or Excel (.xlsx) when called through withFormat("xlsx")
 * (the "Excel" button). The filename's extension follows the format.
 */
export function downloadCsv(filename: string, header: string[], rows: unknown[][]) {
  const format = pending ?? "csv";
  if (practiceMark) rows = [[PRACTICE_LINE, ...header.slice(1).map(() => "")], ...rows];
  const base = filename.replace(/\.(csv|xlsx)$/i, "");
  if (format === "xlsx") {
    const bytes = buildXlsx(header, rows, base.slice(0, 31));
    void saveFile(new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${base}.xlsx`);
  } else {
    void saveFile(new Blob(["﻿" + toCsv(header, rows)], { type: "text/csv;charset=utf-8" }), `${base}.csv`);
  }
}

export const downloadExcel = (filename: string, header: string[], rows: unknown[][]) => void withFormat("xlsx", () => downloadCsv(filename, header, rows));
