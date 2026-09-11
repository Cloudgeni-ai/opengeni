/** Small real PDF for exercising the ordinary chat attachment parser. */
export function knowledgeContractPdf(): Uint8Array {
  const lines = [
    "ACME - SERVICE AGREEMENT",
    "Renewal date: 1 December 2026.",
    "Annual subscription: EUR 20,000.",
    "Billing API supports invoice webhooks.",
    "Contact: Morgan Lee, Acme operations.",
  ];
  const stream = `BT /F1 18 Tf 50 760 Td ${lines.map((line, index) => `${index ? "0 -32 Td " : ""}(${line}) Tj`).join("\n")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
