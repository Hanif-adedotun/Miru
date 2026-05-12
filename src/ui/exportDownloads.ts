/**
 * Build CSV / PDF downloads from aggregated scrape artifacts (side panel).
 */

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

import type { ScrapeArtifact } from "../shared/types.js";

export function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function artifactsToCsv(artifacts: ScrapeArtifact[]): string {
  const blocks: string[] = [];
  for (const artifact of artifacts) {
    blocks.push(`# ${artifact.label}`);
    const header = artifact.columns.map(escapeCsvCell).join(",");
    const body = artifact.rows
      .map((row) => artifact.columns.map((column) => escapeCsvCell(row[column] ?? "")).join(","))
      .join("\n");
    blocks.push([header, body].filter(Boolean).join("\n"));
    blocks.push("");
  }
  return `${blocks.join("\n").trimEnd()}\n`;
}

export function downloadArtifactsCsv(artifacts: ScrapeArtifact[], baseFilename: string): void {
  const csv = artifactsToCsv(artifacts);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  triggerDownload(`${baseFilename}.csv`, blob);
}

export function downloadArtifactsPdf(artifacts: ScrapeArtifact[], baseFilename: string): void {
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });

  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    if (index > 0) {
      doc.addPage();
    }

    doc.setFontSize(11);
    doc.text(artifact.label, 40, 40);

    autoTable(doc, {
      startY: 52,
      head: [artifact.columns],
      body: artifact.rows.map((row) => artifact.columns.map((column) => row[column] ?? "")),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [56, 189, 248] },
      margin: { left: 40, right: 40 },
    });
  }

  const blob = doc.output("blob");
  triggerDownload(`${baseFilename}.pdf`, blob);
}

export function exportBaseFilename(prompt: string | undefined): string {
  const base =
    (prompt || "miru-scrape")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "miru-scrape";
  return `${base}-${new Date().toISOString().slice(0, 10)}`;
}
