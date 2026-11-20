import { Prisma, TipoAnalise, TipoEquipamento } from '@prisma/client';
import { Db } from '../infra/prisma';
import { paraJson } from '../shared/util';

export interface FiltroDados {
  organizacaoId?: string;
  inicio?: Date;
  fim?: Date;
}

const filtroLote = (f: FiltroDados): Prisma.LoteWhereInput => ({
  ...(f.organizacaoId ? { organizacaoId: f.organizacaoId } : {}),
  ...(f.inicio || f.fim ? { dataEntrada: { ...(f.inicio ? { gte: f.inicio } : {}), ...(f.fim ? { lte: f.fim } : {}) } } : {}),
});

export interface NovoResultado {
  tipo: TipoAnalise;
  origem: 'AGENDADA' | 'MANUAL';
  organizacaoId?: string | null;
  periodoInicio?: Date | null;
  periodoFim?: Date | null;
  versaoModelo: string;
  parametros: unknown;
  resultado: unknown;
  duracaoMs: number;
}

export interface NovaPrevisao {
  tipoEquipamento: TipoEquipamento;
  amostra: number;
  intercepto: number;
  inclinacao: number;
  r2: number;
  rmse: number | null;
  idadeInservivelEstimada: number | null;
  vidaRemanescenteMediaAnos: number | null;
  status: string;
}

export class AnaliseRepository {
  constructor(private readonly db: Db) {}
  com(tx: Db): AnaliseRepository {
    return new AnaliseRepository(tx);
  }

  // ---- dados de entrada dos modelos (somente leitura, so as colunas necessarias) ----
  movimentacoesParaEficiencia(f: FiltroDados) {
    return this.db.movimentacao.findMany({
      where: { equipamento: { lote: filtroLote(f) } },
      select: { equipamentoId: true, destino: true, dataHora: true, responsavel: true, equipamento: { select: { loteId: true } } },
      orderBy: { dataHora: 'asc' },
    });
  }
  lotesParaEficiencia(f: FiltroDados) {
    return this.db.lote.findMany({
      where: filtroLote(f),
      select: { id: true, dataEntrada: true, organizacaoId: true, _count: { select: { equipamentos: true } } },
    });
  }
  equipamentosParaAnalise(f: FiltroDados) {
    return this.db.equipamento.findMany({
      where: { lote: filtroLote(f) },
      select: {
        id: true, codigoBarrasInterno: true, tipo: true, marca: true, modelo: true, anoFabricacao: true,
        estadoFisico: true, pesoQuilogramas: true, statusRastreamento: true, loteId: true,
      },
      orderBy: { sequencia: 'asc' },
    });
  }

  // ---- historico persistido ----
  async salvarResultado(r: NovoResultado, previsoes: NovaPrevisao[] = []) {
    const criado = await this.db.resultadoAnalise.create({
      data: {
        tipo: r.tipo, origem: r.origem, organizacaoId: r.organizacaoId ?? null,
        periodoInicio: r.periodoInicio ?? null, periodoFim: r.periodoFim ?? null,
        versaoModelo: r.versaoModelo, parametros: paraJson(r.parametros), resultado: paraJson(r.resultado), duracaoMs: r.duracaoMs,
      },
    });
    if (previsoes.length) {
      await this.db.previsaoVidaUtil.createMany({ data: previsoes.map((p) => ({ ...p, analiseId: criado.id })) });
    }
    return criado;
  }
  ultimo(tipo: TipoAnalise, organizacaoId: string | null) {
    return this.db.resultadoAnalise.findFirst({ where: { tipo, organizacaoId }, orderBy: { geradoEm: 'desc' } });
  }
  async historico(tipo: TipoAnalise, organizacaoId: string | null, skip: number, take: number) {
    const where = { tipo, organizacaoId };
    const [dados, total] = await Promise.all([
      this.db.resultadoAnalise.findMany({
        where, skip, take, orderBy: { geradoEm: 'desc' },
        select: { id: true, tipo: true, origem: true, organizacaoId: true, versaoModelo: true, duracaoMs: true, geradoEm: true, periodoInicio: true, periodoFim: true },
      }),
      this.db.resultadoAnalise.count({ where }),
    ]);
    return { dados, total };
  }
  porId(id: string) {
    return this.db.resultadoAnalise.findUnique({ where: { id } });
  }
  async previsoes(tipoEquipamento: TipoEquipamento | undefined, skip: number, take: number) {
    const where = tipoEquipamento ? { tipoEquipamento } : {};
    const [dados, total] = await Promise.all([
      this.db.previsaoVidaUtil.findMany({ where, skip, take, orderBy: { geradoEm: 'desc' } }),
      this.db.previsaoVidaUtil.count({ where }),
    ]);
    return { dados, total };
  }

  // ---- valores de referencia (R$/kg) ----
  valoresReferencia() {
    return this.db.valorReferencia.findMany({ orderBy: [{ tipo: 'asc' }, { marca: 'asc' }, { modelo: 'asc' }] });
  }
  salvarValorReferencia(v: { tipo: TipoEquipamento; marca: string; modelo: string; valorPorKg: number }) {
    return this.db.valorReferencia.upsert({
      where: { tipo_marca_modelo: { tipo: v.tipo, marca: v.marca, modelo: v.modelo } },
      create: v,
      update: { valorPorKg: v.valorPorKg },
    });
  }
}
