import { StatusLote, StatusRastreamento, TipoEquipamento } from '@prisma/client';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Container } from '../../container';
import { DadosNovoEquipamento } from '../../repositories/EquipamentoRepository';
import { FormatoRelatorio, TipoRelatorio } from '../../services/RelatorioAssincronoService';
import { ProibidoError } from '../../shared/errors';
import { paginacao, parseData } from '../../shared/util';
import { Paginacao } from '../comum';

const PUB = '/api/v1/public';
const ctxOf = (req: FastifyRequest) => req.chaveApi!;

export class PublicoController {
  constructor(private readonly c: Container) {}

  eu = async (req: FastifyRequest) => {
    const x = ctxOf(req);
    return { parceiro: x.parceiroNome, organizacaoId: x.organizacaoId, acessoGlobal: x.acessoGlobal, escopos: x.escopos, limitePorMinuto: x.limitePorMinuto };
  };

  rastrear = async (req: FastifyRequest<{ Params: { codigo: string } }>) => this.c.publico.rastrear(req.params.codigo, ctxOf(req));

  listarEquipamentos = async (req: FastifyRequest<{ Querystring: Paginacao & { loteId?: string; status?: StatusRastreamento; tipo?: TipoEquipamento } }>) =>
    this.c.publico.listarEquipamentos(ctxOf(req), { loteId: req.query.loteId, status: req.query.status, tipo: req.query.tipo }, paginacao(req.query));

  listarLotes = async (req: FastifyRequest<{ Querystring: Paginacao & { status?: StatusLote; inicio?: string; fim?: string } }>) =>
    this.c.publico.listarLotes(
      ctxOf(req),
      { status: req.query.status, inicio: req.query.inicio ? parseData(req.query.inicio, 'inicio') : undefined, fim: req.query.fim ? parseData(req.query.fim, 'fim') : undefined },
      paginacao(req.query),
    );

  obterLote = async (req: FastifyRequest<{ Params: { id: string } }>) => this.c.publico.obterLote(req.params.id, ctxOf(req));

  criarLote = async (
    req: FastifyRequest<{ Body: { notaFiscal: string; transportadora: string; dataEntrada?: string; observacoes?: string; equipamentos?: DadosNovoEquipamento[] } }>,
    reply: FastifyReply,
  ) => reply.status(201).send(await this.c.publico.criarLote(req.body, ctxOf(req)));

  // ---- relatorios assincronos ----
  solicitarRelatorio = async (req: FastifyRequest<{ Body: { tipo: TipoRelatorio; formato?: FormatoRelatorio } }>, reply: FastifyReply) => {
    const x = ctxOf(req);
    if (!x.organizacaoId && !x.acessoGlobal) throw new ProibidoError('Parceiro sem organizacao vinculada e sem acesso global.');
    const t = await this.c.relatoriosAssincronos.solicitar(
      { parceiroId: x.parceiroId, chaveApiId: x.chaveId, organizacaoId: x.organizacaoId, solicitante: `parceiro:${x.parceiroNome}` },
      req.body,
    );
    return reply
      .status(202)
      .header('location', `${PUB}/relatorios/${t.id}`)
      .header('retry-after', '2')
      .send({ id: t.id, status: t.status, tipo: req.body.tipo, formato: req.body.formato ?? 'JSON', statusUrl: `${PUB}/relatorios/${t.id}`, expiraEm: t.expiraEm });
  };

  statusRelatorio = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const t = await this.c.relatoriosAssincronos.status(req.params.id, ctxOf(req).parceiroId);
    return {
      id: t.id, status: t.status, tentativas: t.tentativas, maxTentativas: t.maxTentativas, erro: t.status === 'FALHA' ? t.erro : null,
      criadoEm: t.criadoEm, concluidaEm: t.concluidaEm, expiraEm: t.expiraEm,
      downloadUrl: t.status === 'CONCLUIDA' ? `${PUB}/relatorios/${t.id}/download` : null,
    };
  };

  baixarRelatorio = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const r = await this.c.relatoriosAssincronos.baixar(req.params.id, ctxOf(req).parceiroId);
    return reply.header('content-type', r.mime).header('content-disposition', `attachment; filename="${r.nomeArquivo}"`).send(r.conteudo);
  };
}
