import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { calcularBackoffMs } from '../domain/retry';
import { ErroNaoRetentavel } from '../shared/errors';
import { TarefaReivindicada, TarefaRepository } from '../repositories/TarefaRepository';
import { ExecutorTarefas } from './ExecutorTarefas';

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

/**
 * Worker da fila (polling). Politica de retry:
 *  - falha retentavel e tentativas < maxTentativas  -> volta para PENDENTE com backoff exponencial + jitter;
 *  - falha nao retentavel (ErroNaoRetentavel) OU tentativas esgotadas -> FALHA (estado final; reenfileiravel por admin);
 *  - worker que cai no meio da tarefa -> a tarefa "travada" e recolocada na fila apos o timeout.
 * Concorrencia limitada por WORKER_CONCORRENCIA. Varios workers (processos) podem rodar em paralelo.
 */
export class FilaWorker {
  readonly id = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  private rodando = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly emExecucao = new Set<Promise<void>>();
  private ultimaRecuperacao = 0;

  constructor(
    private readonly tarefas: TarefaRepository,
    private readonly executor: ExecutorTarefas,
    private readonly log: Logger,
  ) {}

  iniciar(): void {
    if (this.rodando) return;
    this.rodando = true;
    this.log.info({ worker: this.id, concorrencia: env.workerConcorrencia, intervaloMs: env.workerIntervaloMs }, 'Worker da fila iniciado');
    this.agendar(0);
  }

  /** Para de buscar tarefas e espera as que estao em execucao terminarem. */
  async parar(): Promise<void> {
    this.rodando = false;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled([...this.emExecucao]);
    this.log.info({ worker: this.id }, 'Worker da fila encerrado');
  }

  private agendar(ms: number): void {
    if (!this.rodando) return;
    this.timer = setTimeout(() => void this.ciclo(), ms);
  }

  private async ciclo(): Promise<void> {
    if (!this.rodando) return;
    let pegouTarefa = false;
    try {
      await this.recuperarTravadasPeriodicamente();
      while (this.rodando && this.emExecucao.size < env.workerConcorrencia) {
        const t = await this.tarefas.reivindicar(this.id);
        if (!t) break;
        pegouTarefa = true;
        const p: Promise<void> = this.processar(t).finally(() => this.emExecucao.delete(p));
        this.emExecucao.add(p);
      }
    } catch (err) {
      this.log.error({ err }, 'Erro no ciclo do worker (banco indisponivel?)');
    } finally {
      // Se havia trabalho, volta logo; se nao, espera o intervalo (evita martelar o banco).
      this.agendar(pegouTarefa ? 50 : env.workerIntervaloMs);
    }
  }

  private async recuperarTravadasPeriodicamente(): Promise<void> {
    if (Date.now() - this.ultimaRecuperacao < 30_000) return;
    this.ultimaRecuperacao = Date.now();
    const n = await this.tarefas.recuperarTravadas(new Date(Date.now() - env.tarefaTravadaTimeoutMs));
    if (n > 0) this.log.warn({ tarefas: n }, 'Tarefas travadas recuperadas');
  }

  private async processar(t: TarefaReivindicada): Promise<void> {
    const inicio = Date.now();
    try {
      const r = await this.executor.executar(t);
      await this.tarefas.concluir(t.id, r);
      this.log.info({ tarefa: t.id, tipo: t.tipo, tentativa: t.tentativas, ms: Date.now() - inicio }, 'Tarefa concluida');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const definitiva = err instanceof ErroNaoRetentavel || t.tentativas >= t.maxTentativas;
      try {
        if (definitiva) {
          await this.tarefas.registrarFalha(t.id, msg, null);
          this.log.error({ tarefa: t.id, tipo: t.tipo, tentativa: t.tentativas, erro: msg }, 'Tarefa FALHOU definitivamente');
        } else {
          const atraso = calcularBackoffMs(t.tentativas, env.backoffBaseMs, env.backoffMaxMs);
          await this.tarefas.registrarFalha(t.id, msg, new Date(Date.now() + atraso));
          this.log.warn({ tarefa: t.id, tipo: t.tipo, tentativa: t.tentativas, proximaEmMs: atraso, erro: msg }, 'Tarefa falhou; nova tentativa agendada');
        }
      } catch (e2) {
        this.log.error({ err: e2, tarefa: t.id }, 'Nao foi possivel registrar a falha (o timeout de travada recolocara a tarefa)');
      }
    }
  }
}
