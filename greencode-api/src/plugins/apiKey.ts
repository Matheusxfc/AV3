import { EscopoApi } from '@prisma/client';
import { FastifyRequest } from 'fastify';
import { ProibidoError } from '../shared/errors';
import { ContextoApi, ParceiroService } from '../services/ParceiroService';

declare module 'fastify' {
  interface FastifyRequest {
    /** Preenchido pelo hook de chave de API (somente nas rotas publicas). */
    chaveApi: ContextoApi | null;
  }
}

/** Hook onRequest do escopo publico: header `x-api-key` -> contexto do parceiro (ou 401). */
export function hookChaveApi(parceiros: ParceiroService) {
  return async (req: FastifyRequest): Promise<void> => {
    const h = req.headers['x-api-key'];
    req.chaveApi = await parceiros.autenticar(Array.isArray(h) ? h[0] : h);
  };
}

/** preHandler: a chave precisa ter pelo menos um dos escopos informados. */
export function exigirEscopo(...escopos: EscopoApi[]) {
  return async (req: FastifyRequest): Promise<void> => {
    const ctx = req.chaveApi;
    if (!ctx || !escopos.some((e) => ctx.escopos.includes(e))) {
      throw new ProibidoError(`A chave de API nao possui o escopo necessario: ${escopos.join(' ou ')}.`);
    }
  };
}

/**
 * Configuracao de rate limit POR CHAVE (@fastify/rate-limit): cada chave tem seu proprio contador e seu proprio
 * limite/minuto (definido no contrato comercial). Roda depois do hook de autenticacao, entao req.chaveApi existe.
 */
export function limitePorChave() {
  return {
    rateLimit: {
      max: (req: FastifyRequest) => req.chaveApi?.limitePorMinuto ?? 30,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => req.chaveApi?.chaveId ?? req.ip,
    },
  };
}
