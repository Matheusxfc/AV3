import { FastifyPluginAsync } from 'fastify';
import { Container } from '../../container';
import { TIPOS_RELATORIO } from '../../services/RelatorioAssincronoService';
import { TarefaController } from '../controllers/TarefaController';
import { idParams, paginacaoProps, PAPEIS, protegido, seguranca, uuid } from '../comum';
import { h } from './helpers';

export const rotasTarefas =
  (c: Container): FastifyPluginAsync =>
  async (app) => {
    const ctrl = new TarefaController(c);
    const admin = protegido(app, PAPEIS.ADMIN);
    const auditoria = protegido(app, PAPEIS.AUDITORIA);
    const tag = ['Fila de tarefas'];

    app.get('/', {
      ...admin,
      schema: {
        tags: tag, summary: 'Lista tarefas da fila', security: seguranca,
        querystring: {
          type: 'object',
          properties: {
            ...paginacaoProps,
            status: { type: 'string', enum: ['PENDENTE', 'EM_EXECUCAO', 'CONCLUIDA', 'FALHA'] },
            tipo: { type: 'string', enum: ['EXECUTAR_ANALISE', 'GERAR_RELATORIO'] },
          },
        },
      },
    }, h(ctrl.listar));

    app.get('/resumo', { ...admin, schema: { tags: tag, summary: 'Contagem de tarefas por status (monitoramento da fila)', security: seguranca } }, h(ctrl.resumo));
    app.get('/:id', { ...admin, schema: { tags: tag, summary: 'Detalha tarefa (tentativas, erro, proxima execucao)', security: seguranca, params: idParams } }, h(ctrl.obter));
    app.post('/:id/reenfileirar', { ...admin, schema: { tags: tag, summary: 'Recoloca na fila uma tarefa em FALHA (zera tentativas)', security: seguranca, params: idParams } }, h(ctrl.reenfileirar));

    app.post('/relatorios', {
      ...auditoria,
      schema: {
        tags: tag, summary: 'Solicita relatorio assincrono (202). Sem organizacaoId = global.', security: seguranca,
        body: {
          type: 'object', required: ['tipo'], additionalProperties: false,
          properties: { tipo: { type: 'string', enum: TIPOS_RELATORIO }, formato: { type: 'string', enum: ['JSON', 'CSV'] }, organizacaoId: uuid },
        },
      },
    }, h(ctrl.solicitarRelatorio));

    app.get('/:id/download', { ...auditoria, schema: { tags: tag, summary: 'Baixa o arquivo do relatorio concluido', security: seguranca, params: idParams } }, h(ctrl.baixar));
  };
