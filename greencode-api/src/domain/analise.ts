import { EstadoFisico, StatusRastreamento, TipoEquipamento } from './enums';
import { ORDEM_ESTADO } from './regras';
import {
  arred, desvioPadrao, media, mediana, percentil, regressaoLinear, rmse, suavizacaoExponencial,
} from './estatistica';

/** Versao do modelo analitico (gravada em cada resultado; permite comparar execucoes entre versoes). */
export const VERSAO_MODELO = '1.0.0';

// =====================================================================================
// 1) RENTABILIDADE POR TIPO DE EQUIPAMENTO
// =====================================================================================

/**
 * Fator de recuperacao por estado fisico (fracao do valor-base de materiais que se espera recuperar).
 * PREMISSA de negocio, ilustrativa: calibrar com dados reais de venda de materiais secundarios.
 */
export const FATOR_ESTADO: Record<EstadoFisico, number> = {
  NOVO: 1.0,
  BOM_ESTADO: 0.85,
  USADO_LEVE: 0.7,
  USADO_MODERADO: 0.5,
  DANIFICADO_LEVE: 0.35,
  DANIFICADO_GRAVE: 0.2,
  INSERVIVEL: 0.1,
};

/** Valor-base padrao de materiais recuperaveis (R$/kg) por tipo. ILUSTRATIVO; sobrescrevivel em valores_referencia. */
export const VALOR_REFERENCIA_PADRAO: Record<TipoEquipamento, number> = {
  COMPUTADOR_MESA: 18,
  NOTEBOOK: 35,
  MONITOR: 12,
  IMPRESSORA: 8,
  SERVIDOR: 40,
  ROTEADOR: 28,
  CABO_ESTRUTURADO: 25,
  FONTE_ALIMENTACAO: 22,
};

export interface ValorRef {
  tipo: TipoEquipamento;
  marca: string; // '' = qualquer
  modelo: string; // '' = qualquer
  valorPorKg: number;
}

export type OrigemValor = 'MODELO' | 'MARCA' | 'TIPO' | 'PADRAO';

const igual = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Precedencia: (tipo+marca+modelo) > (tipo+marca) > (tipo) > padrao. */
export function resolverValorPorKg(
  refs: ValorRef[], tipo: TipoEquipamento, marca: string, modelo: string,
): { valorPorKg: number; origem: OrigemValor } {
  const doTipo = refs.filter((r) => r.tipo === tipo);
  const m = doTipo.find((r) => r.marca && r.modelo && igual(r.marca, marca) && igual(r.modelo, modelo));
  if (m) return { valorPorKg: m.valorPorKg, origem: 'MODELO' };
  const b = doTipo.find((r) => r.marca && !r.modelo && igual(r.marca, marca));
  if (b) return { valorPorKg: b.valorPorKg, origem: 'MARCA' };
  const t = doTipo.find((r) => !r.marca && !r.modelo);
  if (t) return { valorPorKg: t.valorPorKg, origem: 'TIPO' };
  return { valorPorKg: VALOR_REFERENCIA_PADRAO[tipo], origem: 'PADRAO' };
}

export function valorEstimadoRecuperacao(pesoKg: number, valorPorKg: number, estado: EstadoFisico): number {
  return pesoKg * valorPorKg * FATOR_ESTADO[estado];
}

export interface EquipRentabilidade {
  tipo: TipoEquipamento;
  marca: string;
  modelo: string;
  estadoFisico: EstadoFisico;
  pesoQuilogramas: number;
}

function agrupar<T>(itens: T[], chave: (i: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of itens) {
    const k = chave(i);
    const lista = m.get(k);
    if (lista) lista.push(i);
    else m.set(k, [i]);
  }
  return m;
}

export function calcularRentabilidade(equips: EquipRentabilidade[], refs: ValorRef[]) {
  const linhas = equips.map((e) => {
    const { valorPorKg, origem } = resolverValorPorKg(refs, e.tipo, e.marca, e.modelo);
    return { ...e, valorPorKg, origemValor: origem, valor: valorEstimadoRecuperacao(e.pesoQuilogramas, valorPorKg, e.estadoFisico) };
  });
  const valores = linhas.map((l) => l.valor);

  const porTipo = [...agrupar(linhas, (l) => l.tipo).entries()]
    .map(([tipo, ls]) => {
      const peso = ls.reduce((s, l) => s + l.pesoQuilogramas, 0);
      const total = ls.reduce((s, l) => s + l.valor, 0);
      return {
        tipo, quantidade: ls.length, pesoTotalKg: arred(peso, 3), valorTotal: arred(total),
        valorMedio: arred(total / ls.length), valorMedioPorKg: arred(peso > 0 ? total / peso : NaN),
      };
    })
    .sort((a, b) => (b.valorMedio ?? 0) - (a.valorMedio ?? 0))
    .map((x, i) => ({ ranking: i + 1, ...x }));

  const porEstado = ORDEM_ESTADO.map((estado) => {
    const ls = linhas.filter((l) => l.estadoFisico === estado);
    return { estado, fatorRecuperacao: FATOR_ESTADO[estado], quantidade: ls.length, valorMedio: arred(media(ls.map((l) => l.valor))) };
  }).filter((x) => x.quantidade > 0);

  const porMarcaModelo = [...agrupar(linhas, (l) => `${l.marca}|${l.modelo}`).entries()]
    .map(([k, ls]) => {
      const [marca, modelo] = k.split('|');
      return { marca, modelo, tipo: ls[0].tipo, quantidade: ls.length, valorMedio: arred(media(ls.map((l) => l.valor))) };
    })
    .sort((a, b) => (b.valorMedio ?? 0) - (a.valorMedio ?? 0))
    .slice(0, 10);

  return {
    totalEquipamentos: linhas.length,
    valorTotalEstimado: arred(valores.reduce((s, v) => s + v, 0)),
    valorMedioPorEquipamento: arred(media(valores)),
    porTipo,
    porEstado,
    topMarcaModelo: porMarcaModelo,
    priorizacao: porTipo.slice(0, 3).map((t) => t.tipo),
    premissas: 'Valor = peso(kg) x valor/kg(tipo/marca/modelo) x fator do estado fisico. Valores ilustrativos: calibrar em valores_referencia.',
  };
}

// =====================================================================================
// 2) EFICIENCIA OPERACIONAL
// =====================================================================================

export interface MovAnalise {
  equipamentoId: string;
  loteId: string;
  destino: string;
  dataHora: Date;
  responsavel: string;
}
export interface LoteAnalise {
  id: string;
  dataEntrada: Date;
  organizacaoId: string;
  totalEquipamentos: number;
}

const STATUS_VALIDOS = new Set<string>(Object.values(StatusRastreamento));
const ESTADOS_FIM_TRIAGEM = new Set<string>(['AGUARDANDO_DESMONTE', 'DESCARTE_SEGURO']);

/** O destino da movimentacao pode ser um status puro ou "RECEBIMENTO (STATUS)"; textos livres nao contam. */
export function extrairStatus(destino: string): StatusRastreamento | null {
  const d = destino.trim();
  if (STATUS_VALIDOS.has(d)) return d as StatusRastreamento;
  const m = /^RECEBIMENTO \(([A-Z_]+)\)$/.exec(d);
  return m && STATUS_VALIDOS.has(m[1]) ? (m[1] as StatusRastreamento) : null;
}

const horas = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;
const mesUTC = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

function resumo(v: number[]) {
  return {
    n: v.length, mediaHoras: arred(media(v)), medianaHoras: arred(mediana(v)),
    desvioPadraoHoras: arred(desvioPadrao(v)), p90Horas: arred(percentil(v, 90)),
  };
}

interface EventoStatus { status: StatusRastreamento; em: Date; responsavel: string }

export function calcularEficiencia(movs: MovAnalise[], lotes: LoteAnalise[]) {
  // 1) linha do tempo de status por equipamento
  const porEquip = agrupar([...movs].sort((a, b) => a.dataHora.getTime() - b.dataHora.getTime()), (m) => m.equipamentoId);
  const linhas = new Map<string, { loteId: string; eventos: EventoStatus[] }>();
  for (const [id, ms] of porEquip) {
    const eventos: EventoStatus[] = [];
    for (const m of ms) {
      const st = extrairStatus(m.destino);
      if (!st || eventos[eventos.length - 1]?.status === st) continue;
      eventos.push({ status: st, em: m.dataHora, responsavel: m.responsavel });
    }
    linhas.set(id, { loteId: ms[0].loteId, eventos });
  }

  // 2) duracao em cada etapa (entre entrar na etapa e entrar na proxima)
  const duracaoPorEtapa = new Map<StatusRastreamento, number[]>();
  const triagemPorOperador = new Map<string, number[]>();
  for (const { eventos } of linhas.values()) {
    for (let i = 0; i + 1 < eventos.length; i++) {
      const h = horas(eventos[i].em, eventos[i + 1].em);
      const lista = duracaoPorEtapa.get(eventos[i].status) ?? [];
      lista.push(h);
      duracaoPorEtapa.set(eventos[i].status, lista);
      if (eventos[i].status === 'EM_TRIAGEM') {
        const op = eventos[i + 1].responsavel; // quem concluiu a triagem
        const l = triagemPorOperador.get(op) ?? [];
        l.push(h);
        triagemPorOperador.set(op, l);
      }
    }
  }
  const porEtapa = [...duracaoPorEtapa.entries()].map(([etapa, v]) => ({ etapa, ...resumo(v) }));
  const gargalo = [...porEtapa].sort((a, b) => (b.mediaHoras ?? 0) - (a.mediaHoras ?? 0))[0] ?? null;

  // 3) tempo por operador (triagem)
  const todasTriagens = [...triagemPorOperador.values()].flat();
  const mediaGlobalTriagem = media(todasTriagens);
  const porOperador = [...triagemPorOperador.entries()]
    .map(([operador, v]) => ({
      operador, ...resumo(v),
      indiceEficiencia: arred(mediaGlobalTriagem / media(v)), // >1 = mais rapido que a media geral
    }))
    .sort((a, b) => (a.mediaHoras ?? 0) - (b.mediaHoras ?? 0));

  // 4) tempo total por lote: entrada -> conclusao da triagem (ultimo equipamento sair da triagem)
  const loteInfo = new Map(lotes.map((l) => [l.id, l]));
  const fimPorLote = new Map<string, { concluidos: number; fim: Date }>();
  for (const { loteId, eventos } of linhas.values()) {
    const fimTriagem = eventos.find((e, i) => i > 0 && ESTADOS_FIM_TRIAGEM.has(e.status) && eventos.slice(0, i).some((x) => x.status === 'EM_TRIAGEM'));
    if (!fimTriagem) continue;
    const atual = fimPorLote.get(loteId);
    fimPorLote.set(loteId, {
      concluidos: (atual?.concluidos ?? 0) + 1,
      fim: !atual || fimTriagem.em > atual.fim ? fimTriagem.em : atual.fim,
    });
  }
  const tempoPorLote: { loteId: string; mes: string; horas: number }[] = [];
  for (const [loteId, f] of fimPorLote) {
    const lote = loteInfo.get(loteId);
    if (lote && f.concluidos >= lote.totalEquipamentos && lote.totalEquipamentos > 0) {
      tempoPorLote.push({ loteId, mes: mesUTC(lote.dataEntrada), horas: horas(lote.dataEntrada, f.fim) });
    }
  }

  // 5) variacao por mes + tendencia (suavizacao exponencial)
  const porMes = [...agrupar(tempoPorLote, (l) => l.mes).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, ls]) => ({ mes, lotes: ls.length, mediaHoras: arred(media(ls.map((l) => l.horas))) }));
  const ses = suavizacaoExponencial(porMes.map((m) => m.mediaHoras ?? 0), 0.5);
  const valoresLote = tempoPorLote.map((l) => l.horas);

  return {
    lotesAnalisados: tempoPorLote.length,
    lotesSemTriagemConcluida: Math.max(0, lotes.length - tempoPorLote.length),
    tempoEntradaAteTriagemConcluida: resumo(valoresLote),
    porEtapa,
    gargalo: gargalo ? { etapa: gargalo.etapa, mediaHoras: gargalo.mediaHoras } : null,
    porOperador,
    porMes,
    tendencia: ses ? { metodo: 'suavizacao exponencial simples (alfa=0,5)', previsaoProximoMesHoras: arred(ses.previsao) } : null,
  };
}

// =====================================================================================
// 3) VIDA UTIL REMANESCENTE (regressao OLS por tipo de equipamento)
// =====================================================================================

/** Indice de degradacao: posicao do estado fisico na escala (0 = NOVO ... 6 = INSERVIVEL). */
export const indiceEstado = (e: EstadoFisico): number => ORDEM_ESTADO.indexOf(e);
const IDX_INSERVIVEL = ORDEM_ESTADO.length - 1;

export interface EquipVida {
  tipo: TipoEquipamento;
  anoFabricacao: number;
  estadoFisico: EstadoFisico;
  /** false para equipamentos com baixa definitiva (nao entram na vida remanescente media). */
  ativo: boolean;
}

export type StatusModelo = 'OK' | 'DADOS_INSUFICIENTES' | 'SEM_DEGRADACAO';

export interface ModeloVida {
  tipo: TipoEquipamento;
  status: StatusModelo;
  amostra: number;
  intercepto: number;
  inclinacao: number; // categorias de estado perdidas por ano
  r2: number;
  rmse: number | null;
  idadeInservivelEstimada: number | null; // anos
  vidaRemanescenteMediaAnos: number | null; // equipamentos ativos
}

const MIN_AMOSTRA = 5;
const MIN_AMOSTRA_HOLDOUT = 8;

/**
 * Modelo: indice_de_degradacao = a + b * idade_em_anos, ajustado por OLS para cada tipo,
 * usando o parque de equipamentos (corte transversal: estado fisico x idade).
 * Idade estimada ate INSERVIVEL: (6 - a) / b.  Vida remanescente de um equipamento: (6 - indice atual) / b.
 * Qualidade: R2 e RMSE em amostra reservada (1 a cada 4 observacoes) quando n >= 8.
 */
export function ajustarModelosVida(equips: EquipVida[], anoRef = new Date().getFullYear()): ModeloVida[] {
  const porTipo = agrupar(equips, (e) => e.tipo);
  const modelos: ModeloVida[] = [];
  for (const [tipo, es] of porTipo) {
    const x = es.map((e) => Math.max(0, anoRef - e.anoFabricacao));
    const y = es.map((e) => indiceEstado(e.estadoFisico));
    const vazio: ModeloVida = {
      tipo: tipo as TipoEquipamento, status: 'DADOS_INSUFICIENTES', amostra: es.length, intercepto: 0, inclinacao: 0, r2: 0,
      rmse: null, idadeInservivelEstimada: null, vidaRemanescenteMediaAnos: null,
    };
    const reg = es.length >= MIN_AMOSTRA ? regressaoLinear(x, y) : null;
    if (!reg) { modelos.push(vazio); continue; }
    if (reg.inclinacao <= 0.001) {
      modelos.push({ ...vazio, status: 'SEM_DEGRADACAO', intercepto: reg.intercepto, inclinacao: reg.inclinacao, r2: reg.r2 });
      continue;
    }

    let erro: number | null = null;
    if (es.length >= MIN_AMOSTRA_HOLDOUT) {
      const treino = x.map((_, i) => i).filter((i) => i % 4 !== 3);
      const teste = x.map((_, i) => i).filter((i) => i % 4 === 3);
      const r = regressaoLinear(treino.map((i) => x[i]), treino.map((i) => y[i]));
      if (r) erro = arred(rmse(teste.map((i) => y[i]), teste.map((i) => r.intercepto + r.inclinacao * x[i])), 4);
    }

    const ativos = es.filter((e) => e.ativo);
    const restantes = ativos.map((e) => vidaRemanescenteAnos(reg.inclinacao, e.estadoFisico));
    modelos.push({
      tipo: tipo as TipoEquipamento, status: 'OK', amostra: reg.n,
      intercepto: reg.intercepto, inclinacao: reg.inclinacao, r2: reg.r2, rmse: erro,
      idadeInservivelEstimada: arred((IDX_INSERVIVEL - reg.intercepto) / reg.inclinacao),
      vidaRemanescenteMediaAnos: restantes.length ? arred(media(restantes)) : null,
    });
  }
  return modelos.sort((a, b) => a.tipo.localeCompare(b.tipo));
}

/** Anos ate o equipamento atingir INSERVIVEL, mantida a taxa de degradacao do tipo. */
export function vidaRemanescenteAnos(inclinacao: number, estadoAtual: EstadoFisico): number {
  if (inclinacao <= 0.001) return NaN;
  return Math.max(0, (IDX_INSERVIVEL - indiceEstado(estadoAtual)) / inclinacao);
}
