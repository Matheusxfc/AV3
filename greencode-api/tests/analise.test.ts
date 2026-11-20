import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ajustarModelosVida, calcularEficiencia, calcularRentabilidade, extrairStatus, resolverValorPorKg,
  valorEstimadoRecuperacao, vidaRemanescenteAnos, EquipVida, MovAnalise, ValorRef,
} from '../src/domain/analise';

const h = (base: string, horas: number) => new Date(new Date(base).getTime() + horas * 3_600_000);
const T0 = '2026-09-01T00:00:00Z';

// ---------------- rentabilidade ----------------
test('valor de recuperacao: peso x valor/kg x fator do estado', () => {
  assert.equal(valorEstimadoRecuperacao(2, 35, 'BOM_ESTADO'), 2 * 35 * 0.85);
  assert.equal(valorEstimadoRecuperacao(10, 10, 'INSERVIVEL'), 10);
});

test('precedencia dos valores de referencia: modelo > marca > tipo > padrao', () => {
  const refs: ValorRef[] = [
    { tipo: 'NOTEBOOK', marca: '', modelo: '', valorPorKg: 40 },
    { tipo: 'NOTEBOOK', marca: 'Dell', modelo: '', valorPorKg: 45 },
    { tipo: 'NOTEBOOK', marca: 'Dell', modelo: 'Latitude', valorPorKg: 50 },
  ];
  assert.deepEqual(resolverValorPorKg(refs, 'NOTEBOOK', 'dell', 'LATITUDE'), { valorPorKg: 50, origem: 'MODELO' });
  assert.deepEqual(resolverValorPorKg(refs, 'NOTEBOOK', 'Dell', 'XPS'), { valorPorKg: 45, origem: 'MARCA' });
  assert.deepEqual(resolverValorPorKg(refs, 'NOTEBOOK', 'HP', 'X'), { valorPorKg: 40, origem: 'TIPO' });
  assert.deepEqual(resolverValorPorKg([], 'MONITOR', 'LG', 'X'), { valorPorKg: 12, origem: 'PADRAO' });
});

test('rentabilidade: ranking por valor medio, por estado e priorizacao', () => {
  const r = calcularRentabilidade([
    { tipo: 'SERVIDOR', marca: 'HP', modelo: 'DL360', estadoFisico: 'BOM_ESTADO', pesoQuilogramas: 14 },
    { tipo: 'SERVIDOR', marca: 'HP', modelo: 'DL360', estadoFisico: 'USADO_MODERADO', pesoQuilogramas: 14 },
    { tipo: 'MONITOR', marca: 'LG', modelo: 'X', estadoFisico: 'BOM_ESTADO', pesoQuilogramas: 3 },
    { tipo: 'IMPRESSORA', marca: 'Epson', modelo: 'L3', estadoFisico: 'INSERVIVEL', pesoQuilogramas: 4 },
  ], []);
  assert.equal(r.totalEquipamentos, 4);
  assert.equal(r.porTipo[0].tipo, 'SERVIDOR');
  assert.equal(r.porTipo[0].ranking, 1);
  assert.equal(r.porTipo[r.porTipo.length - 1].tipo, 'IMPRESSORA');
  // servidor: 14*40*0.85=476 e 14*40*0.5=280 -> media 378
  assert.equal(r.porTipo[0].valorMedio, 378);
  assert.deepEqual(r.priorizacao, ['SERVIDOR', 'MONITOR', 'IMPRESSORA']);
  assert.ok(r.porEstado.every((e) => e.quantidade > 0));
});

test('rentabilidade: lista vazia nao quebra', () => {
  const r = calcularRentabilidade([], []);
  assert.equal(r.totalEquipamentos, 0);
  assert.equal(r.valorMedioPorEquipamento, null);
});

// ---------------- eficiencia ----------------
test('extrairStatus: status puro e RECEBIMENTO (STATUS); texto livre e ignorado', () => {
  assert.equal(extrairStatus('EM_TRIAGEM'), 'EM_TRIAGEM');
  assert.equal(extrairStatus('RECEBIMENTO (AGUARDANDO_TRIAGEM)'), 'AGUARDANDO_TRIAGEM');
  assert.equal(extrairStatus('Bancada de desmonte 3'), null);
  assert.equal(extrairStatus('ORGANIZACAO: X'), null);
});

function movs(equip: string, lote: string, trajeto: [string, number, string][]): MovAnalise[] {
  return trajeto.map(([destino, horas, resp]) => ({ equipamentoId: equip, loteId: lote, destino, dataHora: h(T0, horas), responsavel: resp }));
}

test('eficiencia: etapas, gargalo, operadores e tempo do lote', () => {
  const m = [
    // equipamento A: espera 2h, triagem 10h (ana), aguarda desmonte 5h, ...
    ...movs('A', 'L1', [['RECEBIMENTO (AGUARDANDO_TRIAGEM)', 0, 'sys'], ['EM_TRIAGEM', 2, 'ana'], ['AGUARDANDO_DESMONTE', 12, 'ana'], ['EM_DESMONTE', 17, 'bia']]),
    // equipamento B: espera 4h, triagem 20h (bia)
    ...movs('B', 'L1', [['RECEBIMENTO (AGUARDANDO_TRIAGEM)', 0, 'sys'], ['EM_TRIAGEM', 4, 'bia'], ['AGUARDANDO_DESMONTE', 24, 'bia'], ['Bancada 3', 25, 'bia']]),
  ];
  const r = calcularEficiencia(m, [{ id: 'L1', dataEntrada: new Date(T0), organizacaoId: 'O', totalEquipamentos: 2 }]);

  const etapa = (n: string) => r.porEtapa.find((e) => e.etapa === n)!;
  assert.equal(etapa('AGUARDANDO_TRIAGEM').mediaHoras, 3); // (2+4)/2
  assert.equal(etapa('EM_TRIAGEM').mediaHoras, 15); // (10+20)/2
  assert.equal(r.gargalo?.etapa, 'EM_TRIAGEM');

  // operadores: ana 10h, bia 20h -> ana mais rapida (indice 1.5), bia 0.75
  assert.equal(r.porOperador[0].operador, 'ana');
  assert.equal(r.porOperador[0].mediaHoras, 10);
  assert.equal(r.porOperador[0].indiceEficiencia, 1.5);
  assert.equal(r.porOperador[1].indiceEficiencia, 0.75);

  // lote: ultimo equipamento sai da triagem em 24h
  assert.equal(r.lotesAnalisados, 1);
  assert.equal(r.tempoEntradaAteTriagemConcluida.mediaHoras, 24);
  assert.equal(r.porMes[0].mes, '2026-09');
});

test('eficiencia: lote com equipamento ainda em triagem nao entra no tempo do lote', () => {
  const m = [
    ...movs('A', 'L1', [['AGUARDANDO_TRIAGEM', 0, 's'], ['EM_TRIAGEM', 1, 'ana'], ['AGUARDANDO_DESMONTE', 5, 'ana']]),
    ...movs('B', 'L1', [['AGUARDANDO_TRIAGEM', 0, 's'], ['EM_TRIAGEM', 1, 'ana']]),
  ];
  const r = calcularEficiencia(m, [{ id: 'L1', dataEntrada: new Date(T0), organizacaoId: 'O', totalEquipamentos: 2 }]);
  assert.equal(r.lotesAnalisados, 0);
  assert.equal(r.lotesSemTriagemConcluida, 1);
});

test('eficiencia: sem dados', () => {
  const r = calcularEficiencia([], []);
  assert.equal(r.gargalo, null);
  assert.equal(r.tendencia, null);
});

// ---------------- vida util ----------------
const ANO = 2026;
function frota(tipo: 'NOTEBOOK', pontos: [number, any][]): EquipVida[] {
  return pontos.map(([idade, estado]) => ({ tipo, anoFabricacao: ANO - idade, estadoFisico: estado, ativo: true }));
}

test('vida util: degradacao 1 categoria/ano -> inservivel aos 6 anos', () => {
  const ms = ajustarModelosVida(frota('NOTEBOOK', [
    [0, 'NOVO'], [1, 'BOM_ESTADO'], [2, 'USADO_LEVE'], [3, 'USADO_MODERADO'], [4, 'DANIFICADO_LEVE'], [5, 'DANIFICADO_GRAVE'],
  ]), ANO);
  const m = ms[0];
  assert.equal(m.status, 'OK');
  assert.ok(Math.abs(m.inclinacao - 1) < 1e-9);
  assert.equal(m.idadeInservivelEstimada, 6);
  assert.ok(m.r2 > 0.999);
  // media da vida remanescente: (6-0,6-1,...,6-5)/6 = 3.5
  assert.equal(m.vidaRemanescenteMediaAnos, 3.5);
});

test('vida util: amostra pequena e sem degradacao', () => {
  assert.equal(ajustarModelosVida(frota('NOTEBOOK', [[1, 'NOVO'], [2, 'BOM_ESTADO']]), ANO)[0].status, 'DADOS_INSUFICIENTES');
  const sem = ajustarModelosVida(frota('NOTEBOOK', [[1, 'BOM_ESTADO'], [2, 'BOM_ESTADO'], [3, 'BOM_ESTADO'], [4, 'BOM_ESTADO'], [5, 'BOM_ESTADO']]), ANO)[0];
  assert.equal(sem.status, 'SEM_DEGRADACAO');
  assert.equal(sem.idadeInservivelEstimada, null);
});

test('vida util: holdout (RMSE) so com amostra >= 8 e equipamentos baixados nao entram na media', () => {
  const pontos: [number, any][] = [[0, 'NOVO'], [1, 'BOM_ESTADO'], [2, 'USADO_LEVE'], [3, 'USADO_MODERADO'], [4, 'DANIFICADO_LEVE'], [5, 'DANIFICADO_GRAVE'], [6, 'INSERVIVEL'], [1, 'BOM_ESTADO']];
  const e = frota('NOTEBOOK', pontos);
  e[0].ativo = false;
  const m = ajustarModelosVida(e, ANO)[0];
  assert.notEqual(m.rmse, null);
  assert.ok((m.rmse as number) < 0.5);
  const sem = ajustarModelosVida(frota('NOTEBOOK', pontos.slice(0, 6)), ANO)[0];
  assert.equal(sem.rmse, null);
});

test('vida remanescente individual', () => {
  assert.equal(vidaRemanescenteAnos(1, 'USADO_LEVE'), 4); // (6-2)/1
  assert.equal(vidaRemanescenteAnos(0.5, 'INSERVIVEL'), 0);
  assert.equal(vidaRemanescenteAnos(2, 'NOVO'), 3);
  assert.ok(Number.isNaN(vidaRemanescenteAnos(0, 'NOVO')));
});
