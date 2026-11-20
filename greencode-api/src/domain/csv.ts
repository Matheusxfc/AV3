/**
 * CSV (RFC 4180) com protecao contra "CSV injection": celulas de TEXTO iniciadas por = + - @ (ou tab/CR)
 * sao prefixadas com apostrofo, para que o Excel/Calc nao as execute como formula.
 */
export function celulaCsv(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  if (valor instanceof Date) return valor.toISOString();
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  let s = String(valor);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function paraCsv(colunas: string[], linhas: Record<string, unknown>[]): string {
  const cab = colunas.map(celulaCsv).join(',');
  const corpo = linhas.map((l) => colunas.map((c) => celulaCsv(l[c])).join(','));
  // BOM UTF-8: o Excel abre acentos corretamente
  return '\ufeff' + [cab, ...corpo].join('\r\n') + '\r\n';
}
