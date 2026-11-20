import { StatusTarefa, TipoTarefa } from '@prisma/client';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Container } from '../../container';
import { FormatoRelatorio, TipoRelatorio } from '../../services/RelatorioAssincronoService';
import { paginacao } from '../../shared/util';
import { ator, Paginacao } from '../comum';

type Id = { Params: { id: string } };

export class TarefaController {
  constructor(private readonly c: Container) {}

  listar = async (req: FastifyRequest<{ Querystring: Paginacao & { status?: StatusTarefa; tipo?: TipoTarefa } }>) =>
    this.c.tarefas.listar({ status: req.query.status, tipo: req.query.tipo }, paginacao(req.query));

  resumo = async () => this.c.tarefas.resumo();

  obter = async (req: FastifyRequest<Id>) => this.c.tarefas.obter(req.params.id);

  reenfileirar = async (req: FastifyRequest<Id>) => this.c.tarefas.reenfileirar(req.params.id);

  solicitarRelatorio = async (
    req: FastifyRequest<{ Body: { tipo: TipoRelatorio; formato?: FormatoRelatorio; organizacaoId?: string } }>,
    reply: FastifyReply,
  ) => {
    const t = await this.c.relatoriosAssincronos.solicitar(
      { organizacaoId: req.body.organizacaoId ?? null, solicitante: ator(req).usuario },
      { tipo: req.body.tipo, formato: req.body.formato },
    );
    return reply.status(202).send({ tarefaId: t.id, status: t.status, statusUrl: `/api/v1/internal/tarefas/${t.id}`, downloadUrl: `/api/v1/internal/tarefas/${t.id}/download` });
  };

  baixar = async (req: FastifyRequest<Id>, reply: FastifyReply) => {
    const r = await this.c.relatoriosAssincronos.baixar(req.params.id);
    return reply.header('content-type', r.mime).header('content-disposition', `attachment; filename="${r.nomeArquivo}"`).send(r.conteudo);
  };
}
