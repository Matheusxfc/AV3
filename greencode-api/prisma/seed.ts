/**
 * Seed do greencode (ambiente de desenvolvimento).
 *   - Usuarios: um por papel (senhas de DEV, trocar em qualquer ambiente real).
 *   - Dados de negocio representativos: organizacoes (com/sem contrato, contrato a vencer),
 *     lotes em varios status, equipamentos em varios estados fisicos e status de rastreamento,
 *     movimentacoes coerentes com a maquina de estados e entradas de journal.
 * Idempotente: se ja houver organizacoes, os dados de demonstracao nao sao recriados.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient, EstadoFisico, StatusLote, StatusRastreamento, TipoEquipamento, PapelUsuario } from '@prisma/client';
import { gerarCodigoBarras } from '../src/domain/regras';
import { ValidadorCNPJ } from '../src/domain/validadores/ValidadorCNPJ';
import { VALOR_REFERENCIA_PADRAO } from '../src/domain/analise';
import { gerarChave } from '../src/domain/apikey';

const prisma = new PrismaClient();
const rounds = Number(process.env.BCRYPT_ROUNDS ?? 10);

const diasAtras = (n: number) => new Date(Date.now() - n * 86_400_000);
const diasAFrente = (n: number) => new Date(Date.now() + n * 86_400_000);

async function usuarios() {
  const adminUsuario = process.env.ADMIN_USUARIO ?? 'admin';
  const adminSenha = process.env.ADMIN_SENHA ?? 'Admin@12345';
  const lista: { usuario: string; senha: string; papel: PapelUsuario }[] = [
    { usuario: adminUsuario, senha: adminSenha, papel: 'ADMINISTRADOR' },
    { usuario: 'operador', senha: 'Operador@123', papel: 'OPERADOR_CADASTRO' },
    { usuario: 'almoxarife', senha: 'Almox@12345', papel: 'GESTOR_ALMOXARIFADO' },
    { usuario: 'auditor', senha: 'Auditor@123', papel: 'AUDITOR' },
    { usuario: 'almoxarife2', senha: 'Almox2@12345', papel: 'GESTOR_ALMOXARIFADO' },
  ];
  for (const u of lista) {
    const existente = await prisma.usuario.findUnique({ where: { usuario: u.usuario } });
    if (existente) continue;
    await prisma.usuario.create({ data: { usuario: u.usuario, senhaHash: await bcrypt.hash(u.senha, rounds), papel: u.papel } });
    console.log(`  usuario criado: ${u.usuario} (${u.papel})`);
  }
  return adminUsuario;
}

// Trajetorias validas da maquina de estados (do inicio ate o status final desejado).
const TRAJETO: Record<string, StatusRastreamento[]> = {
  AGUARDANDO_TRIAGEM: ['AGUARDANDO_TRIAGEM'],
  EM_TRIAGEM: ['AGUARDANDO_TRIAGEM', 'EM_TRIAGEM'],
  AGUARDANDO_DESMONTE: ['AGUARDANDO_TRIAGEM', 'EM_TRIAGEM', 'AGUARDANDO_DESMONTE'],
  EM_DESMONTE: ['AGUARDANDO_TRIAGEM', 'EM_TRIAGEM', 'AGUARDANDO_DESMONTE', 'EM_DESMONTE'],
  PECAS_REAPROVEITADAS: ['AGUARDANDO_TRIAGEM', 'EM_TRIAGEM', 'AGUARDANDO_DESMONTE', 'EM_DESMONTE', 'PECAS_REAPROVEITADAS'],
};

interface EqSeed {
  tipo: TipoEquipamento;
  marca: string;
  modelo: string;
  ano: number;
  estado: EstadoFisico;
  peso: number;
  status: keyof typeof TRAJETO;
}

async function criarLote(
  organizacaoId: string,
  razao: string,
  nf: string,
  transportadora: string,
  dias: number,
  status: StatusLote,
  equipamentos: EqSeed[],
  responsavel: string,
) {
  const lote = await prisma.lote.create({
    data: { organizacaoId, notaFiscal: nf, transportadora, dataEntrada: diasAtras(dias), statusProcessamento: status },
  });
  let pos = 1;
  for (const e of equipamentos) {
    const prov = await prisma.equipamento.create({
      data: {
        codigoBarrasInterno: `PENDENTE-${lote.id}-${pos}`,
        tipo: e.tipo, marca: e.marca, modelo: e.modelo, anoFabricacao: e.ano, estadoFisico: e.estado,
        pesoQuilogramas: e.peso, loteId: lote.id, posicaoNoLote: pos, statusRastreamento: e.status,
      },
    });
    const eq = await prisma.equipamento.update({
      where: { id: prov.id },
      data: { codigoBarrasInterno: gerarCodigoBarras(e.tipo, prov.sequencia) },
    });
    pos++;

    const trajeto = TRAJETO[e.status];
    await prisma.movimentacao.create({
      data: { equipamentoId: eq.id, origem: `ORGANIZACAO: ${razao}`, destino: 'RECEBIMENTO (AGUARDANDO_TRIAGEM)', responsavel, observacao: `Lote ${nf}`, dataHora: diasAtras(dias) },
    });
    for (let i = 1; i < trajeto.length; i++) {
      await prisma.movimentacao.create({
        data: { equipamentoId: eq.id, origem: trajeto[i - 1], destino: trajeto[i], responsavel, observacao: 'seed', dataHora: diasAtras(Math.max(0, dias - i)) },
      });
    }
  }
  await prisma.journalTransacao.create({
    data: { operacao: 'CREATE', entidade: 'Lote', entidadeId: lote.id, dadosDepois: { notaFiscal: nf, status, equipamentos: equipamentos.length }, usuarioResponsavel: responsavel },
  });
  return lote;
}

async function demo(responsavel: string) {
  if ((await prisma.organizacao.count()) > 0) {
    console.log('  organizacoes ja existem: dados de demonstracao ignorados.');
    return;
  }

  // CNPJs validos (digitos verificadores calculados pelo ValidadorCNPJ).
  const cnpjA = ValidadorCNPJ.completar('112223330001');
  const cnpjB = ValidadorCNPJ.completar('457231740001');
  const cnpjC = ValidadorCNPJ.completar('334455660001');

  const orgA = await prisma.organizacao.create({
    data: {
      razaoSocial: 'Banco Alfa S.A.', cnpj: cnpjA, enderecoCompleto: 'Av. Paulista, 1000 - Sao Paulo/SP', email: 'ti@bancoalfa.example',
      contrato: { create: { dataVencimento: diasAFrente(365), valorMensal: 8500, renovacaoAutomatica: true, clausulas: ['Coleta quinzenal', 'Certificado de destinacao', 'Rastreabilidade por equipamento'] } },
    },
  });
  const orgB = await prisma.organizacao.create({
    data: {
      razaoSocial: 'Hospital Municipal Central', cnpj: cnpjB, enderecoCompleto: 'Rua da Saude, 50 - Sao Jose dos Campos/SP', email: 'infra@hmc.example',
      // contrato A VENCER em 20 dias (cenario de renovacao)
      contrato: { create: { dataVencimento: diasAFrente(20), valorMensal: 4200.5, clausulas: ['Coleta mensal'] } },
    },
  });
  const orgC = await prisma.organizacao.create({
    data: { razaoSocial: 'Universidade Publica Federal', cnpj: cnpjC, enderecoCompleto: 'Campus Universitario, s/n', email: 'logistica@upf.example' }, // SEM contrato
  });
  for (const o of [orgA, orgB, orgC]) {
    await prisma.journalTransacao.create({ data: { operacao: 'CREATE', entidade: 'Organizacao', entidadeId: o.id, dadosDepois: { razaoSocial: o.razaoSocial }, usuarioResponsavel: responsavel } });
  }

  // L1: triagem concluida (nenhum equipamento aguardando/em triagem)
  await criarLote(orgA.id, orgA.razaoSocial, 'NF-1001', 'TransRapida', 40, 'TRIAGEM_CONCLUIDA', [
    { tipo: 'COMPUTADOR_MESA', marca: 'Dell', modelo: 'OptiPlex 3080', ano: 2019, estado: 'USADO_MODERADO', peso: 7.8, status: 'EM_DESMONTE' },
    { tipo: 'NOTEBOOK', marca: 'Lenovo', modelo: 'ThinkPad E14', ano: 2020, estado: 'BOM_ESTADO', peso: 1.8, status: 'AGUARDANDO_DESMONTE' },
    { tipo: 'MONITOR', marca: 'LG', modelo: '24MK430H', ano: 2018, estado: 'DANIFICADO_LEVE', peso: 3.4, status: 'PECAS_REAPROVEITADAS' },
  ], responsavel);

  // L2: recem-recebido (RECEBIDO), todos aguardando triagem
  await criarLote(orgB.id, orgB.razaoSocial, 'NF-2001', 'LogHospitalar', 3, 'RECEBIDO', [
    { tipo: 'SERVIDOR', marca: 'HP', modelo: 'ProLiant DL360', ano: 2016, estado: 'USADO_LEVE', peso: 14.2, status: 'AGUARDANDO_TRIAGEM' },
    { tipo: 'IMPRESSORA', marca: 'Epson', modelo: 'L3150', ano: 2021, estado: 'DANIFICADO_GRAVE', peso: 3.9, status: 'AGUARDANDO_TRIAGEM' },
  ], responsavel);

  // L3: em triagem (mistura de EM_TRIAGEM e AGUARDANDO_DESMONTE)
  await criarLote(orgA.id, orgA.razaoSocial, 'NF-1002', 'TransRapida', 5, 'EM_TRIAGEM', [
    { tipo: 'NOTEBOOK', marca: 'Dell', modelo: 'Latitude 5400', ano: 2019, estado: 'INSERVIVEL', peso: 1.9, status: 'EM_TRIAGEM' },
    { tipo: 'ROTEADOR', marca: 'Cisco', modelo: 'RV340', ano: 2017, estado: 'USADO_LEVE', peso: 1.1, status: 'AGUARDANDO_DESMONTE' },
    { tipo: 'FONTE_ALIMENTACAO', marca: 'Corsair', modelo: 'CV550', ano: 2020, estado: 'NOVO', peso: 1.4, status: 'EM_TRIAGEM' },
  ], responsavel);

  await prisma.parametro.upsert({ where: { chave: 'coeficienteDepreciacaoAnual' }, create: { chave: 'coeficienteDepreciacaoAnual', valor: 0.2 }, update: {} });
  await prisma.parametro.upsert({ where: { chave: 'aliquotaImpostoPadrao' }, create: { chave: 'aliquotaImpostoPadrao', valor: 0 }, update: {} });

  console.log('  dados de demonstracao criados: 3 organizacoes, 3 lotes, 8 equipamentos.');
}


// ======================================================================================
// ATIVIDADE 3: valores de referencia, parceiro de demonstracao e massa de dados analitica
// ======================================================================================

async function valoresReferencia() {
  for (const [tipo, valor] of Object.entries(VALOR_REFERENCIA_PADRAO)) {
    await prisma.valorReferencia.upsert({
      where: { tipo_marca_modelo: { tipo: tipo as TipoEquipamento, marca: '', modelo: '' } },
      create: { tipo: tipo as TipoEquipamento, marca: '', modelo: '', valorPorKg: valor },
      update: {},
    });
  }
  // Exemplo de ajuste por marca/modelo (precedencia: modelo > marca > tipo)
  await prisma.valorReferencia.upsert({
    where: { tipo_marca_modelo: { tipo: 'NOTEBOOK', marca: 'Dell', modelo: 'Latitude 5400' } },
    create: { tipo: 'NOTEBOOK', marca: 'Dell', modelo: 'Latitude 5400', valorPorKg: 42 }, update: {},
  });
  console.log('  valores de referencia (R$/kg) garantidos.');
}

async function demoParceiro() {
  const orgA = await prisma.organizacao.findUnique({ where: { cnpj: ValidadorCNPJ.completar('112223330001') } });
  if (!orgA) return;
  if (await prisma.parceiro.findUnique({ where: { nome: 'Banco Alfa - Integracao ERP' } })) return;
  const parceiro = await prisma.parceiro.create({
    data: { nome: 'Banco Alfa - Integracao ERP', email: 'integracao@bancoalfa.example', organizacaoId: orgA.id },
  });
  const { chave, prefixo, hash } = gerarChave();
  await prisma.chaveApi.create({
    data: {
      parceiroId: parceiro.id, nome: 'Chave de demonstracao', prefixo, hashChave: hash, limitePorMinuto: 120,
      escopos: ['RASTREABILIDADE_LER', 'LOTES_LER', 'LOTES_ESCREVER', 'ANALISES_LER'],
    },
  });
  console.log('  parceiro de demonstracao criado: "Banco Alfa - Integracao ERP"');
  console.log(`  >>> CHAVE DE API DE DEMONSTRACAO (aparece so agora): ${chave}`);
}

/** PRNG deterministico (mulberry32): o seed gera sempre os mesmos dados. */
function prng(semente: number) {
  let a = semente;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORDEM: EstadoFisico[] = ['NOVO', 'BOM_ESTADO', 'USADO_LEVE', 'USADO_MODERADO', 'DANIFICADO_LEVE', 'DANIFICADO_GRAVE', 'INSERVIVEL'];
const CATALOGO: Record<string, { marca: string; modelo: string; peso: number }[]> = {
  NOTEBOOK: [{ marca: 'Dell', modelo: 'Latitude 5400', peso: 1.9 }, { marca: 'Lenovo', modelo: 'ThinkPad E14', peso: 1.8 }, { marca: 'HP', modelo: 'ProBook 450', peso: 2.1 }],
  COMPUTADOR_MESA: [{ marca: 'Dell', modelo: 'OptiPlex 3080', peso: 7.8 }, { marca: 'HP', modelo: 'ProDesk 400', peso: 6.9 }],
  MONITOR: [{ marca: 'LG', modelo: '24MK430H', peso: 3.4 }, { marca: 'Samsung', modelo: 'S24F350', peso: 3.2 }],
};
const FINAIS: StatusRastreamento[] = ['PECAS_REAPROVEITADAS', 'MATERIAL_RECICLAVEL', 'DESCARTE_SEGURO'];

async function demoAnalitico() {
  if ((await prisma.lote.count({ where: { notaFiscal: { startsWith: 'NF-AN-' } } })) > 0) {
    console.log('  massa analitica ja existe: ignorada.');
    return;
  }
  const orgs = await prisma.organizacao.findMany({ orderBy: { razaoSocial: 'asc' }, take: 2 });
  if (orgs.length < 2) return;
  const rnd = prng(20260101);
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5; // ~[-1, 1]
  const agora = Date.now();

  // [dias atras, equipamentos, destino do lote]
  const plano: [number, number, 'FINALIZADO' | 'TRIAGEM_CONCLUIDA' | 'EM_TRIAGEM'][] = [
    [82, 8, 'FINALIZADO'], [71, 7, 'FINALIZADO'], [60, 8, 'FINALIZADO'], [49, 7, 'FINALIZADO'], [38, 8, 'FINALIZADO'],
    [26, 7, 'TRIAGEM_CONCLUIDA'], [15, 8, 'TRIAGEM_CONCLUIDA'], [4, 6, 'EM_TRIAGEM'],
  ];
  let totalEq = 0;
  for (const [i, [dias, qtd, destino]] of plano.entries()) {
    const org = orgs[i % 2];
    const entrada = new Date(agora - dias * 86_400_000);
    const lote = await prisma.lote.create({
      data: { organizacaoId: org.id, notaFiscal: `NF-AN-${String(i + 1).padStart(3, '0')}`, transportadora: i % 2 ? 'LogHospitalar' : 'TransRapida', dataEntrada: entrada, statusProcessamento: destino },
    });
    const movs: { equipamentoId: string; origem: string; destino: string; responsavel: string; observacao: string; dataHora: Date }[] = [];

    for (let pos = 1; pos <= qtd; pos++) {
      const tipo = (['NOTEBOOK', 'NOTEBOOK', 'COMPUTADOR_MESA', 'MONITOR'] as const)[Math.floor(rnd() * 4)];
      const cat = CATALOGO[tipo][Math.floor(rnd() * CATALOGO[tipo].length)];
      const idade = 1 + Math.floor(rnd() * 9);
      // degradacao ~0,85 categoria/ano + ruido  => regressao com R2 alto e inclinacao ~0,85
      const idx = Math.max(0, Math.min(6, Math.round(0.85 * idade + gauss() * 0.9)));
      const estado = ORDEM[idx];
      const ano = new Date().getFullYear() - idade;

      // profundidade do trajeto (quantos status foram atingidos)
      const profundidade = destino === 'FINALIZADO' ? 6 : destino === 'TRIAGEM_CONCLUIDA' ? 3 + Math.floor(rnd() * 3) : pos === 1 ? 2 : 2 + Math.floor(rnd() * 2);
      const final = FINAIS[Math.floor(rnd() * FINAIS.length)];
      const seq: StatusRastreamento[] = ['AGUARDANDO_TRIAGEM', 'EM_TRIAGEM', 'AGUARDANDO_DESMONTE', 'EM_DESMONTE', final, 'BAIXA_DEFINITIVA'];
      const atingidos = seq.slice(0, profundidade);

      const prov = await prisma.equipamento.create({
        data: {
          codigoBarrasInterno: `PENDENTE-${lote.id}-${pos}`, tipo, marca: cat.marca, modelo: cat.modelo, anoFabricacao: ano, estadoFisico: estado,
          pesoQuilogramas: Number((cat.peso * (0.9 + rnd() * 0.2)).toFixed(3)), loteId: lote.id, posicaoNoLote: pos,
          statusRastreamento: atingidos[atingidos.length - 1],
        },
      });
      await prisma.equipamento.update({ where: { id: prov.id }, data: { codigoBarrasInterno: gerarCodigo(tipo, prov.sequencia) } });
      totalEq++;

      // linha do tempo: operador B (almoxarife2) e mais lento na triagem que o A (almoxarife)
      const operador = rnd() < 0.5 ? 'almoxarife' : 'almoxarife2';
      const dur = {
        espera: 2 + rnd() * 8,
        triagem: operador === 'almoxarife' ? 8 + gauss() * 3 : 15 + gauss() * 5,
        aguardaDesmonte: 6 + rnd() * 24,
        desmonte: 10 + rnd() * 30,
        destino: 4 + rnd() * 8,
      };
      let t = entrada.getTime();
      const push = (origem: string, dest: string, resp: string) =>
        movs.push({ equipamentoId: prov.id, origem, destino: dest, responsavel: resp, observacao: 'seed analitico', dataHora: new Date(Math.min(t, agora)) });
      push(`ORGANIZACAO: ${org.razaoSocial}`, 'RECEBIMENTO (AGUARDANDO_TRIAGEM)', 'almoxarife');
      const passos: [number, string][] = [
        [dur.espera, 'almoxarife'], [dur.triagem, operador], [dur.aguardaDesmonte, 'almoxarife'], [dur.desmonte, 'almoxarife'], [dur.destino, 'almoxarife'],
      ];
      for (let k = 1; k < atingidos.length; k++) {
        t += passos[k - 1][0] * 3_600_000;
        push(atingidos[k - 1], atingidos[k], passos[k - 1][1]);
      }
    }
    await prisma.movimentacao.createMany({ data: movs });
  }
  console.log(`  massa analitica criada: ${plano.length} lotes, ${totalEq} equipamentos (2 operadores, ~3 meses).`);
}

// mesmo formato usado pela API (PREFIXO-ANO-SEQUENCIA)
function gerarCodigo(tipo: string, sequencia: number): string {
  const p: Record<string, string> = { NOTEBOOK: 'NTB', COMPUTADOR_MESA: 'CPU', MONITOR: 'MON' };
  return `${p[tipo] ?? 'EQP'}-${new Date().getFullYear()}-${String(sequencia).padStart(6, '0')}`;
}

async function main() {
  console.log('Seed greencode...');
  const admin = await usuarios();
  await demo(admin);
  await valoresReferencia();
  await demoParceiro();
  await demoAnalitico();
  console.log('Seed concluido.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
