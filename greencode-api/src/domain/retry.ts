/**
 * Politica de retry: backoff exponencial com jitter de +-20%.
 *   atraso = min(base * 2^(tentativa-1), maximo) * (0,8 .. 1,2)
 * O jitter evita que varias tarefas que falharam juntas voltem todas no mesmo instante.
 */
export function calcularBackoffMs(tentativa: number, baseMs: number, maxMs: number, aleatorio: () => number = Math.random): number {
  const exp = Math.min(baseMs * 2 ** Math.max(0, tentativa - 1), maxMs);
  return Math.round(exp * (0.8 + 0.4 * aleatorio()));
}
