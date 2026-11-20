import { PrismaClient, TipoAnalise, TipoEquipamento } from '@prisma/client';
import {
  VERSAO_MODELO, ValorRef, ajustarModelosVida, calcularEficiencia, calcularRentabilidade, resolverValorPorKg,
  valorEstimadoRecuperacao, vidaRemanescenteAnos,
} from '../domain/analise';
import { arred } from '../domain/estatistica';
import { NaoEncontradoError } from '../shared/errors';
import { Pagina, num, resposta } from '../shared/util';
import { AnaliseRepository, FiltroDados, NovaPrevisao } from '../repositories/AnaliseRepository';
import { JournalRepository } from '../repositories/JournalRepository';

/** Slugs de URL -> tipo de analise. */
export const SLUG_ANALISE: Record<string, TipoAnalise> = {
  eficiencia: 'EFICIENCIA',
  rentabilidade: 'RENTABILIDADE',
  'vida-util': 'VIDA_UTIL',
};
export const TIPOS_ANALISE = Object.keys(SLUG_ANALISE);

export class AnaliseService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repo: AnaliseRepository,
    private readonly journal: JournalRepository,
  ) {}

  private async refs(): Promise<ValorRef[]> {
    return (await this.repo.valoresReferencia()).map((r) => ({ tipo: r.tipo, marca: r.marca, modelo: r.modelo, valorPorKg: num(r.valorPorKg) }));
  }

  /** Calcula SEM persistir (usado tambem pelos relatorios assincronos). */
  async calcular(tipo: TipoAnalise, f: FiltroDados): Promise<{ resultado: unknown; previsoes: NovaPrevisao[] }> {
    if (tipo === 'EFICIENCIA') {
      const [movs, lotes] = await Promise.all([this.repo.movimentacoesParaEficiencia(f), this.repo.lotesParaEficiencia(f)]);
      const resultado = calcularEficiencia(
        movs.map((m) => ({ equipamentoId: m.equipamentoId, loteId: m.equipamento.loteId, destino: m.destino, dataHora: m.dataHora, responsavel: m.responsavel })),
        lotes.map((l) => ({ id: l.id, dataEntrada: l.dataEntrada, organizacaoId: l.organizacaoId, totalEquipamentos: l._count.equipamentos })),
      );
      return { resultado, previsoes: [] };
    }

    const equips = await this.repo.equipamentosParaAnalise(f);
    if (tipo === 'RENTABILIDADE') {
      const resultado = calcularRentabilidade(
        equips.map((e) => ({ tipo: e.tipo, marca: e.marca, modelo: e.modelo, estadoFisico: e.estadoFisico, pesoQuilogramas: num(e.pesoQuilogramas) })),
        await this.refs(),
      );
      return { resultado, previsoes: [] };
    }

    // VIDA_UTIL
    const anoReferencia = new Date().getFullYear();
    const modelos = ajustarModelosVida(
      equips.map((e) => ({ tipo: e.tipo, anoFabricacao: e.anoFabricacao, estadoFisico: e.estadoFisico, ativo: e.statusRastreamento !== 'BAIXA_DEFINITIVA' })),
      anoReferencia,
    );
    const previsoes: NovaPrevisao[] = modelos.map((m) => ({
      tipoEquipamento: m.tipo, amostra: m.amostra, intercepto: m.intercepto, inclinacao: m.inclinacao, r2: m.r2, rmse: m.rmse,
      idadeInservivelEstimada: m.idadeInservivelEstimada, vidaRemanescenteMediaAnos: m.vidaRemanescenteMediaAnos, status: m.status,
    }));
    return {
      resultado: {
        anoReferencia,
        metodo: 'Regressao linear OLS: indice de degradacao do estado fisico (0=NOVO..6=INSERVIVEL) x idade em anos, por tipo',
        modelos: modelos.map((m) => ({
          ...m, intercepto: arred(m.intercepto, 4), inclinacao: arred(m.inclinacao, 4), r2: arred(m.r2, 4),
        })),
      },
      previsoes,
    };
  }

  /** Calcula E persiste no historico (resultado + previsoes na mesma transacao). */
  async executar(tipo: TipoAnalise, f: FiltroDados, origem: 'AGENDADA' | 'MANUAL', responsavel = 'SISTEMA') {
    const t0 = Date.now();
    const { resultado, previsoes } = await this.calcular(tipo, f);
    const duracaoMs = Date.now() - t0;

    const salvo = await this.prisma.$transaction(async (tx) => {
      const r = await this.repo.com(tx).salvarResultado(
        {
          tipo, origem, organizacaoId: f.organizacaoId ?? null, periodoInicio: f.inicio ?? null, periodoFim: f.fim ?? null,
          versaoModelo: VERSAO_MODELO, parametros: { organizacaoId: f.organizacaoId ?? null, inicio: f.inicio ?? null, fim: f.fim ?? null }, resultado, duracaoMs,
        },
        previsoes,
      );
      await this.journal.com(tx).registrar({
        operacao: 'CREATE', entidade: 'ResultadoAnalise', entidadeId: r.id,
        dadosDepois: { tipo, origem, organizacaoId: f.organizacaoId ?? null, duracaoMs }, usuarioResponsavel: responsavel,
      });
      return r;
    });
    return salvo;
  }

  async ultimo(tipo: TipoAnalise, organizacaoId: string | null) {
    const r = await this.repo.ultimo(tipo, organizacaoId);
    if (!r) throw new NaoEncontradoError(`Resultado de analise ${tipo} (execute POST .../executar antes)`, organizacaoId ?? 'global');
    return r;
  }

  async historico(tipo: TipoAnalise, organizacaoId: string | null, p: Pagina) {
    const { dados, total } = await this.repo.historico(tipo, organizacaoId, p.skip, p.take);
    return resposta(dados, total, p);
  }

  async obterResultado(id: string) {
    const r = await this.repo.porId(id);
    if (!r) throw new NaoEncontradoError('Resultado de analise', id);
    return r;
  }

  async modelosVida(tipoEquipamento: TipoEquipamento | undefined, p: Pagina) {
    const { dados, total } = await this.repo.previsoes(tipoEquipamento, p.skip, p.take);
    return resposta(dados, total, p);
  }

  async valoresReferencia() {
    return (await this.repo.valoresReferencia()).map((v) => ({ ...v, valorPorKg: num(v.valorPorKg) }));
  }

  async salvarValorReferencia(v: { tipo: TipoEquipamento; marca?: string; modelo?: string; valorPorKg: number }, responsavel: string) {
    const dados = { tipo: v.tipo, marca: (v.marca ?? '').trim(), modelo: (v.modelo ?? '').trim(), valorPorKg: v.valorPorKg };
    if (dados.modelo && !dados.marca) dados.marca = ''; // modelo sem marca nao faz sentido; trata como "tipo"
    const salvo = await this.prisma.$transaction(async (tx) => {
      const s = await this.repo.com(tx).salvarValorReferencia(dados);
      await this.journal.com(tx).registrar({ operacao: 'UPDATE', entidade: 'ValorReferencia', entidadeId: s.id, dadosDepois: dados, usuarioResponsavel: responsavel });
      return s;
    });
    return { ...salvo, valorPorKg: num(salvo.valorPorKg) };
  }

  /**
   * Relatorio preditivo por equipamento ATIVO. O modelo e ajustado com TODO o parque
   * (mais amostras = previsao mais estavel) e aplicado apenas aos equipamentos do escopo.
   */
  async relatorioPreditivoEquipamentos(organizacaoId: string | null) {
    const anoRef = new Date().getFullYear();
    const todos = await this.repo.equipamentosParaAnalise({});
    const modelos = ajustarModelosVida(
      todos.map((e) => ({ tipo: e.tipo, anoFabricacao: e.anoFabricacao, estadoFisico: e.estadoFisico, ativo: e.statusRastreamento !== 'BAIXA_DEFINITIVA' })),
      anoRef,
    );
    const modeloDe = new Map(modelos.map((m) => [m.tipo, m]));
    const escopo = organizacaoId ? await this.repo.equipamentosParaAnalise({ organizacaoId }) : todos;
    const refs = await this.refs();

    const linhas = escopo
      .filter((e) => e.statusRastreamento !== 'BAIXA_DEFINITIVA')
      .map((e) => {
        const m = modeloDe.get(e.tipo);
        const vida = m && m.status === 'OK' ? vidaRemanescenteAnos(m.inclinacao, e.estadoFisico) : NaN;
        const { valorPorKg } = resolverValorPorKg(refs, e.tipo, e.marca, e.modelo);
        return {
          codigoBarrasInterno: e.codigoBarrasInterno, tipo: e.tipo, marca: e.marca, modelo: e.modelo, anoFabricacao: e.anoFabricacao,
          idadeAnos: Math.max(0, anoRef - e.anoFabricacao), estadoFisico: e.estadoFisico, statusRastreamento: e.statusRastreamento,
          pesoKg: num(e.pesoQuilogramas),
          valorEstimadoRecuperacao: arred(valorEstimadoRecuperacao(num(e.pesoQuilogramas), valorPorKg, e.estadoFisico)),
          vidaRemanescenteAnos: arred(vida),
          anoEstimadoInservivel: Number.isFinite(vida) ? arred(anoRef + vida, 1) : null,
          confiancaModelo: m?.status === 'OK' ? arred(m.r2, 2) : null,
        };
      });
    return {
      linhas,
      resumo: {
        equipamentosAtivos: linhas.length,
        valorTotalEstimado: arred(linhas.reduce((s, l) => s + (l.valorEstimadoRecuperacao ?? 0), 0)),
        semPrevisao: linhas.filter((l) => l.vidaRemanescenteAnos === null).length,
      },
    };
  }
}
