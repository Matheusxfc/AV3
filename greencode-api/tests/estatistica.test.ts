import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arred, desvioPadrao, media, mediana, percentil, regressaoLinear, rmse, suavizacaoExponencial } from '../src/domain/estatistica';

const perto = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test('media, mediana e desvio padrao amostral', () => {
  perto(media([2, 4, 6, 8]), 5);
  assert.ok(Number.isNaN(media([])));
  assert.equal(mediana([5, 1, 3]), 3);
  assert.equal(mediana([1, 2, 3, 4]), 2.5);
  perto(desvioPadrao([2, 4, 4, 4, 5, 5, 7, 9]), 2.138089935299395);
  assert.equal(desvioPadrao([7]), 0);
});

test('percentil com interpolacao linear', () => {
  assert.equal(percentil([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentil([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentil([1, 2, 3, 4, 5], 100), 5);
  perto(percentil([10, 20, 30, 40], 90), 37);
});

test('OLS: reta perfeita y = 1 + 2x', () => {
  const r = regressaoLinear([0, 1, 2, 3, 4], [1, 3, 5, 7, 9])!;
  perto(r.inclinacao, 2);
  perto(r.intercepto, 1);
  perto(r.r2, 1);
  assert.equal(r.n, 5);
});

test('OLS: dados ruidosos (valores conferidos a mao)', () => {
  // x=[1,2,3,4,5], y=[2,4,5,4,5] -> b=0.6, a=2.2, R2=0.6
  const r = regressaoLinear([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])!;
  perto(r.inclinacao, 0.6);
  perto(r.intercepto, 2.2);
  perto(r.r2, 0.6);
});

test('OLS: casos degenerados retornam null', () => {
  assert.equal(regressaoLinear([1], [1]), null);
  assert.equal(regressaoLinear([2, 2, 2], [1, 2, 3]), null); // x constante
  assert.equal(regressaoLinear([1, 2, 3], [5, 5, 5])!.r2, 0); // y constante
});

test('RMSE', () => {
  perto(rmse([1, 2, 3], [1, 2, 3]), 0);
  perto(rmse([0, 0], [3, 4]), Math.sqrt(12.5));
});

test('suavizacao exponencial simples', () => {
  const r = suavizacaoExponencial([10, 20, 30], 0.5)!;
  assert.deepEqual(r.niveis, [10, 15, 22.5]);
  assert.equal(r.previsao, 22.5);
  assert.equal(suavizacaoExponencial([]), null);
});

test('arred devolve null para NaN/Infinity', () => {
  assert.equal(arred(NaN), null);
  assert.equal(arred(Infinity), null);
  assert.equal(arred(1.23456, 2), 1.23);
});
