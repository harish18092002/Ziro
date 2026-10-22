/** One RFC 4180 CSV record. Always ends in "\n", never "\r\n", so output is identical everywhere. */
export function csvRow(cells: readonly string[]): string {
  return `${cells.map(quote).join(',')}\n`;
}

function quote(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}
