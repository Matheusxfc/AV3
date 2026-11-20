import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { FastifyPluginAsync } from 'fastify';
import { Container } from '../../container';
import { exigirEscopo, hookChaveApi, limitePorChave } from '../../plugins/apiKey';
import { TIPOS_RELATORIO } from '../../services/RelatorioAssincronoService';
import { PublicoController } from '../controllers/PublicoController';
import { dataStr, eEstado, eStatusLote, eStatusRastreamento, eTipo, idParams, paginacaoProps, uuid } from '../comum';
import { h } from './helpers';

const seg = [{ apiKeyAuth: [] }];
const ERROS =
  '\n\n**Erros possiveis:** `401 NAO_AUTENTICADO` (chave ausente/invalida/revogada/expirada) · `403 PROIBIDO` (escopo insuficiente) · ' +
  '`404 NAO_ENCONTRADO` · `429 LIMITE_EXCEDIDO` (rate limit da chave) · `400 VALIDACAO_FALHOU` · `409 CONFLITO` · `422 REGRA_DE_NEGOCIO`.';

const equipamentoNovo = {
  type: 'object', required: ['tipo', 'marca', 'modelo', 'anoFabricacao', 'estadoFisico', 'pesoQuilogramas'], additionalProperties: false,
  properties: {
    tipo: eTipo, marca: { type: 'string', minLength: 1, maxLength: 80 }, modelo: { type: 'string', minLength: 1, maxLength: 80 },
    anoFabricacao: { type: 'integer', minimum: 1970, maximum: 2100 }, estadoFisico: eEstado, pesoQuilogramas: { type: 'number', exclusiveMinimum: 0, maximum: 100000 },
  },
};

/**
 * API PUBLICA v1 (parceiros). Estrutura de escopos do Fastify:
 *   publica (sem auth)  -> documentacao Swagger em /docs
 *     └─ autenticada    -> hook de chave de API + rotas (cada rota com escopo e rate limit por chave)
 */
export const rotasPublicas =
  (c: Container): FastifyPluginAsync =>
  async (pub) => {
    await pub.register(swagger, {
      openapi: {
        openapi: '3.0.3',
        info: {
          title: 'greencode - API Publica',
          version: '1.0.0',
          description:
            'API para integracao de parceiros com a plataforma de logistica reversa greencode.\n\n' +
            '## Autenticacao\nEnvie sua chave no cabecalho `x-api-key: gck_xxxxxxxxxx_...`. A chave e entregue uma unica vez pelo administrador; ' +
            'cada chave tem **escopos** (o que pode fazer) e um **limite de requisicoes por minuto**.\n\n' +
            '## Escopos\n`RASTREABILIDADE_LER` · `LOTES_LER` · `LOTES_ESCREVER` · `ANALISES_LER`\n\n' +
            '## Limites de taxa\nCada resposta traz `x-ratelimit-limit`, `x-ratelimit-remaining` e `x-ratelimit-reset`. Ao exceder: `429` com `retry-after`.\n\n' +
            '## Versionamento\nA versao esta na URL (`/api/v1/public`). Mudancas incompativeis geram `/api/v2`; a v1 segue ativa durante o periodo de depreciacao anunciado.\n\n' +
            '## Relatorios assincronos\n`POST /relatorios` -> `202` + `id`; consulte `GET /relatorios/{id}` (polling a cada 2-5 s) ate `CONCLUIDA`; entao `GET /relatorios/{id}/download`.\n\n' +
            '## Formato de erro\n`{ "statusCode": 404, "erro": "NAO_ENCONTRADO", "mensagem": "...", "detalhes": [...] }`',
        },
        tags: [
          { name: 'Conta', description: 'Informacoes da chave em uso' },
          { name: 'Rastreabilidade', description: 'Status e historico de equipamentos' },
          { name: 'Lotes', description: 'Consulta e submissao de lotes' },
          { name: 'Relatorios', description: 'Relatorios analiticos assincronos' },
        ],
        components: { securitySchemes: { apiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' } } },
      },
    });
    await pub.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list' } });

    // ---- rotas autenticadas por chave de API ----
    await pub.register(async (api) => {
      api.decorateRequest('chaveApi', null);
      api.addHook('onRequest', hookChaveApi(c.parceiros)); // roda ANTES do rate limit (hooks do escopo vem antes dos da rota)
      const ctrl = new PublicoController(c);
      const limite = limitePorChave();

      api.get('/me', {
        config: limite,
        schema: { tags: ['Conta'], summary: 'Dados da chave em uso (parceiro, escopos, limite)', security: seg, description: `Util para testar a autenticacao.${ERROS}` },
      }, h(ctrl.eu));

      api.get('/rastreabilidade/:codigo', {
        config: limite, preHandler: [exigirEscopo('RASTREABILIDADE_LER')],
        schema: {
          tags: ['Rastreabilidade'], summary: 'Status e historico de um equipamento pelo codigo de barras', security: seg,
          description: `Escopo: \`RASTREABILIDADE_LER\`. Exemplo: \`/rastreabilidade/NTB-2026-000042\`.${ERROS}`,
          params: { type: 'object', required: ['codigo'], properties: { codigo: { type: 'string', minLength: 3, maxLength: 40, description: 'codigoBarrasInterno, ex.: NTB-2026-000042' } } },
        },
      }, h(ctrl.rastrear));

      api.get('/equipamentos', {
        config: limite, preHandler: [exigirEscopo('RASTREABILIDADE_LER')],
        schema: {
          tags: ['Rastreabilidade'], summary: 'Lista equipamentos (filtros: lote, status, tipo)', security: seg,
          description: `Escopo: \`RASTREABILIDADE_LER\`. Paginado.${ERROS}`,
          querystring: { type: 'object', properties: { ...paginacaoProps, loteId: uuid, status: eStatusRastreamento, tipo: eTipo } },
        },
      }, h(ctrl.listarEquipamentos));

      api.get('/lotes', {
        config: limite, preHandler: [exigirEscopo('LOTES_LER', 'LOTES_ESCREVER')],
        schema: {
          tags: ['Lotes'], summary: 'Lista lotes (filtros: status, periodo)', security: seg,
          description: `Escopo: \`LOTES_LER\` (ou \`LOTES_ESCREVER\`).${ERROS}`,
          querystring: { type: 'object', properties: { ...paginacaoProps, status: eStatusLote, inicio: dataStr, fim: dataStr } },
        },
      }, h(ctrl.listarLotes));

      api.get('/lotes/:id', {
        config: limite, preHandler: [exigirEscopo('LOTES_LER', 'LOTES_ESCREVER')],
        schema: { tags: ['Lotes'], summary: 'Detalha um lote (com equipamentos)', security: seg, description: `Escopo: \`LOTES_LER\`.${ERROS}`, params: idParams },
      }, h(ctrl.obterLote));

      api.post('/lotes', {
        config: limite, preHandler: [exigirEscopo('LOTES_ESCREVER')],
        schema: {
          tags: ['Lotes'], summary: 'Submete um novo lote (opcionalmente ja com equipamentos)', security: seg,
          description:
            'Escopo: `LOTES_ESCREVER`. O lote e criado **na organizacao vinculada a sua chave**. ' +
            '`dataEntrada` (opcional, padrao agora) nao pode ser futura nem anterior a 90 dias (`422`). ' +
            'A nota fiscal e unica por organizacao (`409` em duplicidade, o que torna o reenvio seguro).' + ERROS,
          body: {
            type: 'object', required: ['notaFiscal', 'transportadora'], additionalProperties: false,
            example: {
              notaFiscal: 'NF-2026-0042', transportadora: 'TransRapida', dataEntrada: '2026-11-10',
              equipamentos: [{ tipo: 'NOTEBOOK', marca: 'Dell', modelo: 'Latitude 5400', anoFabricacao: 2019, estadoFisico: 'BOM_ESTADO', pesoQuilogramas: 2.1 }],
            },
            properties: {
              notaFiscal: { type: 'string', minLength: 1, maxLength: 60 }, transportadora: { type: 'string', minLength: 1, maxLength: 120 },
              dataEntrada: dataStr, observacoes: { type: 'string', maxLength: 1000 },
              equipamentos: { type: 'array', maxItems: 500, items: equipamentoNovo },
            },
          },
        },
      }, h(ctrl.criarLote));

      api.post('/relatorios', {
        config: limite, preHandler: [exigirEscopo('ANALISES_LER')],
        schema: {
          tags: ['Relatorios'], summary: 'Solicita um relatorio analitico (processamento assincrono)', security: seg,
          description:
            'Escopo: `ANALISES_LER`. Retorna **202** imediatamente com o `id` da tarefa (e o cabecalho `Location`). Tipos: ' +
            '`EQUIPAMENTOS_PREDITIVO` (todos os equipamentos ativos: valor estimado de recuperacao e vida util remanescente), ' +
            '`RENTABILIDADE`, `EFICIENCIA`, `VIDA_UTIL`. Formatos: `JSON` (padrao) ou `CSV`.' + ERROS,
          body: {
            type: 'object', required: ['tipo'], additionalProperties: false, example: { tipo: 'EQUIPAMENTOS_PREDITIVO', formato: 'CSV' },
            properties: { tipo: { type: 'string', enum: TIPOS_RELATORIO }, formato: { type: 'string', enum: ['JSON', 'CSV'], default: 'JSON' } },
          },
        },
      }, h(ctrl.solicitarRelatorio));

      api.get('/relatorios/:id', {
        config: limite, preHandler: [exigirEscopo('ANALISES_LER')],
        schema: {
          tags: ['Relatorios'], summary: 'Status do relatorio (polling)', security: seg,
          description: 'Status: `PENDENTE` -> `EM_EXECUCAO` -> `CONCLUIDA` (traz `downloadUrl`) ou `FALHA` (traz `erro`). Falhas transitorias sao repetidas automaticamente (ate `maxTentativas`).' + ERROS,
          params: idParams,
        },
      }, h(ctrl.statusRelatorio));

      api.get('/relatorios/:id/download', {
        config: limite, preHandler: [exigirEscopo('ANALISES_LER')],
        schema: { tags: ['Relatorios'], summary: 'Baixa o arquivo (CSV/JSON) do relatorio concluido', security: seg, description: `\`409\` se ainda nao estiver pronto. Arquivos expiram apos o prazo de retencao.${ERROS}`, params: idParams },
      }, h(ctrl.baixarRelatorio));
    });
  };
