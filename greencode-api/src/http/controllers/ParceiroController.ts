import { EscopoApi } from '@prisma/client';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Container } from '../../container';
import { paginacao } from '../../shared/util';
import { ator, Paginacao } from '../comum';

export class ParceiroController {
  constructor(private readonly c: Container) {}

  criar = async (req: FastifyRequest<{ Body: { nome: string; email: string; organizacaoId?: string; acessoGlobal?: boolean } }>, reply: FastifyReply) =>
    reply.status(201).send(await this.c.parceiros.criarParceiro(req.body, ator(req)));

  listar = async (req: FastifyRequest<{ Querystring: Paginacao }>) => this.c.parceiros.listar(paginacao(req.query));

  atualizar = async (req: FastifyRequest<{ Params: { id: string }; Body: { email?: string; ativo?: boolean; acessoGlobal?: boolean } }>) =>
    this.c.parceiros.atualizar(req.params.id, req.body, ator(req));

  criarChave = async (
    req: FastifyRequest<{ Params: { id: string }; Body: { nome: string; escopos: EscopoApi[]; limitePorMinuto?: number; expiraEm?: string } }>,
    reply: FastifyReply,
  ) => reply.status(201).send(await this.c.parceiros.criarChave(req.params.id, req.body, ator(req)));

  listarChaves = async (req: FastifyRequest<{ Params: { id: string } }>) => this.c.parceiros.listarChaves(req.params.id);

  revogarChave = async (req: FastifyRequest<{ Params: { id: string; chaveId: string } }>, reply: FastifyReply) => {
    await this.c.parceiros.revogarChave(req.params.id, req.params.chaveId, ator(req));
    return reply.status(204).send();
  };
}
