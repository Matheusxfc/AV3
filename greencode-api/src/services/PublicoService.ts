import { StatusLote, StatusRastreamento, TipoEquipamento } from '@prisma/client';
import { EquipamentoRepository } from '../repositories/EquipamentoRepository';
import { LoteRepository } from '../repositories/LoteRepository';
import { NaoEncontradoError, ProibidoError } from '../shared/errors';
import { Pagina, num, resposta } from '../shared/util';
import { DadosNovoEquipamento } from '../repositories/EquipamentoRepository';
import { LoteService } from './LoteService';
import { ContextoApi } from './ParceiroService';

/**
 * Fachada da API publica. Tres cuidados:
 *  1) ESCOPO DE DADOS: parceiro vinculado a uma organizacao so enxerga/gera dados dela; sem vinculo, so com acessoGlobal.
 *  2) DTOs proprios: a API publica nao expoe campos internos (versao, responsavel interno, journal...).
 *  3) 404 (e nao 403) para recursos de outra organizacao: nao revela que existem.
 */
export class PublicoService {
  constructor(
    private readonly equipamentos: EquipamentoRepository,
    private readonly lotes: LoteRepository,
    private readonly loteService: LoteService,
  ) {}

  /** organizacaoId para filtrar; undefined = sem filtro (somente acessoGlobal). */
  private escopo(ctx: ContextoApi): string | undefined {
    if (ctx.organizacaoId) return ctx.organizacaoId;
    if (ctx.acessoGlobal) return undefined;
    throw new ProibidoError('Parceiro sem organizacao vinculada e sem acesso global.');
  }

  private dtoEquipamento(e: {
    codigoBarrasInterno: string; tipo: TipoEquipamento; marca: string; modelo: string; anoFabricacao: number; estadoFisico: string;
    statusRastreamento: StatusRastreamento; pesoQuilogramas: unknown; loteId: string;
  }) {
    return {
      codigo: e.codigoBarrasInterno, tipo: e.tipo, marca: e.marca, modelo: e.modelo, anoFabricacao: e.anoFabricacao,
      estadoFisico: e.estadoFisico, status: e.statusRastreamento, pesoKg: num(e.pesoQuilogramas as number), loteId: e.loteId,
    };
  }

  async rastrear(codigo: string, ctx: ContextoApi) {
    const org = this.escopo(ctx);
    const e = await this.equipamentos.porCodigoComHistorico(codigo);
    if (!e || (org && e.lote.organizacaoId !== org)) throw new NaoEncontradoError('Equipamento', codigo);
    return {
      ...this.dtoEquipamento(e),
      lote: { id: e.lote.id, notaFiscal: e.lote.notaFiscal, dataEntrada: e.lote.dataEntrada },
      historico: e.movimentacoes.map((m) => ({ dataHora: m.dataHora, origem: m.origem, destino: m.destino, observacao: m.observacao })),
    };
  }

  async listarEquipamentos(ctx: ContextoApi, f: { loteId?: string; status?: StatusRastreamento; tipo?: TipoEquipamento }, p: Pagina) {
    const { dados, total } = await this.equipamentos.listar({ ...f, organizacaoId: this.escopo(ctx) }, p.skip, p.take);
    return resposta(dados.map((e) => this.dtoEquipamento(e)), total, p);
  }

  private dtoLote(l: { id: string; notaFiscal: string; transportadora: string; dataEntrada: Date; statusProcessamento: StatusLote; observacoes: string }, totalEquipamentos?: number) {
    return {
      id: l.id, notaFiscal: l.notaFiscal, transportadora: l.transportadora, dataEntrada: l.dataEntrada,
      status: l.statusProcessamento, observacoes: l.observacoes, ...(totalEquipamentos !== undefined ? { totalEquipamentos } : {}),
    };
  }

  async listarLotes(ctx: ContextoApi, f: { status?: StatusLote; inicio?: Date; fim?: Date }, p: Pagina) {
    const { dados, total } = await this.lotes.listar({ ...f, organizacaoId: this.escopo(ctx) }, p.skip, p.take);
    return resposta(dados.map((l) => this.dtoLote(l, l._count.equipamentos)), total, p);
  }

  async obterLote(id: string, ctx: ContextoApi) {
    const org = this.escopo(ctx);
    const l = await this.lotes.porIdCompleto(id);
    if (!l || (org && l.organizacaoId !== org)) throw new NaoEncontradoError('Lote', id);
    return { ...this.dtoLote(l), equipamentos: l.equipamentos.map((e) => this.dtoEquipamento(e)) };
  }

  /** O parceiro cria lotes SEMPRE na propria organizacao (o corpo nao escolhe a organizacao). */
  async criarLote(
    d: { notaFiscal: string; transportadora: string; dataEntrada?: string; observacoes?: string; equipamentos?: DadosNovoEquipamento[] },
    ctx: ContextoApi,
  ) {
    if (!ctx.organizacaoId) throw new ProibidoError('Somente parceiros vinculados a uma organizacao podem submeter lotes.');
    const criado = await this.loteService.criar({ ...d, organizacaoId: ctx.organizacaoId }, { usuario: `parceiro:${ctx.parceiroNome}` });
    return { ...this.dtoLote(criado), equipamentos: criado.equipamentos.map((e) => this.dtoEquipamento(e)) };
  }
}
