export type RecipientReport = { recipients: string[]; valid: number; invalid: string[]; duplicates: number; total: number };

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (char === '"') { if (quoted && input[i + 1] === '"') { field += '"'; i += 1; } else quoted = !quoted; }
    else if (char === "," && !quoted) { row.push(field.trim()); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && input[i + 1] === "\n") i += 1; row.push(field.trim()); if (row.some(Boolean)) rows.push(row); row = []; field = ""; }
    else field += char;
  }
  row.push(field.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function parseRecipients(input: string, fileName = ""): RecipientReport {
  const isCsv = /\.csv$/i.test(fileName) || /^\s*email\s*,/im.test(input);
  let values: string[];
  if (isCsv) {
    const rows = parseCsvRows(input);
    const header = rows[0]?.map((column) => column.trim().toLowerCase());
    const emailColumn = header?.indexOf("email") ?? -1;
    values = emailColumn >= 0 ? rows.slice(1).map((row) => row[emailColumn] ?? "") : rows.flat();
  } else values = input.split(/[\n\r,;]+/);
  const invalid: string[] = []; const seen = new Set<string>(); const recipients: string[] = []; let duplicates = 0;
  for (const raw of values) {
    const value = raw.trim().replace(/^['"]|['"]$/g, "").trim(); if (!value) continue;
    const normalized = value.toLowerCase();
    if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/.test(normalized)) { invalid.push(value); continue; }
    if (seen.has(normalized)) { duplicates += 1; continue; }
    seen.add(normalized); recipients.push(normalized);
  }
  return { recipients, valid: recipients.length, invalid, duplicates, total: recipients.length + invalid.length + duplicates };
}
