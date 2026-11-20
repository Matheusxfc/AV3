import { Prisma, StatusTarefa, TipoTarefa } from '@prisma/client';
import { Db } from '../infra/prisma';
import { paraJson } from '../shared/util';

export interface TarefaReivindicada {
  id: string;
  tipo: TipoTarefa;
  payload: any;
  tentativas: number;
  maxTentativas: number;
}

export interface NovaTarefa {
  tipo: TipoTarefa;
  payload: unknown;
  solicitante: string;
  maxTentativas: number;
  parceiroId?: string | null;
  chaveApiId?: string | null;
  expiraEm?: Date | null;
}

export interface FiltroTarefa {
  status?: StatusTarefa;
  tipo?: TipoTarefa;
  parceiroId?: string;
}

/** Colunas "leves" (sem o conteudo do arquivo) para status e listagens. */
const LEVE = {
  id: true, tipo: true, status: true, payload: true, resultado: true, nomeArquivo: true, mime: true, tentativas: true,
  maxTentativas: true, proximaExecucaoEm: true, erro: true, parceiroId: true, solicitante: true, criadoEm: true,
  iniciadaEm: true, concluidaEm: true, expiraEm: true,
} satisfies Prisma.TarefaSelect;

/**
 * Fila de tarefas sobre o PostgreSQL.
 * Reivindicacao atomica com `FOR UPDATE SKIP LOCKED`: varios workers (processos/maquinas) podem
 * consumir a mesma tabela sem pegar a mesma tarefa e sem se bloquearem mutuamente.
 */
export class TarefaRepository {
  constructor(private readonly db: Db) {}

  enfileirar(t: NovaTarefa) {
    return this.db.tarefa.create({
      data: {
        tipo: t.tipo, payload: paraJson(t.payload), solicitante: t.solicitante, maxTentativas: t.maxTentativas,
        parceiroId: t.parceiroId ?? null, chaveApiId: t.chaveApiId ?? null, expiraEm: t.expiraEm ?? null,
      },
      select: LEVE,
    });
  }

  /** Pega (e marca como EM_EXECUCAO) a proxima tarefa pronta, ou null. */
  async reivindicar(workerId: string): Promise<TarefaReivindicada | null> {
    const linhas = await this.db.$queryRaw<TarefaReivindicada[]>`
      UPDATE "tarefas"
         SET "status" = 'EM_EXECUCAO',
             "iniciadaEm" = now(),
             "travadaEm" = now(),
             "travadaPor" = ${workerId},
             "tentativas" = "tentativas" + 1
       WHERE "id" = (
         SELECT "id" FROM "tarefas"
          WHERE "status" = 'PENDENTE' AND "proximaExecucaoEm" <= now()
          ORDER BY "criadoEm" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1)
      RETURNING "id", "tipo", "payload", "tentativas", "maxTentativas"`;
    return linhas[0] ?? null;
  }

  concluir(id: string, r: { resultado?: unknown; conteudo?: string; nomeArquivo?: string; mime?: string }) {
    return this.db.tarefa.update({
      where: { id },
      data: {
        status: 'CONCLUIDA', concluidaEm: new Date(), erro: null, travadaEm: null, travadaPor: null,
        resultado: r.resultado === undefined ? Prisma.DbNull : paraJson(r.resultado),
        conteudo: r.conteudo ?? null, nomeArquivo: r.nomeArquivo ?? null, mime: r.mime ?? null,
      },
    });
  }

  /** proximaExecucaoEm != null: volta para a fila (retry); null: falha definitiva. */
  registrarFalha(id: string, erro: string, proximaExecucaoEm: Date | null) {
    return this.db.tarefa.update({
      where: { id },
      data: {
        erro: erro.slice(0, 2000), travadaEm: null, travadaPor: null,
        ...(proximaExecucaoEm ? { status: 'PENDENTE', proximaExecucaoEm } : { status: 'FALHA', concluidaEm: new Date() }),
      },
    });
  }

  /** Tarefas EM_EXECUCAO ha muito tempo (worker caiu): esgotadas -> FALHA; as demais voltam para PENDENTE. */
  async recuperarTravadas(limite: Date): Promise<number> {
    const esgotadas = await this.db.$executeRaw`
      UPDATE "tarefas" SET "status" = 'FALHA', "erro" = 'Worker interrompido e tentativas esgotadas', "concluidaEm" = now(), "travadaEm" = NULL, "travadaPor" = NULL
       WHERE "status" = 'EM_EXECUCAO' AND "travadaEm" < ${limite} AND "tentativas" >= "maxTentativas"`;
    const recolocadas = await this.db.$executeRaw`
      UPDATE "tarefas" SET "status" = 'PENDENTE', "proximaExecucaoEm" = now(), "travadaEm" = NULL, "travadaPor" = NULL
       WHERE "status" = 'EM_EXECUCAO' AND "travadaEm" < ${limite}`;
    return Number(esgotadas) + Number(recolocadas);
  }

  porId(id: string) {
    return this.db.tarefa.findUnique({ where: { id }, select: LEVE });
  }
  porIdComConteudo(id: string) {
    return this.db.tarefa.findUnique({ where: { id } });
  }
  async listar(f: FiltroTarefa, skip: number, take: number) {
    const where: Prisma.TarefaWhereInput = {
      ...(f.status ? { status: f.status } : {}), ...(f.tipo ? { tipo: f.tipo } : {}), ...(f.parceiroId ? { parceiroId: f.parceiroId } : {}),
    };
    const [dados, total] = await Promise.all([
      this.db.tarefa.findMany({ where, skip, take, orderBy: { criadoEm: 'desc' }, select: LEVE }),
      this.db.tarefa.count({ where }),
    ]);
    return { dados, total };
  }
  contagemPorStatus() {
    return this.db.tarefa.groupBy({ by: ['status'], _count: { _all: true } });
  }
  /** FALHA -> PENDENTE com tentativas zeradas (acao manual do administrador). */
  async reenfileirar(id: string): Promise<boolean> {
    const r = await this.db.tarefa.updateMany({
      where: { id, status: 'FALHA' },
      data: { status: 'PENDENTE', tentativas: 0, erro: null, proximaExecucaoEm: new Date(), concluidaEm: null },
    });
    return r.count === 1;
  }
  existePendenteOuEmExecucao(tipo: TipoTarefa, filtroPayload: Prisma.JsonObject) {
    return this.db.tarefa
      .count({ where: { tipo, status: { in: ['PENDENTE', 'EM_EXECUCAO'] }, payload: { equals: filtroPayload } } })
      .then((n) => n > 0);
  }
  /** Remove tarefas (e relatorios gerados) cujo prazo de retencao venceu. */
  async purgarExpiradas(): Promise<number> {
    const r = await this.db.tarefa.deleteMany({ where: { expiraEm: { lt: new Date() }, status: { in: ['CONCLUIDA', 'FALHA'] } } });
    return r.count;
  }
}
