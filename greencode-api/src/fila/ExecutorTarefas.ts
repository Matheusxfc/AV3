import { TipoAnalise } from '@prisma/client';
import { AppError, ErroNaoRetentavel } from '../shared/errors';
import { TarefaReivindicada } from '../repositories/TarefaRepository';
import { AnaliseService, TIPOS_ANALISE } from '../services/AnaliseService';
import { PayloadRelatorio, RelatorioAssincronoService } from '../services/RelatorioAssincronoService';

export interface ResultadoExecucao {
  resultado?: unknown;
  conteudo?: string;
  nomeArquivo?: string;
  mime?: string;
}

/** Despacha cada tipo de tarefa para o servico responsavel. */
export class ExecutorTarefas {
  constructor(private readonly analises: AnaliseService, private readonly relatorios: RelatorioAssincronoService) {}

  async executar(t: TarefaReivindicada): Promise<ResultadoExecucao> {
    try {
      switch (t.tipo) {
        case 'EXECUTAR_ANALISE': {
          const { tipo, organizacaoId, origem } = t.payload as { tipo: TipoAnalise; organizacaoId: string | null; origem: 'AGENDADA' | 'MANUAL' };
          if (!tipo) throw new ErroNaoRetentavel('Payload sem "tipo" de analise.');
          const r = await this.analises.executar(tipo, organizacaoId ? { organizacaoId } : {}, origem ?? 'AGENDADA');
          return { resultado: { analiseId: r.id, tipo, duracaoMs: r.duracaoMs } };
        }
        case 'GERAR_RELATORIO': {
          const p = t.payload as PayloadRelatorio;
          if (!p?.tipo) throw new ErroNaoRetentavel('Payload de relatorio invalido.');
          const r = await this.relatorios.gerar(p);
          return { resultado: { linhas: r.linhas, formato: p.formato }, conteudo: r.conteudo, nomeArquivo: r.nomeArquivo, mime: r.mime };
        }
        default:
          throw new ErroNaoRetentavel(`Tipo de tarefa desconhecido: ${String(t.tipo)}`);
      }
    } catch (e) {
      // Erros de regra de negocio (4xx) nao melhoram com nova tentativa.
      if (e instanceof AppError) throw new ErroNaoRetentavel(e.message);
      throw e;
    }
  }
}

export { TIPOS_ANALISE };
