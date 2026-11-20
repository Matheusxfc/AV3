# greencode API (Atividades 2 e 3)

Evolução do **greencode** em três etapas: CLI com arquivos cifrados (Atividade 1) → **API RESTful monolítica** com Fastify, Prisma e PostgreSQL (Atividade 2) → **plataforma analítica e integrada** (Atividade 3): camada de análises (eficiência, rentabilidade e vida útil preditiva), **API pública com chaves de API**, rate limit por parceiro e **processamento assíncrono com fila**.

> **Atividade 3 em uma frase:** os parceiros externos consomem `/api/v1/public` com `x-api-key`; a equipe usa `/api/v1/internal` com JWT; relatórios pesados viram tarefas numa fila (PostgreSQL + worker com retry) e a análise recorrente roda por `node-cron`. Veja a [seção 15](#15-atividade-3-análises-api-pública-e-fila) e o [relatório técnico](docs/RELATORIO_TECNICO.md).

> Easter egg na pasta app.ts, na linha 105

> Compatível com **Windows 10 ou superior**, **Ubuntu 24.04.03 ou superior** e derivadas do Ubuntu. Não há dependências nativas (por isso `bcryptjs`, e não `bcrypt`).

## Índice

1. [O que mudou em relação à Atividade 1](#1-o-que-mudou-em-relação-à-atividade-1)
2. [Arquitetura](#2-arquitetura)
3. [Instalação e execução](#3-instalação-e-execução)
4. [Variáveis de ambiente](#4-variáveis-de-ambiente)
5. [Usuários do seed e papéis](#5-usuários-do-seed-e-papéis)
6. [Endpoints](#6-endpoints)
7. [Testando com Thunder Client](#7-testando-com-thunder-client)
8. [Regras de negócio](#8-regras-de-negócio)
9. [Transações, concorrência e versionamento otimista](#9-transações-concorrência-e-versionamento-otimista)
10. [Segurança](#10-segurança)
11. [Decisões arquiteturais e trade-offs](#11-decisões-arquiteturais-e-trade-offs)
12. [Testes automatizados](#12-testes-automatizados)
13. [Estrutura de pastas](#13-estrutura-de-pastas)
14. [Limitações conhecidas](#14-limitações-conhecidas)
15. [Atividade 3: análises, API pública e fila](#15-atividade-3-análises-api-pública-e-fila)

---

## 1. O que mudou em relação à Atividade 1

| Aspecto | Atividade 1 (CLI) | Atividade 2 (API) |
|---|---|---|
| Interface | `readline` / linha de comando | API REST (Fastify) + documentação Swagger em `/docs` |
| Persistência | Arquivos cifrados AES‑256‑GCM | PostgreSQL + Prisma (migrações versionadas) |
| Autenticação | Sessão em arquivo, expira em 30 min de inatividade | **JWT** stateless (30 min), com renovação em `POST /auth/renovar` |
| Hash de senha | SHA‑256 + salt | **bcrypt** (custo configurável) |
| Atomicidade | `tmp` + `rename` | `prisma.$transaction` (ACID) |
| Concorrência | Processo único, *last‑write‑wins* | Bloqueio otimista (`versao`) + `SELECT … FOR UPDATE` |
| Journal | Arquivo `.log` com rotação | Tabela `journal_transacoes`, gravada **na mesma transação** e imutável (trigger) |
| Unicidade | Verificada em código | Verificada em código **e** no banco (`UNIQUE`: CNPJ, código de barras, `lote+posição`, `org+NF`) |
| Papéis | 4 papéis | Os mesmos 4 papéis, agora aplicados por rota |

**Reaproveitado da Atividade 1** (copiado para `src/domain`, sem dependência de banco/HTTP): enums, `Validador` (abstrata) → `ValidadorCNPJ` / `ValidadorDataEntrada`, regra de queda de estado físico, geração de código de barras, depreciação.

**Aprimorado ao migrar** (o PDF pede para revisar as validações):
- O ciclo de vida do equipamento virou uma **máquina de estados explícita** (antes só `EM_DESMONTE` era protegido).
- Unicidade e `CHECK`s no banco (peso > 0, ano 1970–2100, vencimento > assinatura, CNPJ com 14 dígitos…).
- Triagem do lote concluída **automaticamente** quando o último equipamento sai de triagem.
- Journal imutável por *trigger* no PostgreSQL.
- Política de senha (≥ 8 caracteres, letras e números) e proteção contra força bruta no login (rate limit).

---

## 2. Arquitetura

Monólito em camadas **Controller → Service → Repository** (conforme sugerido no enunciado):

```
Requisição HTTP
   │
   ▼
rotas/        declaram caminho, JSON Schema (validação) e papéis permitidos (hooks authenticate/authorize)
   │
   ▼
controllers/  traduzem HTTP → chamada de serviço (sem regra de negócio)
   │
   ▼
services/     TODA a regra de negócio, validações, transações e journal
   │            └─ usam domain/ (regras puras, testáveis sem banco)
   ▼
repositories/ únicos que falam com o Prisma Client (aceitam client normal ou transação via .com(tx))
   │
   ▼
PostgreSQL
```

Uma camada nunca conhece a de cima: os serviços não sabem que existe HTTP (poderiam ser reutilizados por CLI ou mensageria). A composição é feita à mão em `src/container.ts`.

Relacionamentos (conforme o PDF): `Organizacao 1—0..1 Contrato`, `Organizacao 1—N Lote`, `Lote 1—N Equipamento`, `Equipamento 1—N Movimentacao`, mais `Usuario`, `JournalTransacao` e `Parametro`.

---

## 3. Instalação e execução

### Pré-requisitos
- **Node.js 20 LTS ou superior** (`node --version`)
- **PostgreSQL 14+**. Duas opções:
  - **Docker** (mais simples; funciona igual no Windows e no Ubuntu) — usa o `docker-compose.yml` deste projeto; ou
  - PostgreSQL instalado nativamente (ajuste `DATABASE_URL` no `.env`).

### Ubuntu 24.04+ (e derivadas)

```bash
# Node.js 20 (NodeSource) e Docker
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs docker.io docker-compose-v2
sudo usermod -aG docker $USER   # faça logout/login depois

cd greencode-api
cp .env.example .env            # edite JWT_SECRET (veja seção 4)
docker compose up -d            # sobe o PostgreSQL
npm install
npm run db:init                 # 1ª vez: cria a migração "init" e aplica no banco
npm run db:constraints          # CHECKs + trigger de imutabilidade do journal
npm run db:seed                 # usuários + dados de demonstração
npm run dev                     # API em http://localhost:3000
```

### Windows 10/11 (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS
winget install Docker.DockerDesktop     # reinicie e abra o Docker Desktop

cd greencode-api
Copy-Item .env.example .env             # edite JWT_SECRET (veja seção 4)
docker compose up -d
npm install
npm run db:init
npm run db:constraints
npm run db:seed
npm run dev
```

Abra a documentação interativa (Swagger UI):
- **API pública (parceiros):** http://localhost:3000/api/v1/public/docs
- **API interna (front-end/gestão):** http://localhost:3000/api/v1/internal/docs

### Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor com *hot reload* (`tsx watch`) |
| `npm run build` / `npm start` | Compila para `dist/` e executa em produção |
| `npm run db:init` | **Primeira vez**: gera e aplica a migração inicial (`prisma migrate dev --name init`). Faça *commit* da pasta `prisma/migrations/` |
| `npm run db:migrate` | Novas migrações após alterar o `schema.prisma` |
| `npm run db:deploy` | Aplica migrações existentes (produção/CI) |
| `npm run db:constraints` | Aplica `prisma/sql/constraints.sql` (idempotente) |
| `npm run db:seed` | Popula usuários e dados de demonstração (idempotente) |
| `npm run db:setup` | Em ambiente novo com migrações já commitadas: `deploy` + `constraints` + `seed` |
| `npm run db:reset` | **Apaga tudo** e recria (migrações + constraints + seed) |
| `npm run db:studio` | Interface visual do banco (Prisma Studio) |
| `npm test` | Testes de domínio e da camada analítica (39 testes; não precisam de banco) |
| `npm run worker` / `npm run start:worker` | Worker da fila **standalone** (escala horizontal; veja a seção 15) |
| `npm run typecheck` | Checagem de tipos |

> **Por que `db:constraints` é separado?** O Prisma não declara `CHECK` nem *triggers* no `schema.prisma`. O arquivo SQL é idempotente (`DROP … IF EXISTS` + `ADD`), então pode rodar quantas vezes quiser.

### Graceful shutdown
Em `SIGINT` (Ctrl+C) e `SIGTERM` (Docker/systemd) o servidor para de aceitar conexões, espera as requisições em andamento, fecha o pool do Prisma e sai com código 0 (com *watchdog* de 15 s).

---

## 4. Variáveis de ambiente

Copie `.env.example` para `.env` (o `.env` está no `.gitignore`).

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP (configurável, como pede o enunciado) |
| `HOST` | `0.0.0.0` | Interface de escuta |
| `DATABASE_URL` | — (obrigatória) | String de conexão PostgreSQL |
| `JWT_SECRET` | — (obrigatória, ≥ 32 chars) | Segredo de assinatura. Gere: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `JWT_EXPIRES_IN` | `30m` | Validade do token |
| `BCRYPT_ROUNDS` | `10` | Custo do bcrypt |
| `LOGIN_RATE_LIMIT_MAX` | `20` | Tentativas de login por minuto por IP |
| `CORS_ORIGIN` | `*` | Origens permitidas (separadas por vírgula). Em produção, informe o domínio do front-end |
| `LOG_LEVEL` | `info` | Nível de log |
| `ADMIN_USUARIO` / `ADMIN_SENHA` | `admin` / `Admin@12345` | Credenciais do administrador criado pelo seed |

---

## 5. Usuários do seed e papéis

> ⚠️ Senhas de **desenvolvimento**. Troque-as (`POST /auth/senha`) em qualquer ambiente real.

| Usuário | Senha | Papel |
|---|---|---|
| `admin` | `Admin@12345` | `ADMINISTRADOR` |
| `operador` | `Operador@123` | `OPERADOR_CADASTRO` |
| `almoxarife` | `Almox@12345` | `GESTOR_ALMOXARIFADO` |
| `almoxarife2` | `Almox2@12345` | `GESTOR_ALMOXARIFADO` (2º operador, para a análise de eficiência) |
| `auditor` | `Auditor@123` | `AUDITOR` |

| Papel | Pode |
|---|---|
| `ADMINISTRADOR` | Tudo (usuários, parâmetros globais e as demais operações) |
| `OPERADOR_CADASTRO` | Criar/alterar organizações e contratos |
| `GESTOR_ALMOXARIFADO` | Criar lotes, equipamentos, triagem, estado/status, movimentações |
| `AUDITOR` | Somente leitura: rastreabilidade, relatórios, journal e parâmetros |

Qualquer usuário autenticado pode **consultar** organizações, lotes e equipamentos.

---

## 6. Endpoints

> **Prefixo (Atividade 3):** todas as rotas desta tabela ficam sob **`/api/v1/internal`** (ex.: `POST /api/v1/internal/auth/login`). Só `/health` fica na raiz. A API pública e as rotas novas estão na [seção 15](#15-atividade-3-análises-api-pública-e-fila).

Autenticação: `Authorization: Bearer <token>`. Erros seguem o formato `{ statusCode, erro, mensagem, detalhes? }`.

| Método | Rota | Papéis | Descrição |
|---|---|---|---|
| GET | `/health` | público | Healthcheck (ping no banco) |
| POST | `/auth/login` | público (rate limit) | Retorna o JWT |
| POST | `/auth/renovar` | autenticado | Novo token (+30 min) |
| GET | `/auth/me` | autenticado | Perfil |
| POST | `/auth/senha` | autenticado | Altera a própria senha |
| POST/GET | `/usuarios` | ADMIN | Cria / lista usuários |
| PATCH | `/usuarios/:id` | ADMIN | Papel e/ou ativo |
| GET/PUT | `/parametros` | GET: ADMIN, AUDITOR · PUT: ADMIN | Alíquota e coeficiente de depreciação |
| POST | `/organizacoes` | ADMIN, OPERADOR | Cria organização (CNPJ validado; contrato opcional na mesma transação) |
| GET | `/organizacoes` | autenticado | Lista (filtros `ativo`, `cnpj`, `busca`; paginado) |
| GET | `/organizacoes/:id` | autenticado | Detalhe com contrato |
| PATCH | `/organizacoes/:id` | ADMIN, OPERADOR | Atualiza dados / `ativo` |
| GET/POST | `/organizacoes/:id/contrato` | GET: todos · POST: ADMIN, OPERADOR | Consulta / cria contrato |
| PATCH | `/organizacoes/:id/contrato/renovar` | ADMIN, OPERADOR | Renova contrato |
| POST | `/lotes` | ADMIN, GESTOR | Cria lote (opcionalmente com `equipamentos[]`) |
| GET | `/lotes`, `/lotes/:id` | autenticado | Lista (filtros org/status/período) / detalhe |
| POST | `/lotes/:id/equipamentos` | ADMIN, GESTOR | Adiciona equipamento (lote `RECEBIDO`) |
| POST | `/lotes/:id/triagem` | ADMIN, GESTOR | Inicia a triagem do lote |
| PATCH | `/lotes/:id/status` | ADMIN, GESTOR | `ENCAMINHADO` → `FINALIZADO` |
| GET | `/equipamentos`, `/equipamentos/:id` | autenticado | Lista (filtros) / detalhe |
| GET | `/equipamentos/:id/rastreio` | autenticado | Histórico de movimentações + trilha de auditoria |
| GET | `/equipamentos/:id/depreciacao?valorOriginal=` | autenticado | Valor residual |
| PATCH | `/equipamentos/:id/estado` | ADMIN, GESTOR | Estado físico (justificativa se cair ≥ 2) |
| PATCH | `/equipamentos/:id/status` | ADMIN, GESTOR | Status de rastreamento (máquina de estados) |
| POST | `/equipamentos/:id/movimentacoes` | ADMIN, GESTOR | Movimentação física |
| GET | `/relatorios/organizacao/:id`, `/relatorios/status[/:status]`, `/relatorios/financeiro` | ADMIN, AUDITOR | Relatórios (JSON) |
| GET | `/journal` | ADMIN, AUDITOR | Trilha de auditoria (filtros) |

Listagens aceitam `?pagina=1&limite=20` (máx. 100) e retornam `{ dados, pagina, limite, total, totalPaginas }`.

---

## 7. Testando com Thunder Client

[Thunder Client](https://www.thunderclient.com/) é uma extensão do VS Code (recomendada em `.vscode/extensions.json`). A pasta `thunder-client/` traz uma **coleção pronta com 105 requisições em 14 pastas** que percorrem toda a jornada e verificam códigos HTTP e trechos das respostas (aba *Tests*).

### Importar
1. Instale a extensão **Thunder Client** (`rangav.vscode-thunder-client`).
2. Aba **Collections** → menu `⋯` → **Import** → `thunder-client/greencode-api.collection.json`.
3. Aba **Env** → menu `⋯` (ou ícone de importar) → **Import** → `thunder-client/greencode-api.env.json`, e **ative** o ambiente `greencode-local`.
   - *Alternativa manual (caso a importação do ambiente falhe)*: crie um ambiente com `baseUrl = http://localhost:3000`, `adminUsuario = admin`, `adminSenha = Admin@12345`. As demais variáveis (`token`, `tokenGestor`, `orgId`…) são preenchidas sozinhas.

### Executar
Suba a API (`npm run dev`) com o banco semeado e rode a coleção na ordem das pastas (clique direito na coleção → **Run All**).

| Pasta | O que demonstra |
|---|---|
| 00 Infra | `/health`; guarda `{{ts}}` para gerar dados únicos |
| 01 Auth | Login, senha errada (401), `/auth/me`, renovação, sem token (401) |
| 02 Usuários | Criação de gestor e auditor; **RBAC** (gestor não cria usuário → 403) |
| 03 Organizações | CNPJ inválido (422), corpo inválido (400), permissões (403) |
| 04 Contratos | Criação, consulta, renovação válida e inválida |
| 05 Lotes | Data futura / > 90 dias (422), criação, equipamentos, início da triagem |
| 06 Equipamentos | Justificativa obrigatória (422), **versão desatualizada (409)**, `EM_DESMONTE` sem triagem (422), movimentação, rastreio, conclusão automática da triagem |
| 07 Relatórios | Por organização, por status, financeiro; gestor bloqueado (403) |
| 08 Journal/Parâmetros | Auditoria, parâmetros, lote aberto impede desativar organização (409) |
| 09 Parceiros e chaves | Cria parceiro e 3 chaves (completa, só leitura, limite 3/min); o segredo só aparece na criação |
| 10 Análises | Executa e persiste eficiência, rentabilidade e vida útil; histórico; valores de referência; execução assíncrona |
| 11 Fila | Resumo da fila, status de tarefa, relatório interno em CSV |
| 12 API PÚBLICA | `x-api-key`: 401/403/404/409/422, rastreabilidade, submissão de lote, relatórios assíncronos, **429 de rate limit** |
| 13 Revogação | Revoga a chave e confirma que ela passa a dar 401 |

As variáveis são encadeadas automaticamente (*set env var* a partir do JSON de resposta): `token`, `tokenGestor`, `tokenAuditor`, `orgId`, `loteId`, `equipId`, `equipId2`.

**Relatórios assíncronos:** após `POST /relatorios` o worker leva alguns segundos; se o download responder `409`, aguarde 2–5 s e repita a requisição (é o comportamento de *polling*). O teste de rate limit (pasta 12) usa janela de 1 minuto: se repetir a coleção em menos de 1 min, as 3 primeiras chamadas já virão `429`.

**Re-execução:** os dados de usuário e nota fiscal usam `{{ts}}` e se repetem sem conflito; o CNPJ da organização e o contrato são fixos, então em uma segunda rodada algumas requisições de criação retornarão `409` (esperado, e o `orgId` é recuperado por busca de CNPJ). Para começar do zero: `npm run db:reset`.

> Se alguma versão do Thunder Client não importar o arquivo, use o **Swagger UI** (`/api/v1/internal/docs` e `/api/v1/public/docs`): é possível autenticar (botão *Authorize*) e testar cada endpoint.

---

## 8. Regras de negócio

Migradas da Atividade 1 para `src/domain/` (puras e testadas) e aplicadas nos serviços:

- **CNPJ**: 14 dígitos + dígitos verificadores (módulo 11) e unicidade (aplicacional **e** `UNIQUE` no banco).
- **Data de entrada do lote**: não pode ser futura nem anterior a 90 dias (comparação em UTC). Se omitida, assume “agora”.
- **Estado físico**: queda de **2 ou mais categorias** exige `justificativa` textual (`NOVO < BOM_ESTADO < USADO_LEVE < USADO_MODERADO < DANIFICADO_LEVE < DANIFICADO_GRAVE < INSERVIVEL`).
- **Máquina de estados do equipamento**:

```
AGUARDANDO_TRIAGEM → EM_TRIAGEM → AGUARDANDO_DESMONTE → EM_DESMONTE → PECAS_REAPROVEITADAS ┐
                          │                                      ├──→ MATERIAL_RECICLAVEL   ├→ BAIXA_DEFINITIVA
                          └────────→ DESCARTE_SEGURO ←───────────┘                          ┘
```
  `EM_DESMONTE` **só** é alcançável a partir de `AGUARDANDO_DESMONTE` (triagem completa). Equipamento em `BAIXA_DEFINITIVA` é imutável.
- **Lote**: `RECEBIDO` → (`POST /triagem`) `EM_TRIAGEM` → (automático) `TRIAGEM_CONCLUIDA` → `ENCAMINHADO` → `FINALIZADO` (só com todos os equipamentos em `BAIXA_DEFINITIVA`). Só se alteram status de equipamentos depois de iniciar a triagem do lote. Nota fiscal é única por organização.
- **Organização**: não pode ser desativada com lotes não finalizados; organização desativada não recebe contrato nem lotes. Contrato é 1:1 opcional; renovação exige vencimento posterior ao atual.
- **Código de barras**: `PREFIXO-ANO-SEQUÊNCIA` (ex.: `NTB-2026-000042`), derivado de uma coluna `autoincrement` do PostgreSQL → único mesmo com concorrência.

---

## 9. Transações, concorrência e versionamento otimista

**Operações que usam `prisma.$transaction`** (tudo ou nada):

| Operação | O que é gravado atomicamente |
|---|---|
| Criar lote com equipamentos | lote + N equipamentos + N movimentações de recebimento + journal |
| Cadastrar organização com contrato | organização + contrato + journal |
| Iniciar triagem | lote + equipamentos (em massa) + movimentações + journal |
| Alterar status de equipamento | equipamento + **movimentação** + (se aplicável) conclusão da triagem do lote + journal |
| Demais alterações | entidade + journal |

O **journal entra na mesma transação**: se a operação falha, não sobra registro de auditoria “fantasma”; se confirma, a trilha está garantida.

**Bloqueio otimista**: todo modelo tem `versao`. Os `UPDATE`s são `updateMany({ where: { id, versao } })` com `versao: { increment: 1 }`; se `count !== 1`, retorna **409 `CONFLITO_DE_VERSAO`**. O cliente *pode* enviar `versao` no corpo (a comparação ocorre antes); se omitir, o *compare‑and‑set* ainda protege contra alterações simultâneas entre a leitura e a escrita dentro da requisição.

**Bloqueio pessimista pontual**: operações que dependem do conjunto de equipamentos do lote (adicionar equipamento, iniciar triagem, mudar status) fazem `SELECT … FOR UPDATE` no lote. Sem isso, duas requisições simultâneas poderiam concluir a triagem “ao mesmo tempo” e deixar o lote preso em `EM_TRIAGEM`, ou disputar a mesma posição no lote.

---

## 10. Segurança

- **JWT HS256** (`@fastify/jwt`), 30 min, com `sub`, `usuario` e `papel`. Algoritmo fixado na verificação.
- **bcrypt (`bcryptjs`)** para senhas; a comparação sempre roda contra um hash (mesmo se o usuário não existir) e a mensagem é única (“usuário ou senha inválidos”), reduzindo enumeração de usuários.
- **Rate limit** no login (`LOGIN_RATE_LIMIT_MAX`/min por IP).
- **RBAC** por rota (`authenticate` + `authorize`), negando por padrão.
- **Validação de entrada** por JSON Schema em todas as rotas (campos extras removidos, tipos e limites checados).
- **Erros** não vazam detalhes internos (500 genérico; detalhe só no log).
- **Prisma** usa consultas parametrizadas (sem SQL concatenado → sem injeção).
- **Journal imutável** (trigger bloqueia `UPDATE`/`DELETE`).
- `senhaHash` nunca é retornado pela API; `.env` fora do Git.

---

## 11. Decisões arquiteturais e trade-offs

| Decisão | Por quê | Alternativas rejeitadas / custo |
|---|---|---|
| **Monólito em camadas** | Implantação e depuração simples, coesão do código e transações ACID locais em um estágio inicial do negócio | Microsserviços: complexidade operacional e consistência distribuída sem necessidade hoje. Como as camadas são independentes, é possível extrair módulos depois |
| **Fastify** (e não Express) | JSON Schema nativo (validação + documentação OpenAPI da mesma fonte), plugins/hooks para auth e logging, melhor desempenho | Express: mais minimalista, porém exigiria libs extras para validação |
| **Prisma ORM** | Tipos TypeScript gerados do schema, migrações versionadas, transações e *eager loading* | SQL manual/Knex: mais controle, mais código e erros. Custo: `CHECK`/*trigger* ficam em SQL à parte (`constraints.sql`) |
| **PostgreSQL** | ACID, `JSON`, `UUID`, `CHECK`, *triggers*, `FOR UPDATE` | MySQL também serve; Postgres foi o recomendado e simplifica `Json` (cláusulas) |
| **JWT stateless** | A API não guarda sessão → escala horizontalmente, simples para SPA | Sessão em banco: revogação imediata, mas estado compartilhado. **Custo do JWT**: um token roubado vale até expirar e desativar usuário só surte efeito na expiração/renovação. Mitigações: validade curta (30 min), `/auth/renovar` relê o usuário no banco. Evolução: *refresh token* revogável + *denylist* |
| **`bcryptjs`** (e não `bcrypt`) | Mesmo algoritmo, **JavaScript puro**: instala igual em Windows e Ubuntu sem compilador (requisito de portabilidade) | `bcrypt` nativo é um pouco mais rápido, mas exige *build tools* no Windows. Argon2id é mais moderno (evolução possível) |
| **Journal no banco, na mesma transação** | Auditoria atômica com o dado; consulta por SQL | Arquivo (Atividade 1) não participa da transação do banco |
| **Concorrência otimista + `FOR UPDATE` pontual** | Conflitos são raros: otimista não segura locks e dá erro claro (409); lock só onde há invariantes no conjunto (lote) | Locks pessimistas em tudo: menos throughput e risco de *deadlock* |
| **Códigos via `autoincrement`** | Único sob concorrência, sem contador aplicacional | `COUNT()+1` (Atividade 1) gera colisão com requisições simultâneas |

---

## 12. Testes automatizados

```bash
npm test
```

Executa `tests/dominio.test.ts` e `tests/validadores.test.ts` (runner nativo do Node via `tsx --test`): regra de queda de estado, máquina de estados (incluindo a regra do desmonte), conclusão de triagem, transições do lote, código de barras, depreciação, CNPJ e data de entrada. **Não exigem banco.**

Os testes ponta a ponta (HTTP + banco) são a **coleção do Thunder Client** (seção 7).

---

## 13. Estrutura de pastas

```
greencode-api/
├── prisma/
│   ├── schema.prisma          Modelos, enums e relacionamentos
│   ├── seed.ts                Massa de dados representativa
│   └── sql/constraints.sql    CHECKs + trigger de imutabilidade do journal
├── src/
│   ├── server.ts              Inicialização + graceful shutdown
│   ├── app.ts                 Montagem do Fastify (plugins, Swagger, rotas)
│   ├── container.ts           Injeção de dependências
│   ├── config/env.ts          Variáveis de ambiente
│   ├── domain/                Enums, regras puras e validadores (reuso da Atividade 1)
│   ├── http/{rotas,controllers}/   Camada Controller (rotas/publico.ts = API pública)
│   ├── fila/                  Worker (retry/backoff), executor de tarefas e agendador node-cron
│   ├── services/              Camada Service (regras de negócio, transações)
│   ├── repositories/          Camada Repository (Prisma)
│   ├── plugins/               JWT/RBAC, chave de API e tratamento de erros
│   └── shared/                Erros, paginação, utilitários
├── tests/                     Testes de domínio e da camada analítica
├── docs/RELATORIO_TECNICO.md  Decisões, modelagem, retry e evolução (Atividade 3)
├── thunder-client/            Coleção e ambiente do Thunder Client
├── docker-compose.yml         PostgreSQL local
├── .env.example
└── .gitignore                 (node_modules, dist, .env…)
```

---

## 14. Limitações conhecidas

- Sem *refresh token* revogável nem logout server-side (o token vale até expirar; veja trade-offs).
- Relatórios são JSON (sem exportação PDF/CSV).
- `ValidadorDataEntrada` compara por dia em UTC: há tolerância de algumas horas conforme o fuso do cliente.
- Os testes automatizados cobrem o domínio; a jornada completa com banco é feita pela coleção do Thunder Client.
- Limitações específicas da Atividade 3: veja [seção 15.9](#159-limitações-e-evolução).
- O CLI da Atividade 1 não faz parte deste pacote; suas regras foram migradas para `src/domain` e os serviços.

---

## 15. Atividade 3: análises, API pública e fila

### 15.1 Visão geral

```
                    ┌────────────── API INTERNA  /api/v1/internal  (JWT) ─────────────┐
 Front-end / gestão │ auth, usuários, organizações, lotes, equipamentos, relatórios,   │
                    │ journal, parâmetros  +  analises, parceiros, tarefas              │
                    └──────────────────────────────┬───────────────────────────────────┘
                                                   │  mesmos Services (Controller → Service → Repository)
                    ┌────────────── API PÚBLICA  /api/v1/public  (x-api-key) ──────────┐
 Parceiros externos │ me, rastreabilidade, equipamentos, lotes (GET/POST), relatórios   │
                    │ assíncronos (POST 202 → status → download)                        │
                    └──────────────────────────────┬───────────────────────────────────┘
                                                   ▼
        PostgreSQL ◄── Tarefa (fila) ◄── enfileira ── API / node-cron (agendador)
            ▲                │
            │                └──► FilaWorker (embutido OU `npm run worker`): FOR UPDATE SKIP LOCKED,
            └── resultados_analise / previsoes_vida_util (histórico)   retry com backoff, recuperação de travadas
```

Segregação (pedida no enunciado): **dois prefixos, dois Swagger, duas formas de autenticação, duas políticas de segurança**. A API pública tem versão explícita na URL (`/api/v1`); uma incompatibilidade gera `/api/v2` e a v1 segue ativa durante a depreciação.

### 15.2 Camada analítica (3 categorias de insight)

Toda a matemática está em **funções puras** (`src/domain/estatistica.ts` e `src/domain/analise.ts`), cobertas por testes unitários (39 no total), e os serviços apenas buscam os dados e persistem o resultado.

| Análise | O que calcula | Método |
|---|---|---|
| **Eficiência operacional** (`eficiencia`) | Tempo da entrada do lote até a **conclusão da triagem** (média, mediana, desvio, p90); duração média **por etapa** e **gargalo**; comparação **entre operadores** (índice de eficiência); variação **por mês** e tendência | Estatística descritiva sobre a linha do tempo das `movimentacoes`; suavização exponencial simples (α = 0,5) para projetar o próximo mês |
| **Rentabilidade** (`rentabilidade`) | Valor estimado de recuperação de materiais por **tipo**, **estado físico**, **marca/modelo**; ranking e priorização | `valor = peso(kg) × R$/kg × fator do estado`. R$/kg vem de `valores_referencia` (precedência modelo > marca > tipo > padrão) |
| **Vida útil remanescente** (`vida-util`) | Por tipo: taxa de degradação, idade estimada até `INSERVIVEL`, vida remanescente média dos ativos, **R²** e **RMSE** em amostra reservada | **Regressão linear OLS** do índice de degradação (0=NOVO … 6=INSERVIVEL) × idade em anos |

> ⚠️ **Premissas do modelo de rentabilidade:** os valores R$/kg e os fatores por estado são **ilustrativos** (não há tabela de preços de mercado no sistema). O administrador calibra via `PUT /api/v1/internal/analises/valores-referencia`. Essa limitação está declarada no resultado (`premissas`).

**Persistência e histórico** (para consulta histórica e comparação): `resultados_analise` (snapshot completo em JSON + parâmetros + versão do modelo + duração), `previsoes_vida_util` (coeficientes por tipo a cada execução: série temporal do modelo) e `valores_referencia`. Os snapshots são **imutáveis** (trigger). `GET /analises/vida-util/modelos` mostra como a inclinação/R² evoluem entre execuções.

**Endpoints (internos):**

| Método | Rota | Papéis | Descrição |
|---|---|---|---|
| POST | `/analises/{eficiencia\|rentabilidade\|vida-util}/executar` | ADMIN | Calcula e persiste. Corpo opcional: `organizacaoId`, `inicio`, `fim`, `assincrono` (enfileira → 202) |
| GET | `/analises/{tipo}/ultimo` | ADMIN, AUDITOR | Último resultado persistido (global ou `?organizacaoId=`) |
| GET | `/analises/{tipo}/historico` | ADMIN, AUDITOR | Execuções anteriores (paginado) |
| GET | `/analises/resultados/{id}` | ADMIN, AUDITOR | Snapshot histórico completo |
| GET | `/analises/vida-util/modelos` | ADMIN, AUDITOR | Série histórica dos modelos por tipo |
| GET/PUT | `/analises/valores-referencia` | GET: ADMIN, AUDITOR · PUT: ADMIN | R$/kg por tipo/marca/modelo |

### 15.3 API pública para parceiros

**Autenticação por chave de API** — cabeçalho `x-api-key: gck_<prefixo>_<segredo>`:
- A chave é gerada por `POST /api/v1/internal/parceiros/{id}/chaves` (ADMIN) e **o segredo é mostrado uma única vez**. No banco fica apenas o **SHA-256** (`hashChave`) e um `prefixo` público para localizar o registro.
- Comparação do hash em **tempo constante** (`timingSafeEqual`); mensagem de erro única (não revela se a chave existe).
- Cada chave tem **escopos** (`RASTREABILIDADE_LER`, `LOTES_LER`, `LOTES_ESCREVER`, `ANALISES_LER`), **limite por minuto** próprio, **expiração** opcional e pode ser **revogada** a qualquer momento (`DELETE`). Desativar o parceiro bloqueia todas as suas chaves.
- **Escopo de dados:** o parceiro é vinculado a uma **organização** e só enxerga/gera dados dela. Recurso de outra organização responde `404` (não revela existência). Visão de todas as organizações exige `acessoGlobal` concedido explicitamente. Parceiro cria lotes **sempre na própria organização**.
- Respostas por **DTOs próprios** (sem `versao`, journal ou nomes de operadores internos).

**Rate limit por chave** (`@fastify/rate-limit`): cada chave tem seu contador e seu limite; ao exceder, `429 LIMITE_EXCEDIDO` com `retry-after` e cabeçalhos `x-ratelimit-*` em toda resposta.

| Método | Rota | Escopo | Descrição |
|---|---|---|---|
| GET | `/me` | qualquer | Parceiro, escopos e limite da chave |
| GET | `/rastreabilidade/{codigo}` | `RASTREABILIDADE_LER` | Status e histórico de um equipamento pelo código de barras |
| GET | `/equipamentos` | `RASTREABILIDADE_LER` | Lista (filtros `loteId`, `status`, `tipo`; paginado) |
| GET | `/lotes`, `/lotes/{id}` | `LOTES_LER` | Consulta |
| POST | `/lotes` | `LOTES_ESCREVER` | Submete lote (+ equipamentos) na organização do parceiro; NF única = reenvio seguro (409) |
| POST | `/relatorios` | `ANALISES_LER` | Solicita relatório assíncrono → **202** + `id` + `Location` |
| GET | `/relatorios/{id}` | `ANALISES_LER` | Status (polling): `PENDENTE` → `EM_EXECUCAO` → `CONCLUIDA`/`FALHA` |
| GET | `/relatorios/{id}/download` | `ANALISES_LER` | Baixa CSV/JSON (409 se ainda não pronto) |

Tipos de relatório: `EQUIPAMENTOS_PREDITIVO` (todos os equipamentos **ativos** do parceiro, com valor estimado de recuperação e vida útil remanescente), `RENTABILIDADE`, `EFICIENCIA`, `VIDA_UTIL`. Formatos `JSON` (padrão) e `CSV` (RFC 4180, BOM UTF-8 para o Excel, com **proteção contra CSV injection**).

**Exemplo (curl):**

```bash
KEY="gck_xxxxxxxxxx_..."   # entregue pelo administrador

curl -H "x-api-key: $KEY" http://localhost:3000/api/v1/public/me

curl -H "x-api-key: $KEY" http://localhost:3000/api/v1/public/rastreabilidade/NTB-2026-000042

# relatório assíncrono
curl -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
     -d '{"tipo":"EQUIPAMENTOS_PREDITIVO","formato":"CSV"}' \
     http://localhost:3000/api/v1/public/relatorios          # -> 202 {"id":"...","statusUrl":"..."}
curl -H "x-api-key: $KEY" http://localhost:3000/api/v1/public/relatorios/<id>            # polling
curl -H "x-api-key: $KEY" -OJ http://localhost:3000/api/v1/public/relatorios/<id>/download
```

> No **PowerShell** use `curl.exe` (e não `curl`, que é alias de `Invoke-WebRequest`) ou o Thunder Client.

A chave de demonstração do seed (parceiro "Banco Alfa - Integracao ERP") é **impressa uma única vez** no terminal ao rodar `npm run db:seed`. Se perdê-la, gere outra com `POST /api/v1/internal/parceiros/{id}/chaves`.

**Gestão (interna, ADMIN):** `POST/GET /parceiros`, `PATCH /parceiros/{id}`, `POST/GET /parceiros/{id}/chaves`, `DELETE /parceiros/{id}/chaves/{chaveId}`.

### 15.4 Processamento assíncrono (fila)

Em vez de BullMQ + Redis, a fila usa **o próprio PostgreSQL** (tabela `tarefas`). O enunciado diz que o BullMQ é uma opção ("você pode"); esta escolha evita instalar/operar o Redis (especialmente penoso no Windows, requisito do projeto) e permite **enfileirar na mesma transação** dos dados. O ganho de escala do BullMQ fica documentado como evolução ([relatório técnico](docs/RELATORIO_TECNICO.md)).

- **Reivindicação atômica:** `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING …`. Vários workers (processos/máquinas) consomem a mesma tabela sem pegar a mesma tarefa e sem se bloquear.
- **Worker embutido ou standalone:** por padrão roda dentro da API (`WORKER_EMBUTIDO=true`). Para escalar: `WORKER_EMBUTIDO=false` na API e `npm run worker` (ou `npm run start:worker`) em quantas instâncias quiser.
- **Concorrência** limitada por worker (`WORKER_CONCORRENCIA`, padrão 2), polling a cada `WORKER_INTERVALO_MS` (2 s).
- **Política de retry:** falha **retentável** com tentativas restantes → volta a `PENDENTE` com **backoff exponencial + jitter ±20%** (`min(5 s × 2^(n-1), 5 min)`); falha **não retentável** (regra de negócio/payload inválido) ou tentativas esgotadas (`TAREFA_MAX_TENTATIVAS`, padrão 3) → `FALHA` (estado final, com o erro registrado). O admin pode `POST /tarefas/{id}/reenfileirar`.
- **Recuperação de travadas:** se o worker cai no meio da tarefa, ela fica `EM_EXECUCAO`; após `TAREFA_TRAVADA_TIMEOUT_MS` (5 min) volta para a fila (ou vai a `FALHA` se esgotou as tentativas).
- **Retenção:** relatórios concluídos expiram após `RELATORIO_RETENCAO_HORAS` (24 h) e são apagados pela limpeza agendada.
- **Shutdown gracioso:** SIGINT/SIGTERM param o agendador, esperam as tarefas em andamento, fecham o HTTP e o pool do Prisma.
- **Monitoramento:** `GET /api/v1/internal/tarefas/resumo` (contagem por status) e `GET /tarefas`.

### 15.5 Tarefas agendadas (`node-cron`)

O agendador apenas **enfileira**; quem executa (com retry) é o worker. Fuso `America/Sao_Paulo`.

| Tarefa | Padrão (cron) | Variável |
|---|---|---|
| Executar as 3 análises globais e persistir no histórico (não empilha se a anterior ainda não terminou) | `0 2 * * *` (todo dia às 02:00) | `ANALISES_CRON` |
| Remover relatórios expirados | `*/30 * * * *` | `LIMPEZA_CRON` |

Com várias instâncias da API, deixe `SCHEDULER_HABILITADO=true` em **apenas uma**.

### 15.6 Variáveis de ambiente novas

`WORKER_EMBUTIDO`, `WORKER_INTERVALO_MS`, `WORKER_CONCORRENCIA`, `TAREFA_MAX_TENTATIVAS`, `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS`, `TAREFA_TRAVADA_TIMEOUT_MS`, `RELATORIO_RETENCAO_HORAS`, `SCHEDULER_HABILITADO`, `ANALISES_CRON`, `LIMPEZA_CRON`, `CRON_TIMEZONE` (todas com padrão; veja `.env.example`).

### 15.7 Como rodar a Atividade 3

Quem já tinha a Atividade 2 rodando precisa **aplicar o novo schema** (novas tabelas) e **reaplicar as constraints**:

```bash
npm install                 # novas dependências (node-cron)
npm run db:migrate          # gera/aplica a migração da Atividade 3 (informe um nome, ex.: atividade3)
npm run db:constraints      # CHECKs e triggers novos (idempotente)
npm run db:seed             # valores de referência, parceiro demo + chave (impressa 1x) e massa analítica
npm run dev
```

Ambiente novo: `npm run db:init`, `npm run db:constraints`, `npm run db:seed`, `npm run dev` (como na seção 3). Com o seed rodado, execute `POST /api/v1/internal/analises/eficiencia/executar` (ou a coleção do Thunder Client) para ver resultados: a massa analítica cobre ~3 meses, 8 lotes, 2 operadores com ritmos diferentes e equipamentos cuja degradação cresce com a idade.

### 15.8 Testes

```bash
npm test      # 39 testes: domínio, estatística (valores conferidos à mão), os 3 modelos, CSV, chaves de API e backoff
```

A jornada completa (inclusive API pública, 429 e revogação) é a coleção do Thunder Client (pastas 09–13).

### 15.9 Limitações e evolução

- A **massa analítica é sintética** (seed determinístico). Em produção os modelos aprendem com dados reais, e **vida útil** usa corte transversal (estado × idade); com histórico por equipamento, o próximo passo é série temporal/ sobrevivência.
- **Valores de recuperação** são premissas editáveis, não preços de mercado.
- O **rate limit** é em memória (por processo): com várias instâncias da API, cada uma conta separado. Evolução: store Redis do `@fastify/rate-limit` ou limite no gateway.
- Notificação por **webhook** não foi implementada (polling apenas): exigiria assinatura HMAC e proteção contra SSRF.
- Fila no PostgreSQL atende de centenas a poucos milhares de tarefas/min; acima disso, migrar para BullMQ + Redis (a interface `TarefaRepository`/`FilaWorker` isola essa troca).
- **Não foi possível executar a API contra um PostgreSQL real no ambiente de desenvolvimento deste pacote** (sem acesso ao npm): a lógica de domínio/analítica tem 39 testes automatizados, mas a integração com Prisma/Fastify deve ser validada com a coleção do Thunder Client.
