import { StatusTarefa, TipoAnalise, TipoTarefa } from '@prisma/client';
import { env } from '../config/env';
import { NaoEncontradoError, RegraNegocioError } from '../shared/errors';
import { Pagina, resposta } from '../shared/util';
import { FiltroTarefa, TarefaRepository } from '../repositories/TarefaRepository';

/** Operacoes da fila: enfileirar, consultar e administrar. */
export class TarefaService {
  constructor(private readonly tarefas: TarefaRepository) {}

  enfileirarAnalise(tipo: TipoAnalise, f: { organizacaoId?: string }, origem: 'AGENDADA' | 'MANUAL', solicitante: string) {
    return this.tarefas.enfileirar({
      tipo: 'EXECUTAR_ANALISE', payload: { tipo, organizacaoId: f.organizacaoId ?? null, origem },
      solicitante, maxTentativas: env.tarefaMaxTentativas,
    });
  }

  /** Evita empilhar a mesma analise agendada se a anterior ainda nao terminou. */
  async enfileirarAnaliseAgendadaSeLivre(tipo: TipoAnalise): Promise<boolean> {
    const payload = { tipo, organizacaoId: null, origem: 'AGENDADA' };
    if (await this.tarefas.existePendenteOuEmExecucao('EXECUTAR_ANALISE', payload)) return false;
    await this.tarefas.enfileirar({ tipo: 'EXECUTAR_ANALISE', payload, solicitante: 'AGENDADOR', maxTentativas: env.tarefaMaxTentativas });
    return true;
  }

  async listar(f: FiltroTarefa, p: Pagina) {
    const { dados, total } = await this.tarefas.listar(f, p.skip, p.take);
    return resposta(dados, total, p);
  }

  async obter(id: string) {
    const t = await this.tarefas.porId(id);
    if (!t) throw new NaoEncontradoError('Tarefa', id);
    return t;
  }

  async resumo() {
    const g = await this.tarefas.contagemPorStatus();
    const base: Record<StatusTarefa, number> = { PENDENTE: 0, EM_EXECUCAO: 0, CONCLUIDA: 0, FALHA: 0 };
    for (const x of g) base[x.status] = x._count._all;
    return base;
  }

  async reenfileirar(id: string) {
    await this.obter(id);
    if (!(await this.tarefas.reenfileirar(id))) throw new RegraNegocioError('Somente tarefas com status FALHA podem ser reenfileiradas.');
    return this.obter(id);
  }

  purgarExpiradas() {
    return this.tarefas.purgarExpiradas();
  }
}

export type { TipoTarefa };
