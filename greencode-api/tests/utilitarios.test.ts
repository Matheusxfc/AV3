import { test } from 'node:test';
import assert from 'node:assert/strict';
import { celulaCsv, paraCsv } from '../src/domain/csv';
import { extrairPrefixo, gerarChave, hashChave, hashesIguais } from '../src/domain/apikey';
import { calcularBackoffMs } from '../src/domain/retry';

test('CSV: escape de virgula, aspas e quebra de linha', () => {
  assert.equal(celulaCsv('a,b'), '"a,b"');
  assert.equal(celulaCsv('diz "oi"'), '"diz ""oi"""');
  assert.equal(celulaCsv('l1\nl2'), '"l1\nl2"');
  assert.equal(celulaCsv(null), '');
  assert.equal(celulaCsv(12.5), '12.5');
  assert.equal(celulaCsv(-3), '-3'); // numero negativo NAO e formula
});

test('CSV: protecao contra CSV injection em textos', () => {
  assert.equal(celulaCsv('=SOMA(A1:A2)'), "'=SOMA(A1:A2)");
  assert.equal(celulaCsv('+55 12 3333'), "'+55 12 3333");
  assert.equal(celulaCsv('-cmd'), "'-cmd");
  assert.equal(celulaCsv('@usuario'), "'@usuario");
});

test('CSV: documento completo com BOM e CRLF', () => {
  const csv = paraCsv(['a', 'b'], [{ a: 1, b: 'x,y' }, { a: 2, b: null }]);
  assert.equal(csv, '\ufeffa,b\r\n1,"x,y"\r\n2,\r\n');
});

test('chave de API: formato, hash e verificacao', () => {
  const { chave, prefixo, hash } = gerarChave();
  assert.match(chave, /^gck_[0-9a-f]{10}_[A-Za-z0-9_-]{43}$/);
  assert.equal(extrairPrefixo(chave), prefixo);
  assert.equal(hash, hashChave(chave));
  assert.equal(hashesIguais(hash, hashChave(chave)), true);
  assert.equal(hashesIguais(hash, hashChave(chave + 'x')), false);
  assert.equal(hash.includes(chave), false); // segredo nao aparece no hash
  assert.notEqual(gerarChave().chave, chave); // unicas
});

test('chave de API: formatos invalidos', () => {
  assert.equal(extrairPrefixo(''), null);
  assert.equal(extrairPrefixo('gck_xyz'), null);
  assert.equal(extrairPrefixo('abc_0123456789_' + 'a'.repeat(43)), null);
  assert.equal(hashesIguais('zz', 'zz'), false);
});

test('backoff exponencial com teto e jitter de +-20%', () => {
  const sem = () => 0.5; // jitter neutro (fator 1.0)
  assert.equal(calcularBackoffMs(1, 5000, 300000, sem), 5000);
  assert.equal(calcularBackoffMs(2, 5000, 300000, sem), 10000);
  assert.equal(calcularBackoffMs(3, 5000, 300000, sem), 20000);
  assert.equal(calcularBackoffMs(20, 5000, 300000, sem), 300000); // teto
  assert.equal(calcularBackoffMs(1, 5000, 300000, () => 0), 4000);
  assert.equal(calcularBackoffMs(1, 5000, 300000, () => 1), 6000);
});
