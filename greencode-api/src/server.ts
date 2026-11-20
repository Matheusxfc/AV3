import { buildApp } from './app';
import { env } from './config/env';
import { Agendador } from './fila/Agendador';
import { FilaWorker } from './fila/FilaWorker';
import { criarPrisma } from './infra/prisma';

async function main(): Promise<void> {
  const prisma = criarPrisma();
  const { app, container: c } = await buildApp(prisma);

  await app.listen({ port: env.port, host: env.host });
  app.log.info(`greencode API no ar: http://localhost:${env.port}`);
  app.log.info(`  docs publica: http://localhost:${env.port}/api/v1/public/docs`);
  app.log.info(`  docs interna: http://localhost:${env.port}/api/v1/internal/docs`);

  // ---- Worker da fila + agendador (embutidos no processo; desligaveis por variavel de ambiente) ----
  const worker = env.workerEmbutido ? new FilaWorker(c.tarefaRepo, c.executor, app.log) : null;
  worker?.iniciar();
  const agendador = env.schedulerHabilitado ? new Agendador(c.tarefas, app.log) : null;
  agendador?.iniciar();

  // ---- Graceful shutdown ----------------------------------------------------------------------
  // Ordem: para de AGENDAR -> para de PEGAR tarefas e espera as em andamento -> fecha o HTTP (espera
  // requisicoes em andamento) -> fecha o pool do Prisma (hook onClose) -> sai.
  let encerrando = false;
  const encerrar = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    app.log.info(`${sinal} recebido: encerrando com graceful shutdown...`);

    const watchdog = setTimeout(() => {
      app.log.error('Tempo limite de shutdown excedido; forcando saida.');
      process.exit(1);
    }, 20_000);
    watchdog.unref();

    try {
      agendador?.parar();
      await worker?.parar();
      await app.close();
      app.log.info('Servidor encerrado com sucesso.');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Falha no shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void encerrar('SIGINT'));
  process.on('SIGTERM', () => void encerrar('SIGTERM'));
}

main().catch((err) => {
  console.error('Falha ao iniciar o servidor:', err);
  process.exit(1);
});
