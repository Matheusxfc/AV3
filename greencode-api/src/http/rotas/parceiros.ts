import { FastifyPluginAsync } from 'fastify';
import { Container } from '../../container';
import { ParceiroController } from '../controllers/ParceiroController';
import { dataStr, idParams, paginacaoProps, PAPEIS, protegido, seguranca, uuid } from '../comum';
import { h } from './helpers';

const escopos = { type: 'string', enum: ['RASTREABILIDADE_LER', 'LOTES_LER', 'LOTES_ESCREVER', 'ANALISES_LER'] };

export const rotasParceiros =
  (c: Container): FastifyPluginAsync =>
  async (app) => {
    const ctrl = new ParceiroController(c);
    const base = protegido(app, PAPEIS.ADMIN);
    const tag = ['Parceiros e chaves de API'];

    app.post('/', {
      ...base,
      schema: {
        tags: tag, summary: 'Cadastra parceiro externo (ADMINISTRADOR)', security: seguranca,
        body: {
          type: 'object', required: ['nome', 'email'], additionalProperties: false,
          properties: {
            nome: { type: 'string', minLength: 2, maxLength: 120 },
            email: { type: 'string', maxLength: 150, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
            organizacaoId: { ...uuid, description: 'Escopo de dados: o parceiro so enxerga/gera dados desta organizacao' },
            acessoGlobal: { type: 'boolean', description: 'Visao de TODAS as organizacoes (conceder com cautela)' },
          },
        },
      },
    }, h(ctrl.criar));

    app.get('/', { ...base, schema: { tags: tag, summary: 'Lista parceiros', security: seguranca, querystring: { type: 'object', properties: paginacaoProps } } }, h(ctrl.listar));

    app.patch('/:id', {
      ...base,
      schema: {
        tags: tag, summary: 'Atualiza parceiro (desativar bloqueia TODAS as suas chaves)', security: seguranca, params: idParams,
        body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { email: { type: 'string', maxLength: 150 }, ativo: { type: 'boolean' }, acessoGlobal: { type: 'boolean' } } },
      },
    }, h(ctrl.atualizar));

    app.post('/:id/chaves', {
      ...base,
      schema: {
        tags: tag, summary: 'Gera chave de API (o segredo aparece UMA unica vez na resposta)', security: seguranca, params: idParams,
        body: {
          type: 'object', required: ['nome', 'escopos'], additionalProperties: false,
          properties: {
            nome: { type: 'string', minLength: 2, maxLength: 80, description: 'Rotulo (ex.: "Integracao ERP producao")' },
            escopos: { type: 'array', minItems: 1, uniqueItems: true, items: escopos },
            limitePorMinuto: { type: 'integer', minimum: 1, maximum: 100000, description: 'Rate limit da chave (padrao 60/min)' },
            expiraEm: dataStr,
          },
        },
      },
    }, h(ctrl.criarChave));

    app.get('/:id/chaves', { ...base, schema: { tags: tag, summary: 'Lista chaves do parceiro (sem segredo)', security: seguranca, params: idParams } }, h(ctrl.listarChaves));

    app.delete('/:id/chaves/:chaveId', {
      ...base,
      schema: {
        tags: tag, summary: 'Revoga a chave imediatamente', security: seguranca,
        params: { type: 'object', required: ['id', 'chaveId'], properties: { id: uuid, chaveId: uuid } },
      },
    }, h(ctrl.revogarChave));
  };
