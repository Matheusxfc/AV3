import { PapelUsuario } from '../domain/enums';

/** Quem responde pela operacao na auditoria (usuario interno ou parceiro externo). */
export interface Responsavel {
  usuario: string;
}

/** Usuario autenticado que executa a operacao (extraido do JWT). */
export interface Ator extends Responsavel {
  id: string;
  papel: PapelUsuario;
}
