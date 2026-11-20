import { env } from '../config/env';
import { paraCsv } from '../domain/csv';
import { VERSAO_MODELO } from '../domain/analise';
import { ConflitoError, NaoEncontradoError, RegraNegocioError } from '../shared/errors';
import { TarefaRepository } from '../repositories/TarefaRepository';
import { AnaliseService } from './AnaliseService';

export type TipoRelatorio = 'EQUIPAMENTOS_PREDITIVO' | 'RENTABILIDADE' | 'EFICIENCIA' | 'VIDA_UTIL';
export type FormatoRelatorio = 'JSON' | 'CSV';
export const TIPOS_RELATORIO: TipoRelatorio[] = ['EQUIPAMENTOS_PREDITIVO', 'RENTABILIDADE', 'EFICIENCIA', 'VIDA_UTIL'];

export interface PayloadRelatorio {
  tipo: TipoRelatorio;
  formato: FormatoRelatorio;
  organizacaoId: string | null;
}

export interface ContextoSolicitacao {
  parceiroId?: string;
  chaveApiId?: string;
  organizacaoId: string | null;
  solicitante: string;
}

const COLUNAS_PREDITIVO = [
  'codigoBarrasInterno', 'tipo', 'marca', 'modelo', 'anoFabricacao', 'idadeAnos', 'estadoFisico', 'statusRastreamento',
  'pesoKg', 'valorEstimadoRecuperacao', 'vidaRemanescenteAnos', 'anoEstimadoInservivel', 'confiancaModelo',
];

/**
 * Relatorios pesados: a API responde 202 na hora com o id da tarefa; o worker gera o arquivo em
 * segundo plano; o cliente consulta o status (polling) e baixa quando CONCLUIDA.
 */
export class RelatorioAssincronoService {
  constructor(private readonly tarefas: TarefaRepository, private readonly analises: AnaliseService) {}

  async solicitar(ctx: ContextoSolicitacao, d: { tipo: TipoRelatorio; formato?: FormatoRelatorio }) {
    const payload: PayloadRelatorio = { tipo: d.tipo, formato: d.formato ?? 'JSON', organizacaoId: ctx.organizacaoId };
    const t = await this.tarefas.enfileirar({
      tipo: 'GERAR_RELATORIO', payload, solicitante: ctx.solicitante, maxTentativas: env.tarefaMaxTentativas,
      parceiroId: ctx.parceiroId, chaveApiId: ctx.chaveApiId,
      expiraEm: new Date(Date.now() + env.relatorioRetencaoHoras * 3_600_000),
    });
    return t;
  }

  /** parceiroId informado = so enxerga as proprias tarefas (404 caso contrario, sem revelar existencia). */
  async status(id: string, parceiroId?: string) {
    const t = await this.tarefas.porId(id);
    if (!t || (parceiroId && t.parceiroId !== parceiroId)) throw new NaoEncontradoError('Relatorio', id);
    return t;
  }

  async baixar(id: string, parceiroId?: string) {
    const t = await this.tarefas.porIdComConteudo(id);
    if (!t || (parceiroId && t.parceiroId !== parceiroId) || t.tipo !== 'GERAR_RELATORIO') throw new NaoEncontradoError('Relatorio', id);
    if (t.status === 'FALHA') throw new RegraNegocioError(`A geracao do relatorio falhou: ${t.erro ?? 'erro desconhecido'}`);
    if (t.status !== 'CONCLUIDA' || t.conteudo === null) throw new ConflitoError(`Relatorio ainda nao esta pronto (status: ${t.status}).`);
    return { conteudo: t.conteudo, nomeArquivo: t.nomeArquivo ?? `relatorio-${id}.txt`, mime: t.mime ?? 'text/plain' };
  }

  /** Chamado pelo worker. */
  async gerar(p: PayloadRelatorio) {
    const geradoEm = new Date();
    const org = p.organizacaoId;
    let colunas: string[] = [];
    let linhas: Record<string, unknown>[] = [];
    let corpo: Record<string, unknown> = {};

    if (p.tipo === 'EQUIPAMENTOS_PREDITIVO') {
      const r = await this.analises.relatorioPreditivoEquipamentos(org);
      colunas = COLUNAS_PREDITIVO;
      linhas = r.linhas;
      corpo = { resumo: r.resumo, equipamentos: r.linhas };
    } else {
      const filtro = org ? { organizacaoId: org } : {};
      const tipoAnalise = p.tipo === 'RENTABILIDADE' ? 'RENTABILIDADE' : p.tipo === 'EFICIENCIA' ? 'EFICIENCIA' : 'VIDA_UTIL';
      const { resultado } = await this.analises.calcular(tipoAnalise, filtro);
      const r = resultado as any;
      corpo = r;
      if (p.tipo === 'RENTABILIDADE') {
        colunas = ['ranking', 'tipo', 'quantidade', 'pesoTotalKg', 'valorTotal', 'valorMedio', 'valorMedioPorKg'];
        linhas = r.porTipo;
      } else if (p.tipo === 'EFICIENCIA') {
        colunas = ['etapa', 'n', 'mediaHoras', 'medianaHoras', 'desvioPadraoHoras', 'p90Horas'];
        linhas = r.porEtapa;
      } else {
        colunas = ['tipo', 'status', 'amostra', 'inclinacao', 'intercepto', 'r2', 'rmse', 'idadeInservivelEstimada', 'vidaRemanescenteMediaAnos'];
        linhas = r.modelos;
      }
    }

    const base = `greencode-${p.tipo.toLowerCase().replace(/_/g, '-')}-${geradoEm.toISOString().slice(0, 10)}`;
    if (p.formato === 'CSV') {
      return { conteudo: paraCsv(colunas, linhas), nomeArquivo: `${base}.csv`, mime: 'text/csv; charset=utf-8', linhas: linhas.length };
    }
    const json = { relatorio: p.tipo, geradoEm: geradoEm.toISOString(), versaoModelo: VERSAO_MODELO, escopo: { organizacaoId: org }, ...corpo };
    return { conteudo: JSON.stringify(json, null, 2), nomeArquivo: `${base}.json`, mime: 'application/json; charset=utf-8', linhas: linhas.length };
  }
}
