import { EscopoApi, PrismaClient } from '@prisma/client';
import { extrairPrefixo, gerarChave, hashChave, hashesIguais } from '../domain/apikey';
import { ConflitoError, NaoAutenticadoError, NaoEncontradoError, RegraNegocioError } from '../shared/errors';
import { Pagina, parseData, resposta } from '../shared/util';
import { JournalRepository } from '../repositories/JournalRepository';
import { OrganizacaoRepository } from '../repositories/OrganizacaoRepository';
import { ParceiroRepository } from '../repositories/ParceiroRepository';
import { Ator } from './ator';

/** O que a API publica sabe sobre quem chama (montado a partir da chave de API). */
export interface ContextoApi {
  chaveId: string;
  parceiroId: string;
  parceiroNome: string;
  organizacaoId: string | null;
  acessoGlobal: boolean;
  escopos: EscopoApi[];
  limitePorMinuto: number;
}

export class ParceiroService {
  /** Evita 1 UPDATE por requisicao: ultimoUsoEm e gravado no maximo 1x por minuto por chave. */
  private readonly ultimoRegistroUso = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly parceiros: ParceiroRepository,
    private readonly organizacoes: OrganizacaoRepository,
    private readonly journal: JournalRepository,
  ) {}

  async criarParceiro(d: { nome: string; email: string; organizacaoId?: string; acessoGlobal?: boolean }, ator: Ator) {
    if (await this.parceiros.porNome(d.nome)) throw new ConflitoError(`Parceiro '${d.nome}' ja existe.`);
    if (d.organizacaoId && !(await this.organizacoes.porId(d.organizacaoId))) {
      throw new NaoEncontradoError('Organizacao', d.organizacaoId);
    }
    return this.prisma.$transaction(async (tx) => {
      const p = await this.parceiros.com(tx).criar({
        nome: d.nome, email: d.email, organizacaoId: d.organizacaoId ?? null, acessoGlobal: d.acessoGlobal ?? false,
      });
      await this.journal.com(tx).registrar({ operacao: 'CREATE', entidade: 'Parceiro', entidadeId: p.id, dadosDepois: p, usuarioResponsavel: ator.usuario });
      return p;
    });
  }

  async listar(p: Pagina) {
    const { dados, total } = await this.parceiros.listar(p.skip, p.take);
    return resposta(dados, total, p);
  }

  async atualizar(id: string, d: { email?: string; ativo?: boolean; acessoGlobal?: boolean }, ator: Ator) {
    const atual = await this.parceiros.porId(id);
    if (!atual) throw new NaoEncontradoError('Parceiro', id);
    return this.prisma.$transaction(async (tx) => {
      const novo = await this.parceiros.com(tx).atualizar(id, d);
      await this.journal.com(tx).registrar({ operacao: 'UPDATE', entidade: 'Parceiro', entidadeId: id, dadosAntes: atual, dadosDepois: novo, usuarioResponsavel: ator.usuario });
      return novo;
    });
  }

  /** Gera a chave. O texto puro e devolvido UMA unica vez; depois so existe o hash. */
  async criarChave(
    parceiroId: string,
    d: { nome: string; escopos: EscopoApi[]; limitePorMinuto?: number; expiraEm?: string },
    ator: Ator,
  ) {
    const parceiro = await this.parceiros.porId(parceiroId);
    if (!parceiro) throw new NaoEncontradoError('Parceiro', parceiroId);
    if (!parceiro.ativo) throw new RegraNegocioError('Parceiro desativado nao pode receber chaves.');
    if (!parceiro.organizacaoId && !parceiro.acessoGlobal) {
      throw new RegraNegocioError('Vincule o parceiro a uma organizacao (ou conceda acessoGlobal) antes de gerar chaves.');
    }
    if (d.escopos.includes('LOTES_ESCREVER') && !parceiro.organizacaoId) {
      throw new RegraNegocioError('O escopo LOTES_ESCREVER exige parceiro vinculado a uma organizacao.');
    }
    const expira = d.expiraEm ? parseData(d.expiraEm, 'expiraEm') : null;
    if (expira && expira.getTime() <= Date.now()) throw new RegraNegocioError('expiraEm deve estar no futuro.');

    const { chave, prefixo, hash } = gerarChave();
    const criada = await this.prisma.$transaction(async (tx) => {
      const c = await this.parceiros.com(tx).criarChave({
        parceiroId, nome: d.nome, prefixo, hashChave: hash, escopos: [...new Set(d.escopos)],
        limitePorMinuto: d.limitePorMinuto ?? 60, expiraEm: expira,
      });
      await this.journal.com(tx).registrar({
        operacao: 'CREATE', entidade: 'ChaveApi', entidadeId: c.id,
        dadosDepois: { parceiroId, nome: c.nome, prefixo, escopos: c.escopos, limitePorMinuto: c.limitePorMinuto }, // sem segredo
        usuarioResponsavel: ator.usuario,
      });
      return c;
    });
    return {
      id: criada.id, nome: criada.nome, prefixo, escopos: criada.escopos, limitePorMinuto: criada.limitePorMinuto, expiraEm: criada.expiraEm,
      chave, aviso: 'Guarde esta chave agora: ela NAO sera exibida novamente.',
    };
  }

  async listarChaves(parceiroId: string) {
    if (!(await this.parceiros.porId(parceiroId))) throw new NaoEncontradoError('Parceiro', parceiroId);
    return this.parceiros.listarChaves(parceiroId);
  }

  async revogarChave(parceiroId: string, chaveId: string, ator: Ator) {
    const c = await this.parceiros.chavePorId(chaveId);
    if (!c || c.parceiroId !== parceiroId) throw new NaoEncontradoError('Chave', chaveId);
    await this.prisma.$transaction(async (tx) => {
      await this.parceiros.com(tx).revogarChave(chaveId);
      await this.journal.com(tx).registrar({
        operacao: 'UPDATE', entidade: 'ChaveApi', entidadeId: chaveId,
        dadosAntes: { ativo: c.ativo }, dadosDepois: { ativo: false, revogada: true }, usuarioResponsavel: ator.usuario,
      });
    });
  }

  /** Valida a chave (formato, existencia, hash em tempo constante, ativa, nao expirada, parceiro ativo). */
  async autenticar(chave: string | undefined): Promise<ContextoApi> {
    const invalida = () => new NaoAutenticadoError('Chave de API ausente, invalida, revogada ou expirada.');
    if (!chave) throw invalida();
    const prefixo = extrairPrefixo(chave);
    if (!prefixo) throw invalida();

    const reg = await this.parceiros.chavePorPrefixo(prefixo);
    if (!reg || !hashesIguais(reg.hashChave, hashChave(chave))) throw invalida();
    if (!reg.ativo || reg.revogadaEm || (reg.expiraEm && reg.expiraEm.getTime() <= Date.now()) || !reg.parceiro.ativo) throw invalida();

    const agora = Date.now();
    if (agora - (this.ultimoRegistroUso.get(reg.id) ?? 0) > 60_000) {
      this.ultimoRegistroUso.set(reg.id, agora);
      void this.parceiros.registrarUso(reg.id).catch(() => undefined); // melhor esforco; nao atrasa a resposta
    }
    return {
      chaveId: reg.id, parceiroId: reg.parceiroId, parceiroNome: reg.parceiro.nome, organizacaoId: reg.parceiro.organizacaoId,
      acessoGlobal: reg.parceiro.acessoGlobal, escopos: reg.escopos, limitePorMinuto: reg.limitePorMinuto,
    };
  }
}
