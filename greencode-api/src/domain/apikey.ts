import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Formato: gck_<prefixo:10 hex>_<segredo:43 chars base64url (256 bits)>
 *  - prefixo: publico, localiza o registro (indice unico) sem varrer a tabela;
 *  - segredo: aleatorio de 256 bits. Como a entropia e altissima, SHA-256 (rapido) e adequado;
 *    bcrypt/argon2 servem para senhas escolhidas por humanos, nao para tokens aleatorios, e
 *    custariam CPU em CADA requisicao da API.
 */
const REGEX = /^gck_([0-9a-f]{10})_[A-Za-z0-9_-]{43}$/;

export function gerarChave(): { chave: string; prefixo: string; hash: string } {
  const prefixo = randomBytes(5).toString('hex');
  const chave = `gck_${prefixo}_${randomBytes(32).toString('base64url')}`;
  return { chave, prefixo, hash: hashChave(chave) };
}

export const hashChave = (chave: string): string => createHash('sha256').update(chave).digest('hex');

export function extrairPrefixo(chave: string): string | null {
  const m = REGEX.exec(chave);
  return m ? m[1] : null;
}

/** Comparacao em tempo constante (evita ataques de temporizacao). */
export function hashesIguais(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}
