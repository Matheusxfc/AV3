import 'dotenv/config';

function obrigatoria(nome: string): string {
  const v = process.env[nome];
  if (!v) throw new Error(`Variavel de ambiente obrigatoria ausente: ${nome} (veja .env.example)`);
  return v;
}

function inteiro(nome: string, padrao: number): number {
  const v = process.env[nome];
  if (v === undefined || v === '') return padrao;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Variavel ${nome} deve ser um inteiro nao negativo.`);
  return n;
}

function booleano(nome: string, padrao: boolean): boolean {
  const v = process.env[nome];
  if (v === undefined || v === '') return padrao;
  return ['1', 'true', 'sim', 'yes'].includes(v.toLowerCase());
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  /** Porta configuravel por variavel de ambiente (requisito do enunciado). */
  port: inteiro('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  databaseUrl: obrigatoria('DATABASE_URL'),
  jwtSecret: obrigatoria('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '30m',
  bcryptRounds: inteiro('BCRYPT_ROUNDS', 10),
  /** Tentativas de login por minuto por IP (protecao contra forca bruta). */
  loginRateLimitMax: inteiro('LOGIN_RATE_LIMIT_MAX', 20),

  // ---- Fila / worker / agendador (Atividade 3) ----
  /** Executa o worker dentro do processo da API. Em escala, use false e rode `npm run worker` a parte. */
  workerEmbutido: booleano('WORKER_EMBUTIDO', true),
  workerIntervaloMs: inteiro('WORKER_INTERVALO_MS', 2000),
  workerConcorrencia: Math.max(1, inteiro('WORKER_CONCORRENCIA', 2)),
  tarefaMaxTentativas: Math.max(1, inteiro('TAREFA_MAX_TENTATIVAS', 3)),
  backoffBaseMs: inteiro('BACKOFF_BASE_MS', 5000),
  backoffMaxMs: inteiro('BACKOFF_MAX_MS', 300000),
  /** Tarefa EM_EXECUCAO ha mais que isso e considerada travada (worker caiu) e volta para a fila. */
  tarefaTravadaTimeoutMs: inteiro('TAREFA_TRAVADA_TIMEOUT_MS', 300000),
  relatorioRetencaoHoras: Math.max(1, inteiro('RELATORIO_RETENCAO_HORAS', 24)),
  /** Mantenha true em UMA unica instancia (evita agendamentos duplicados). */
  schedulerHabilitado: booleano('SCHEDULER_HABILITADO', true),
  analisesCron: process.env.ANALISES_CRON ?? '0 2 * * *',
  limpezaCron: process.env.LIMPEZA_CRON ?? '*/30 * * * *',
  cronTimezone: process.env.CRON_TIMEZONE ?? 'America/Sao_Paulo',
};

if (env.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET deve ter pelo menos 32 caracteres.');
}
