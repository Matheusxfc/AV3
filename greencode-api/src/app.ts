import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { env } from './config/env';
import { criarContainer } from './container';
import { rotasAnalises } from './http/rotas/analises';
import { rotasAuth } from './http/rotas/auth';
import { rotasEquipamentos } from './http/rotas/equipamentos';
import { rotasJournal } from './http/rotas/journal';
import { rotasLotes } from './http/rotas/lotes';
import { rotasOrganizacoes } from './http/rotas/organizacoes';
import { rotasParametros } from './http/rotas/parametros';
import { rotasParceiros } from './http/rotas/parceiros';
import { rotasPublicas } from './http/rotas/publico';
import { rotasRelatorios } from './http/rotas/relatorios';
import { rotasTarefas } from './http/rotas/tarefas';
import { rotasUsuarios } from './http/rotas/usuarios';
import authPlugin from './plugins/auth';
import { registrarErros } from './plugins/erros';

export async function buildApp(prisma: PrismaClient) {
  const app = Fastify({
    logger: { level: env.logLevel },
    forceCloseConnections: 'idle',
   
    ajv: { customOptions: { keywords: ['example', 'examples'] } },
  });

  registrarErros(app);

  await app.register(cors, {
    origin: env.corsOrigin === '*' ? true : env.corsOrigin.split(',').map((o) => o.trim()),
    exposedHeaders: ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after', 'location'],
  });

  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      code: 'LIMITE_EXCEDIDO',
      error: 'Too Many Requests',
      message: `Limite de ${ctx.max} requisicoes por janela excedido. Tente novamente em ${ctx.after}.`,
    }),
  });

  await app.register(authPlugin);
  const c = criarContainer(prisma);

  app.get('/', { schema: { hide: true } }, async () => ({
    nome: 'greencode API',
    versao: '3.0.0',
    documentacao: { publica: '/api/v1/public/docs', interna: '/api/v1/internal/docs' },
    saude: '/health',
  }));

  app.get('/health', { schema: { hide: true } }, async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', banco: 'ok', timestamp: Date.now() };
    } catch {
      return reply.status(503).send({ status: 'indisponivel', banco: 'falha', timestamp: Date.now() });
    }
  });


  await app.register(
    async (interna) => {
      await interna.register(swagger, {
        openapi: {
          openapi: '3.0.3',
          info: { title: 'greencode - API Interna', version: '3.0.0', description: 'Uso interno (front-end e gestao). Autenticacao: JWT (`POST /auth/login`).' },
          components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
        },
      });
      await interna.register(swaggerUi, { routePrefix: '/docs' });

      await interna.register(rotasAuth(c), { prefix: '/auth' });
      await interna.register(rotasUsuarios(c), { prefix: '/usuarios' });
      await interna.register(rotasParametros(c), { prefix: '/parametros' });
      await interna.register(rotasOrganizacoes(c), { prefix: '/organizacoes' });
      await interna.register(rotasLotes(c), { prefix: '/lotes' });
      await interna.register(rotasEquipamentos(c), { prefix: '/equipamentos' });
      await interna.register(rotasRelatorios(c), { prefix: '/relatorios' });
      await interna.register(rotasJournal(c), { prefix: '/journal' });
      
      await interna.register(rotasAnalises(c), { prefix: '/analises' });
      await interna.register(rotasParceiros(c), { prefix: '/parceiros' });
      await interna.register(rotasTarefas(c), { prefix: '/tarefas' });
    },
    { prefix: '/api/v1/internal' },
  );

  await app.register(rotasPublicas(c), { prefix: '/api/v1/public' });

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  return { app, container: c };
}

// Com fé e Tokens, tudo passa