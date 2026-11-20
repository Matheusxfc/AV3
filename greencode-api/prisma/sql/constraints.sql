-- Constraints adicionais (CHECK) que o Prisma ainda nao consegue declarar no schema.prisma.
-- Idempotente: pode ser executado varias vezes (npm run db:constraints).
-- Objetivo: garantir NO BANCO que estados inconsistentes nao sejam persistidos,
-- mesmo que alguem grave dados por fora da API.

ALTER TABLE "organizacoes" DROP CONSTRAINT IF EXISTS "chk_organizacoes_cnpj_formato";
ALTER TABLE "organizacoes" ADD CONSTRAINT "chk_organizacoes_cnpj_formato" CHECK ("cnpj" ~ '^[0-9]{14}$');

ALTER TABLE "organizacoes" DROP CONSTRAINT IF EXISTS "chk_organizacoes_versao";
ALTER TABLE "organizacoes" ADD CONSTRAINT "chk_organizacoes_versao" CHECK ("versao" >= 1);

ALTER TABLE "usuarios" DROP CONSTRAINT IF EXISTS "chk_usuarios_versao";
ALTER TABLE "usuarios" ADD CONSTRAINT "chk_usuarios_versao" CHECK ("versao" >= 1);

ALTER TABLE "contratos" DROP CONSTRAINT IF EXISTS "chk_contratos_valor";
ALTER TABLE "contratos" ADD CONSTRAINT "chk_contratos_valor" CHECK ("valorMensal" >= 0);

ALTER TABLE "contratos" DROP CONSTRAINT IF EXISTS "chk_contratos_datas";
ALTER TABLE "contratos" ADD CONSTRAINT "chk_contratos_datas" CHECK ("dataVencimento" > "dataAssinatura");

ALTER TABLE "contratos" DROP CONSTRAINT IF EXISTS "chk_contratos_versao";
ALTER TABLE "contratos" ADD CONSTRAINT "chk_contratos_versao" CHECK ("versao" >= 1);

ALTER TABLE "lotes" DROP CONSTRAINT IF EXISTS "chk_lotes_versao";
ALTER TABLE "lotes" ADD CONSTRAINT "chk_lotes_versao" CHECK ("versao" >= 1);

ALTER TABLE "equipamentos" DROP CONSTRAINT IF EXISTS "chk_equipamentos_peso";
ALTER TABLE "equipamentos" ADD CONSTRAINT "chk_equipamentos_peso" CHECK ("pesoQuilogramas" > 0);

ALTER TABLE "equipamentos" DROP CONSTRAINT IF EXISTS "chk_equipamentos_ano";
ALTER TABLE "equipamentos" ADD CONSTRAINT "chk_equipamentos_ano" CHECK ("anoFabricacao" BETWEEN 1970 AND 2100);

ALTER TABLE "equipamentos" DROP CONSTRAINT IF EXISTS "chk_equipamentos_posicao";
ALTER TABLE "equipamentos" ADD CONSTRAINT "chk_equipamentos_posicao" CHECK ("posicaoNoLote" >= 1);

ALTER TABLE "equipamentos" DROP CONSTRAINT IF EXISTS "chk_equipamentos_versao";
ALTER TABLE "equipamentos" ADD CONSTRAINT "chk_equipamentos_versao" CHECK ("versao" >= 1);

-- Journal imutavel: bloqueia UPDATE e DELETE (somente INSERT e permitido).
CREATE OR REPLACE FUNCTION greencode_journal_imutavel() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'journal_transacoes e imutavel: % nao permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_imutavel ON "journal_transacoes";
CREATE TRIGGER trg_journal_imutavel
  BEFORE UPDATE OR DELETE ON "journal_transacoes"
  FOR EACH ROW EXECUTE FUNCTION greencode_journal_imutavel();

-- ===== Atividade 3 =====
ALTER TABLE "chaves_api" DROP CONSTRAINT IF EXISTS "chk_chaves_limite";
ALTER TABLE "chaves_api" ADD CONSTRAINT "chk_chaves_limite" CHECK ("limitePorMinuto" BETWEEN 1 AND 100000);

ALTER TABLE "valores_referencia" DROP CONSTRAINT IF EXISTS "chk_valores_referencia_valor";
ALTER TABLE "valores_referencia" ADD CONSTRAINT "chk_valores_referencia_valor" CHECK ("valorPorKg" >= 0);

ALTER TABLE "tarefas" DROP CONSTRAINT IF EXISTS "chk_tarefas_tentativas";
ALTER TABLE "tarefas" ADD CONSTRAINT "chk_tarefas_tentativas" CHECK ("tentativas" >= 0 AND "maxTentativas" >= 1);

-- Historico analitico imutavel: snapshots nao podem ser alterados (permite comparar previsoes com realizacoes).
CREATE OR REPLACE FUNCTION greencode_historico_imutavel() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% e imutavel: operacao % nao permitida', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_resultados_analise_imutavel ON "resultados_analise";
CREATE TRIGGER trg_resultados_analise_imutavel
  BEFORE UPDATE ON "resultados_analise"
  FOR EACH ROW EXECUTE FUNCTION greencode_historico_imutavel();

DROP TRIGGER IF EXISTS trg_previsoes_imutavel ON "previsoes_vida_util";
CREATE TRIGGER trg_previsoes_imutavel
  BEFORE UPDATE ON "previsoes_vida_util"
  FOR EACH ROW EXECUTE FUNCTION greencode_historico_imutavel();
