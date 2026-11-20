/**
 * Worker STANDALONE da fila (sem servidor HTTP). Uso em escala horizontal:
 *   - API:    WORKER_EMBUTIDO=false  (npm start)
 *   - Worker: npm run worker / npm run start:worker  (quantas instancias forem necessarias)
 * Todas as instancias consomem a mesma tabela "tarefas" com FOR UPDATE SKIP LOCKED (sem duplicidade).
 * O agendador (cron) fica na API: nao e iniciado aqui, para nao duplicar agendamentos.
 */
import { criarContainer } from './container';
import { FilaWorker, Logger } from './fila/FilaWorker';
import { criarPrisma } from './infra/prisma';

const log: Logger = {
  info: (o, m) => console.log(JSON.stringify({ nivel: 'info', msg: m, ...(o as object) })),
  warn: (o, m) => console.warn(JSON.stringify({ nivel: 'warn', msg: m, ...(o as object) })),
  error: (o, m) => console.error(JSON.stringify({ nivel: 'error', msg: m, ...(o instanceof Object ? { ...o, err: String((o as any).err ?? '') } : {}) })),
};

async function main(): Promise<void> {
  const prisma = criarPrisma();
  const c = criarContainer(prisma);
  const worker = new FilaWorker(c.tarefaRepo, c.executor, log);
  worker.iniciar();

  let encerrando = false;
  const encerrar = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    log.info({ sinal }, 'Encerrando worker (aguardando tarefas em andamento)');
    const watchdog = setTimeout(() => process.exit(1), 30_000);
    watchdog.unref();
    await worker.parar();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void encerrar('SIGINT'));
  process.on('SIGTERM', () => void encerrar('SIGTERM'));
}

main().catch((err) => {
  console.error('Falha ao iniciar o worker:', err);
  process.exit(1);
});
