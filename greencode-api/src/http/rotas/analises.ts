import { FastifyPluginAsync } from 'fastify';
import { Container } from '../../container';
import { TIPOS_ANALISE } from '../../services/AnaliseService';
import { AnaliseController } from '../controllers/AnaliseController';
import { dataStr, eTipo, idParams, paginacaoProps, PAPEIS, protegido, seguranca, uuid } from '../comum';
import { h } from './helpers';

const tipoParams = { type: 'object', required: ['tipo'], properties: { tipo: { type: 'string', enum: TIPOS_ANALISE } } };

export const rotasAnalises =
  (c: Container): FastifyPluginAsync =>
  async (app) => {
    const ctrl = new AnaliseController(c);
    const leitura = protegido(app, PAPEIS.AUDITORIA);
    const admin = protegido(app, PAPEIS.ADMIN);
    const tag = ['Analises'];

    app.post('/:tipo/executar', {
      ...admin,
      schema: {
        tags: tag, security: seguranca, params: tipoParams,
        summary: 'Executa e persiste uma analise (eficiencia | rentabilidade | vida-util). Com "assincrono": true, enfileira (202).',
        body: {
          type: 'object', additionalProperties: false,
          properties: { organizacaoId: uuid, inicio: dataStr, fim: dataStr, assincrono: { type: 'boolean' } },
        },
      },
    }, h(ctrl.executar));

    app.get('/:tipo/ultimo', {
      ...leitura,
      schema: { tags: tag, summary: 'Ultimo resultado persistido (global ou de uma organizacao)', security: seguranca, params: tipoParams, querystring: { type: 'object', properties: { organizacaoId: uuid } } },
    }, h(ctrl.ultimo));

    app.get('/:tipo/historico', {
      ...leitura,
      schema: { tags: tag, summary: 'Historico de execucoes (metadados, paginado)', security: seguranca, params: tipoParams, querystring: { type: 'object', properties: { ...paginacaoProps, organizacaoId: uuid } } },
    }, h(ctrl.historico));

    app.get('/resultados/:id', { ...leitura, schema: { tags: tag, summary: 'Resultado historico completo (para comparar execucoes)', security: seguranca, params: idParams } }, h(ctrl.resultado));

    app.get('/vida-util/modelos', {
      ...leitura,
      schema: { tags: tag, summary: 'Serie historica dos modelos de regressao (inclinacao, R2, RMSE) por tipo', security: seguranca, querystring: { type: 'object', properties: { ...paginacaoProps, tipoEquipamento: eTipo } } },
    }, h(ctrl.modelosVida));

    app.get('/valores-referencia', { ...leitura, schema: { tags: tag, summary: 'Valores de recuperacao (R$/kg) usados na rentabilidade', security: seguranca } }, h(ctrl.valores));

    app.put('/valores-referencia', {
      ...admin,
      schema: {
        tags: tag, summary: 'Cria/atualiza valor de referencia (tipo, ou tipo+marca, ou tipo+marca+modelo)', security: seguranca,
        body: {
          type: 'object', required: ['tipo', 'valorPorKg'], additionalProperties: false,
          properties: { tipo: eTipo, marca: { type: 'string', maxLength: 80 }, modelo: { type: 'string', maxLength: 80 }, valorPorKg: { type: 'number', minimum: 0, maximum: 1000000 } },
        },
      },
    }, h(ctrl.salvarValor));
  };
