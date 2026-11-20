import cron, { ScheduledTask } from 'node-cron';
import { env } from '../config/env';
import { TIPOS_ANALISE, SLUG_ANALISE } from '../services/AnaliseService';
import { TarefaService } from '../services/TarefaService';
import { Logger } from './FilaWorker';

/**
 * Tarefas agendadas (node-cron). O agendador NAO calcula nada: apenas ENFILEIRA jobs recorrentes;
 * quem executa (com retry, concorrencia e recuperacao de falhas) e o worker.
 *  - analises globais (padrao: todo dia as 02:00);
 *  - limpeza de relatorios expirados (padrao: a cada 30 min).
 * Com varias instancias da API, habilite o agendador em UMA so (SCHEDULER_HABILITADO=false nas demais).
 */
export class Agendador {
  private readonly tarefasCron: ScheduledTask[] = [];

  constructor(private readonly tarefas: TarefaService, private readonly log: Logger) {}

  iniciar(): void {
    const opcoes = { timezone: env.cronTimezone };
    if (!cron.validate(env.analisesCron) || !cron.validate(env.limpezaCron)) {
      this.log.error({ analises: env.analisesCron, limpeza: env.limpezaCron }, 'Expressao cron invalida: agendador NAO iniciado');
      return;
    }
    this.tarefasCron.push(cron.schedule(env.analisesCron, () => void this.enfileirarAnalises(), opcoes));
    this.tarefasCron.push(cron.schedule(env.limpezaCron, () => void this.limpar(), opcoes));
    this.log.info({ analises: env.analisesCron, limpeza: env.limpezaCron, timezone: env.cronTimezone }, 'Agendador iniciado');
  }

  parar(): void {
    for (const t of this.tarefasCron) t.stop();
    this.tarefasCron.length = 0;
  }

  async enfileirarAnalises(): Promise<void> {
    try {
      for (const slug of TIPOS_ANALISE) {
        const novo = await this.tarefas.enfileirarAnaliseAgendadaSeLivre(SLUG_ANALISE[slug]);
        this.log.info({ analise: slug, enfileirada: novo }, novo ? 'Analise agendada enfileirada' : 'Analise ja pendente; ignorada');
      }
    } catch (err) {
      this.log.error({ err }, 'Falha ao enfileirar analises agendadas');
    }
  }

  async limpar(): Promise<void> {
    try {
      const n = await this.tarefas.purgarExpiradas();
      if (n > 0) this.log.info({ removidas: n }, 'Relatorios expirados removidos');
    } catch (err) {
      this.log.error({ err }, 'Falha na limpeza de relatorios expirados');
    }
  }
}
