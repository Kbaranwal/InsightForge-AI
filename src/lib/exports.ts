// Client-side export helpers. All libraries used here are pure-JS and browser-safe.
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import pptxgen from "pptxgenjs";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle,
} from "docx";
import type { Dashboard, Insights, Understanding, Forecast } from "./datasets.functions";

export interface ExportPayload {
  datasetName: string;
  rowCount: number;
  columnCount: number;
  dashboard: Dashboard | null;
  insights: { insights: Insights["insights"]; anomalies: Insights["anomalies"] } | null;
  recommendations: Insights["recommendations"] | null;
  executive_summary: string | null;
  understanding: Understanding | null;
  forecasts: Forecast[];
  columns: Array<{ name: string; type: string }>;
  rows: Array<Record<string, unknown>>;
}

function fname(name: string, ext: string) {
  const safe = name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "report";
  const stamp = new Date().toISOString().slice(0, 10);
  return `insightiq_${safe}_${stamp}.${ext}`;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

// ---------- CSV ----------
export function exportCSV(p: ExportPayload) {
  const cols = p.columns.map((c) => c.name);
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of p.rows) lines.push(cols.map((c) => esc(r[c])).join(","));
  download(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" }), fname(p.datasetName, "csv"));
}

// ---------- Excel ----------
export function exportExcel(p: ExportPayload) {
  const wb = XLSX.utils.book_new();

  // Data
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(p.rows), "Data");

  // KPIs
  if (p.dashboard?.kpis?.length) {
    const kpiRows = p.dashboard.kpis.map((k) => ({
      KPI: k.label, Value: k.value, Trend: k.trend ?? "", Explanation: k.explanation,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(kpiRows), "KPIs");
  }

  // Insights
  const insightRows = [
    ...(p.insights?.insights ?? []).map((i) => ({ Type: "Insight", Title: i.title, Detail: i.detail, Evidence: i.evidence })),
    ...(p.insights?.anomalies ?? []).map((a) => ({ Type: "Anomaly", Title: a.title, Detail: a.detail, Evidence: "" })),
    ...(p.recommendations ?? []).map((r) => ({ Type: `Recommendation (${r.impact})`, Title: r.title, Detail: r.detail, Evidence: "" })),
  ];
  if (insightRows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(insightRows), "Insights");

  // Forecasts (one sheet per metric)
  for (const f of p.forecasts) {
    const rows = f.points.map((pt) => ({ Period: pt.period, Value: pt.value, Projected: pt.projected ? "Yes" : "No" }));
    const safeName = `Forecast_${f.metric}`.slice(0, 31).replace(/[[\]:*?/\\]/g, "_");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), safeName);
  }

  // Summary
  if (p.executive_summary) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Executive Summary"], [p.executive_summary]]), "Summary");
  }

  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  download(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), fname(p.datasetName, "xlsx"));
}

// ---------- PDF ----------
export function exportPDF(p: ExportPayload) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 40;
  let y = M;

  const h1 = (t: string) => { doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.text(t, M, y); y += 24; };
  const h2 = (t: string) => { doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.text(t, M, y); y += 18; };
  const body = (t: string) => {
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    const lines = doc.splitTextToSize(t, W - M * 2);
    for (const line of lines) {
      if (y > 780) { doc.addPage(); y = M; }
      doc.text(line, M, y); y += 14;
    }
  };
  const pageBreakIfNeeded = (needed: number) => { if (y + needed > 800) { doc.addPage(); y = M; } };

  h1(`InsightIQ Report — ${p.datasetName}`);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(120);
  doc.text(`${p.rowCount.toLocaleString()} rows · ${p.columnCount} columns · generated ${new Date().toLocaleString()}`, M, y);
  doc.setTextColor(0); y += 20;

  if (p.executive_summary) { h2("Executive Summary"); body(p.executive_summary); y += 6; }

  if (p.dashboard?.kpis?.length) {
    pageBreakIfNeeded(60); h2("Key Performance Indicators");
    autoTable(doc, {
      startY: y,
      head: [["KPI", "Value", "Trend", "Explanation"]],
      body: p.dashboard.kpis.map((k) => [k.label, k.value, k.trend ?? "", k.explanation]),
      styles: { fontSize: 9, cellPadding: 5 },
      headStyles: { fillColor: [15, 23, 42] },
      margin: { left: M, right: M },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 16;
  }

  if (p.insights?.insights?.length) {
    pageBreakIfNeeded(40); h2("Key Insights");
    for (const it of p.insights.insights) { body(`• ${it.title} — ${it.detail} [${it.evidence}]`); }
    y += 4;
  }

  if (p.insights?.anomalies?.length) {
    pageBreakIfNeeded(40); h2("Anomalies");
    for (const a of p.insights.anomalies) body(`• ${a.title} — ${a.detail}`);
    y += 4;
  }

  if (p.recommendations?.length) {
    pageBreakIfNeeded(40); h2("Recommendations");
    for (const r of p.recommendations) body(`• [${r.impact.toUpperCase()}] ${r.title} — ${r.detail}`);
    y += 4;
  }

  for (const f of p.forecasts) {
    pageBreakIfNeeded(80); h2(`Forecast — ${f.metric}`);
    body(f.narrative);
    autoTable(doc, {
      startY: y,
      head: [["Period", "Value", "Projected"]],
      body: f.points.map((pt) => [pt.period, String(pt.value), pt.projected ? "Yes" : "No"]),
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: [15, 23, 42] },
      margin: { left: M, right: M },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 16;
  }

  doc.save(fname(p.datasetName, "pdf"));
}

// ---------- PowerPoint ----------
export function exportPPTX(p: ExportPayload) {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE";
  const T = { title: { x: 0.5, y: 0.4, w: 12, h: 0.7, fontSize: 28, bold: true, color: "0F172A" } as const };

  const cover = pres.addSlide();
  cover.background = { color: "0F172A" };
  cover.addText("InsightIQ Analysis Report", { x: 0.5, y: 2.5, w: 12, h: 1, fontSize: 44, bold: true, color: "FFFFFF" });
  cover.addText(p.datasetName, { x: 0.5, y: 3.6, w: 12, h: 0.6, fontSize: 24, color: "94A3B8" });
  cover.addText(`${p.rowCount.toLocaleString()} rows · ${p.columnCount} columns · ${new Date().toLocaleDateString()}`,
    { x: 0.5, y: 4.3, w: 12, h: 0.4, fontSize: 14, color: "64748B" });

  if (p.executive_summary) {
    const s = pres.addSlide();
    s.addText("Executive Summary", T.title);
    s.addText(p.executive_summary, { x: 0.5, y: 1.3, w: 12, h: 5.5, fontSize: 16, color: "1E293B", valign: "top" });
  }

  if (p.dashboard?.kpis?.length) {
    const s = pres.addSlide();
    s.addText("Key Performance Indicators", T.title);
    const rows: pptxgen.TableRow[] = [
      [
        { text: "KPI", options: { bold: true, fill: { color: "0F172A" }, color: "FFFFFF" } },
        { text: "Value", options: { bold: true, fill: { color: "0F172A" }, color: "FFFFFF" } },
        { text: "Explanation", options: { bold: true, fill: { color: "0F172A" }, color: "FFFFFF" } },
      ],
      ...p.dashboard.kpis.map((k): pptxgen.TableRow => [
        { text: k.label }, { text: k.value }, { text: k.explanation },
      ]),
    ];
    s.addTable(rows, { x: 0.5, y: 1.3, w: 12, fontSize: 12, border: { pt: 1, color: "E2E8F0" } });
  }

  if (p.insights?.insights?.length) {
    const s = pres.addSlide();
    s.addText("Key Insights", T.title);
    s.addText(
      p.insights.insights.map((i) => ({ text: `${i.title} — ${i.detail}`, options: { bullet: true, fontSize: 14 } })),
      { x: 0.5, y: 1.3, w: 12, h: 5.5, color: "1E293B" }
    );
  }

  if (p.recommendations?.length) {
    const s = pres.addSlide();
    s.addText("Recommendations", T.title);
    s.addText(
      p.recommendations.map((r) => ({ text: `[${r.impact.toUpperCase()}] ${r.title} — ${r.detail}`, options: { bullet: true, fontSize: 14 } })),
      { x: 0.5, y: 1.3, w: 12, h: 5.5, color: "1E293B" }
    );
  }

  for (const f of p.forecasts) {
    const s = pres.addSlide();
    s.addText(`Forecast — ${f.metric}`, T.title);
    s.addText(f.narrative, { x: 0.5, y: 1.2, w: 12, h: 1, fontSize: 12, color: "475569" });
    const labels = f.points.map((pt) => pt.period);
    const values = f.points.map((pt) => pt.value);
    s.addChart(pres.ChartType.line, [{ name: f.metric, labels, values }], {
      x: 0.5, y: 2.3, w: 12, h: 4.5, showTitle: false, showLegend: false,
      lineDataSymbol: "circle", lineDataSymbolSize: 6,
    });
  }

  pres.writeFile({ fileName: fname(p.datasetName, "pptx") });
}

// ---------- Word ----------
export async function exportDOCX(p: ExportPayload) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" };
  const cellBorders = { top: border, bottom: border, left: border, right: border };

  const kpiTable = p.dashboard?.kpis?.length
    ? new Table({
        width: { size: 9000, type: WidthType.DXA },
        columnWidths: [2400, 1800, 4800],
        rows: [
          new TableRow({
            children: ["KPI", "Value", "Explanation"].map((h) =>
              new TableCell({
                borders: cellBorders,
                shading: { fill: "0F172A", type: "clear", color: "auto" },
                children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: "FFFFFF" })] })],
              })
            ),
          }),
          ...p.dashboard.kpis.map((k) =>
            new TableRow({
              children: [k.label, k.value, k.explanation].map((v) =>
                new TableCell({ borders: cellBorders, children: [new Paragraph(String(v))] })
              ),
            })
          ),
        ],
      })
    : null;

  const bullets = (items: string[]) =>
    items.map((t) => new Paragraph({ text: t, bullet: { level: 0 } }));

  const forecastSections = p.forecasts.flatMap((f) => [
    new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(`Forecast — ${f.metric}`)] }),
    new Paragraph({ children: [new TextRun({ text: f.narrative, italics: true })] }),
    new Table({
      width: { size: 9000, type: WidthType.DXA },
      columnWidths: [3000, 3000, 3000],
      rows: [
        new TableRow({
          children: ["Period", "Value", "Projected"].map((h) =>
            new TableCell({
              borders: cellBorders,
              shading: { fill: "0F172A", type: "clear", color: "auto" },
              children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: "FFFFFF" })] })],
            })
          ),
        }),
        ...f.points.map((pt) =>
          new TableRow({
            children: [pt.period, String(pt.value), pt.projected ? "Yes" : "No"].map((v) =>
              new TableCell({ borders: cellBorders, children: [new Paragraph(v)] })
            ),
          })
        ),
      ],
    }),
    new Paragraph(""),
  ]);

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      children: [
        new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.LEFT,
          children: [new TextRun(`InsightIQ Report — ${p.datasetName}`)] }),
        new Paragraph({ children: [new TextRun({
          text: `${p.rowCount.toLocaleString()} rows · ${p.columnCount} columns · ${new Date().toLocaleString()}`,
          color: "64748B", italics: true,
        })] }),
        new Paragraph(""),
        ...(p.executive_summary ? [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Executive Summary")] }),
          new Paragraph(p.executive_summary),
        ] : []),
        ...(kpiTable ? [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("KPIs")] }),
          kpiTable,
          new Paragraph(""),
        ] : []),
        ...(p.insights?.insights?.length ? [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Insights")] }),
          ...bullets(p.insights.insights.map((i) => `${i.title} — ${i.detail} [${i.evidence}]`)),
        ] : []),
        ...(p.insights?.anomalies?.length ? [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Anomalies")] }),
          ...bullets(p.insights.anomalies.map((a) => `${a.title} — ${a.detail}`)),
        ] : []),
        ...(p.recommendations?.length ? [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Recommendations")] }),
          ...bullets(p.recommendations.map((r) => `[${r.impact.toUpperCase()}] ${r.title} — ${r.detail}`)),
        ] : []),
        ...(p.forecasts.length ? [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Forecasts")] }),
          ...forecastSections,
        ] : []),
      ],
    }],
  });

  const blob = await Packer.toBlob(doc);
  download(blob, fname(p.datasetName, "docx"));
}
