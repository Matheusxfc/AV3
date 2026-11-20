/**
 * Estatistica implementada manualmente (sem dependencias): funcoes puras e testaveis.
 * Decisao: media/mediana/desvio/OLS/suavizacao exponencial sao poucas linhas e dispensam
 * bibliotecas (simple-statistics, mathjs), reduzindo dependencias e superficie de ataque.
 * Se o negocio exigir modelos mais ricos (regressao multipla, ARIMA), troca-se este modulo.
 */

export const soma = (v: number[]): number => v.reduce((a, b) => a + b, 0);

/** Media aritmetica; NaN para lista vazia. */
export const media = (v: number[]): number => (v.length ? soma(v) / v.length : NaN);

export function mediana(v: number[]): number {
  if (!v.length) return NaN;
  const o = [...v].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
}

/** Desvio padrao amostral (n-1); 0 para n < 2. */
export function desvioPadrao(v: number[]): number {
  if (v.length < 2) return 0;
  const m = media(v);
  return Math.sqrt(soma(v.map((x) => (x - m) ** 2)) / (v.length - 1));
}

/** Percentil (0-100) com interpolacao linear. */
export function percentil(v: number[], p: number): number {
  if (!v.length) return NaN;
  const o = [...v].sort((a, b) => a - b);
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (o.length - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < o.length ? o[i] * (1 - f) + o[i + 1] * f : o[i];
}

export interface RegressaoLinear {
  n: number;
  intercepto: number;
  inclinacao: number;
  r2: number;
}

/**
 * Minimos quadrados ordinarios (OLS) simples: y = intercepto + inclinacao * x.
 * Retorna null se n < 2 ou se x nao varia (reta indefinida).
 */
export function regressaoLinear(x: number[], y: number[]): RegressaoLinear | null {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  const mx = media(x.slice(0, n));
  const my = media(y.slice(0, n));
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
    syy += (y[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const inclinacao = sxy / sxx;
  const intercepto = my - inclinacao * mx;
  let sres = 0;
  for (let i = 0; i < n; i++) sres += (y[i] - (intercepto + inclinacao * x[i])) ** 2;
  const r2 = syy === 0 ? 0 : Math.max(0, 1 - sres / syy);
  return { n, intercepto, inclinacao, r2 };
}

export function rmse(reais: number[], previstos: number[]): number {
  const n = Math.min(reais.length, previstos.length);
  if (!n) return NaN;
  let s = 0;
  for (let i = 0; i < n; i++) s += (reais[i] - previstos[i]) ** 2;
  return Math.sqrt(s / n);
}

/**
 * Suavizacao exponencial simples: nivel_t = alfa*y_t + (1-alfa)*nivel_{t-1}.
 * A previsao do proximo periodo e o ultimo nivel.
 */
export function suavizacaoExponencial(serie: number[], alfa = 0.5): { niveis: number[]; previsao: number } | null {
  if (!serie.length) return null;
  const a = Math.min(1, Math.max(0.01, alfa));
  const niveis = [serie[0]];
  for (let i = 1; i < serie.length; i++) niveis.push(a * serie[i] + (1 - a) * niveis[i - 1]);
  return { niveis, previsao: niveis[niveis.length - 1] };
}

/** Arredonda; devolve null para NaN/Infinity (JSON nao representa NaN). */
export function arred(n: number, casas = 2): number | null {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** casas;
  return Math.round(n * f) / f;
}
