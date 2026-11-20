# Relatório técnico — Atividade 3 (greencode)

Este documento justifica as decisões arquiteturais da camada analítica, da API pública e do processamento assíncrono, os *trade-offs* considerados e como a arquitetura evolui se o volume de parceiros crescer.

## 1. Estatística: por que implementação própria (e não `simple-statistics`/`mathjs`)

| Critério | Decisão |
|---|---|
| Necessidade real | Média, mediana, desvio padrão, percentil, **regressão OLS**, RMSE e **suavização exponencial simples**: ~100 linhas |
| Testabilidade | Funções puras em `src/domain/estatistica.ts`, testadas com valores **conferidos à mão** (ex.: x=[1..5], y=[2,4,5,4,5] ⇒ b=0,6, a=2,2, R²=0,6) |
| Dependências | Menos pacotes = menos superfície de ataque (cadeia de suprimentos) e nenhum risco de incompatibilidade em Windows/Ubuntu |
| Transparência | O avaliador (e o cliente) consegue auditar a fórmula; não há "caixa-preta" |
| Custo | Manutenção de poucas fórmulas bem conhecidas |

**Quando trocar:** `simple-statistics` se surgirem muitas funções utilitárias (quantis, correlações, testes); `mathjs` se for preciso álgebra matricial (regressão **múltipla** por marca/modelo/idade). O módulo é isolado: a troca não afeta serviços nem API.

## 2. Modelos analíticos

**Vida útil (preditivo).** Cada estado físico vira um índice ordinal (0 = NOVO … 6 = INSERVIVEL). Para cada tipo de equipamento ajusta-se `índice = a + b·idade` por **OLS**. Então:
- idade estimada até inservível = `(6 − a) / b`;
- vida remanescente de um equipamento = `(6 − índice atual) / b` (mantida a taxa de degradação do tipo);
- qualidade: **R²** e **RMSE em amostra reservada** (1 a cada 4 observações) quando n ≥ 8; abaixo de 5 observações o status é `DADOS_INSUFICIENTES` e **nenhuma previsão é inventada**; `inclinação ≤ 0,001` ⇒ `SEM_DEGRADACAO`.

*Limitação assumida:* é um modelo de corte transversal (estado × idade do parque), não uma série temporal por equipamento. Foi o que os dados atuais permitem (o enunciado sugere regressão simples ou suavização). A suavização exponencial é usada onde há série temporal real: tempo médio mensal de triagem (previsão do próximo mês).

**Eficiência.** Reconstrói a **linha do tempo de status** de cada equipamento a partir de `movimentacoes` (só destinos que são status do rastreamento; textos livres como "Bancada 3" são ignorados). Daí saem a duração em cada etapa (gargalo = etapa de maior média), o tempo por operador (quem **concluiu** a triagem) e o tempo do lote (entrada → último equipamento sair da triagem; lotes com triagem incompleta são excluídos e contados à parte).

**Rentabilidade.** `valor = peso × R$/kg × fator(estado)`. O R$/kg tem precedência **modelo > marca > tipo > padrão** e é editável (`valores_referencia`). Os valores iniciais são **ilustrativos** e isso é declarado no próprio resultado.

## 3. Modelagem das tabelas analíticas

| Tabela | Papel | Decisões |
|---|---|---|
| `resultados_analise` | Snapshot de cada execução: `tipo`, `origem` (AGENDADA/MANUAL), escopo (`organizacaoId` nulo = global), período, **`versaoModelo`**, `parametros`, **`resultado` (JSON)**, `duracaoMs` | O resultado de cada análise tem forma diferente ⇒ **JSON** evita uma tabela por análise e permite evoluir o formato sem migração. Cada linha é **imutável** (trigger): o histórico é confiável para auditoria e para comparar execuções. `versaoModelo` separa "mudou o dado" de "mudou o modelo" |
| `previsoes_vida_util` | Coeficientes **estruturados** (amostra, intercepto, inclinação, R², RMSE, idade estimada) por tipo e por execução | Colunas tipadas (não JSON) porque são **séries temporais consultáveis** ("a inclinação do notebook está subindo?"). FK com `ON DELETE CASCADE` para o snapshot |
| `valores_referencia` | Parâmetro de negócio (R$/kg) por tipo/marca/modelo | `UNIQUE(tipo, marca, modelo)`; `''` significa "qualquer" (evita a armadilha de `NULL` em índices únicos do PostgreSQL) |

Índices: `(tipo, geradoEm)` para "último resultado" e histórico; `(tipoEquipamento, geradoEm)` para a série dos modelos.

*Comparar previsões com realizações* (citado no enunciado): o histórico guarda a previsão de cada execução; a avaliação contra o realizado é feita comparando execuções sucessivas (`/analises/vida-util/modelos`) e, de imediato, pelo RMSE em amostra reservada. Um job de "backtest" que confronte a previsão antiga com o estado observado depois é o próximo passo natural.

## 4. API pública

- **Segregação:** `/api/v1/public` (chave de API) separado de `/api/v1/internal` (JWT), com **documentações Swagger distintas**. Políticas diferentes: a pública tem escopos, rate limit por chave, DTOs próprios e escopo de dados por organização.
- **Chave de API:** `gck_<prefixo>_<segredo 256 bits>`. Armazena-se só o **SHA-256**. Para tokens aleatórios de alta entropia, hash rápido é adequado (bcrypt/argon2 protegem senhas *escolhidas por humanos* e custariam CPU em toda requisição). O prefixo (índice único) permite localizar o registro sem varrer a tabela; a comparação é em tempo constante.
- **Autorização em duas camadas:** *escopos* (o que a chave pode fazer) + *escopo de dados* (de quais organizações). Recurso fora do escopo responde 404 (sem enumeração). O `acessoGlobal` precisa ser concedido explicitamente.
- **Rate limit por chave:** `@fastify/rate-limit`, contador por `chaveId` e limite do contrato comercial (`limitePorMinuto`). Cabeçalhos `x-ratelimit-*` e `retry-after`.
- **Versionamento:** na URL (`/v1`). Mudança incompatível ⇒ `/v2`, com a v1 mantida durante a depreciação.
- **Ordem dos hooks:** o hook de autenticação fica no escopo e roda **antes** do limitador da rota, para que o limite use a chave já identificada.

## 5. Processamento assíncrono

**Padrão:** `POST` → **202 + id** → *polling* de status → download. O relatório não segura a conexão HTTP (evita *timeout* e não degrada os demais usuários).

**Por que fila em PostgreSQL e não BullMQ + Redis** (o enunciado permite ambos):

| | PostgreSQL (`SKIP LOCKED`) | BullMQ + Redis |
|---|---|---|
| Operação | Nenhuma peça nova; funciona igual no Windows e no Ubuntu | Exige Redis (no Windows: WSL/Docker — ponto de atrito real neste projeto) |
| Consistência | Pode enfileirar na **mesma transação** dos dados; tarefa e estado nunca divergem | Dois sistemas ⇒ risco de "gravou mas não enfileirou" (precisa do padrão *outbox*) |
| Escala | Centenas a poucos milhares de tarefas/min | Dezenas de milhares/min, prioridades, *rate limiter* de fila, UI (Bull Board) |
| Custo de troca | Isolado em `TarefaRepository` + `FilaWorker` | — |

**Política de retry** (`src/fila/FilaWorker.ts`, `src/domain/retry.ts`):
1. **Classificação do erro.** Erros de regra de negócio/payload inválido (`AppError`, `ErroNaoRetentavel`) **não** adiantam repetir ⇒ `FALHA` imediata. Erros de infraestrutura (banco, rede) são **retentáveis**.
2. **Backoff exponencial com jitter:** `atraso = min(5 s · 2^(n−1), 5 min) × (0,8…1,2)`. O jitter evita a "manada" de tarefas voltando no mesmo instante.
3. **Limite de tentativas:** `TAREFA_MAX_TENTATIVAS` (3). Esgotadas ⇒ `FALHA` (estado final, erro registrado, reenfileirável por admin). Funciona como *dead-letter* visível.
4. **Worker que morre:** a tarefa fica `EM_EXECUCAO`; após o *timeout* de travada (5 min) é recolocada (ou vai a `FALHA` se já esgotou as tentativas). Garantia de entrega: **at-least-once** ⇒ as tarefas são **idempotentes** (gerar um relatório duas vezes é inofensivo; uma análise agendada grava mais um snapshot).
5. **Concorrência controlada** e **shutdown gracioso** (espera as tarefas em andamento).

**Agendamento (`node-cron`):** só **enfileira**; a execução (com retry/observabilidade) é do worker. Não empilha a mesma análise agendada se a anterior ainda estiver pendente.

## 6. Evolução: de dezenas a centenas/milhares de parceiros

| Gargalo previsível | Medida |
|---|---|
| Rate limit em memória (cada instância conta separado) | Store **Redis** do `@fastify/rate-limit`, ou limite no **gateway** (Kong/Nginx/Cloudflare) com cotas por plano |
| Autenticação de chave faz 1 consulta ao banco por requisição | **Cache** curto (30–60 s) de `ContextoApi` por prefixo, com invalidação na revogação; ou validação no gateway |
| Fila no PostgreSQL competindo com o tráfego transacional | Mover para **BullMQ + Redis** (ou SQS/RabbitMQ), mantendo `FilaWorker`/`Executor` como adaptadores; workers em máquinas separadas (`npm run worker`) |
| Análises lendo todas as movimentações | Pré-agregação (**views materializadas**/tabelas de resumo), análises incrementais e **réplica de leitura** para os cálculos |
| Relatórios grandes no banco (`conteudo` em texto) | Gravar em **object storage** (S3) e guardar só a URL assinada |
| Notificação em vez de polling | **Webhooks** assinados (HMAC) com proteção contra SSRF, retry próprio e *dead-letter* |
| Cobrança/planos por parceiro | Tabela de planos (limites, escopos, cotas mensais) e medição de uso por chave (`ultimoUsoEm` → contadores) |
| Observabilidade | Logs estruturados já existentes → métricas (Prometheus/OpenTelemetry), alerta por profundidade da fila e idade da tarefa mais antiga |
| Segurança | Rotação de chaves com sobreposição, *IP allow-list* por parceiro, assinatura de requisições (HMAC) para clientes sensíveis |
| Limites do monólito | Extrair o módulo analítico + worker como serviço separado — as fronteiras Controller/Service/Repository já isolam o domínio |

## 7. Riscos e limitações declarados

- Massa de dados do seed é **sintética**; os valores R$/kg e fatores por estado são **premissas** editáveis.
- Vida útil usa corte transversal (sem histórico por equipamento).
- Webhook não implementado; rate limit por instância.
- Este pacote foi desenvolvido sem acesso ao npm/PostgreSQL reais no ambiente de construção: a lógica de domínio e analítica tem **39 testes automatizados**; a integração (Fastify + Prisma) deve ser validada com a coleção do Thunder Client (pastas 09–13).
