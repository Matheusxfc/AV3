import { TipoEquipamento } from '@prisma/client';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Container } from '../../container';
import { SLUG_ANALISE } from '../../services/AnaliseService';
import { paginacao, parseData } from '../../shared/util';
import { ator, Paginacao } from '../comum';

type Tipo = { Params: { tipo: string } };

export class AnaliseController {
  constructor(private readonly c: Container) {}

  /** Executa a analise. Padrao: sincrono (calcula e persiste). `assincrono: true`: enfileira e devolve 202. */
  executar = async (
    req: FastifyRequest<Tipo & { Body?: { organizacaoId?: string; inicio?: string; fim?: string; assincrono?: boolean } }>,
    reply: FastifyReply,
  ) => {
    const tipo = SLUG_ANALISE[req.params.tipo];
    const b = req.body ?? {};
    if (b.assincrono) {
      const t = await this.c.tarefas.enfileirarAnalise(tipo, { organizacaoId: b.organizacaoId }, 'MANUAL', ator(req).usuario);
      return reply.status(202).send({ tarefaId: t.id, status: t.status, statusUrl: `/api/v1/internal/tarefas/${t.id}` });
    }
    return this.c.analises.executar(
      tipo,
      { organizacaoId: b.organizacaoId, inicio: b.inicio ? parseData(b.inicio, 'inicio') : undefined, fim: b.fim ? parseData(b.fim, 'fim') : undefined },
      'MANUAL',
      ator(req).usuario,
    );
  };

  ultimo = async (req: FastifyRequest<Tipo & { Querystring: { organizacaoId?: string } }>) =>
    this.c.analises.ultimo(SLUG_ANALISE[req.params.tipo], req.query.organizacaoId ?? null);

  historico = async (req: FastifyRequest<Tipo & { Querystring: Paginacao & { organizacaoId?: string } }>) =>
    this.c.analises.historico(SLUG_ANALISE[req.params.tipo], req.query.organizacaoId ?? null, paginacao(req.query));

  resultado = async (req: FastifyRequest<{ Params: { id: string } }>) => this.c.analises.obterResultado(req.params.id);

  modelosVida = async (req: FastifyRequest<{ Querystring: Paginacao & { tipoEquipamento?: TipoEquipamento } }>) =>
    this.c.analises.modelosVida(req.query.tipoEquipamento, paginacao(req.query));

  valores = async () => this.c.analises.valoresReferencia();

  salvarValor = async (req: FastifyRequest<{ Body: { tipo: TipoEquipamento; marca?: string; modelo?: string; valorPorKg: number } }>) =>
    this.c.analises.salvarValorReferencia(req.body, ator(req).usuario);
}
