import { Prisma } from '@prisma/client';
import { Db } from '../infra/prisma';

export class ParceiroRepository {
  constructor(private readonly db: Db) {}
  com(tx: Db): ParceiroRepository {
    return new ParceiroRepository(tx);
  }

  criar(data: Prisma.ParceiroUncheckedCreateInput) {
    return this.db.parceiro.create({ data });
  }
  porId(id: string) {
    return this.db.parceiro.findUnique({ where: { id } });
  }
  porNome(nome: string) {
    return this.db.parceiro.findUnique({ where: { nome } });
  }
  async listar(skip: number, take: number) {
    const [dados, total] = await Promise.all([
      this.db.parceiro.findMany({ skip, take, orderBy: { nome: 'asc' }, include: { _count: { select: { chaves: true } } } }),
      this.db.parceiro.count(),
    ]);
    return { dados, total };
  }
  atualizar(id: string, data: Prisma.ParceiroUpdateInput) {
    return this.db.parceiro.update({ where: { id }, data });
  }

  // ---- chaves ----
  criarChave(data: Prisma.ChaveApiUncheckedCreateInput) {
    return this.db.chaveApi.create({ data });
  }
  chavePorId(id: string) {
    return this.db.chaveApi.findUnique({ where: { id } });
  }
  chavePorPrefixo(prefixo: string) {
    return this.db.chaveApi.findUnique({ where: { prefixo }, include: { parceiro: true } });
  }
  listarChaves(parceiroId: string) {
    return this.db.chaveApi.findMany({
      where: { parceiroId },
      orderBy: { criadoEm: 'desc' },
      // hashChave NUNCA sai do repositorio para listagens
      select: { id: true, nome: true, prefixo: true, escopos: true, limitePorMinuto: true, ativo: true, expiraEm: true, ultimoUsoEm: true, criadoEm: true, revogadaEm: true },
    });
  }
  revogarChave(id: string) {
    return this.db.chaveApi.update({ where: { id }, data: { ativo: false, revogadaEm: new Date() } });
  }
  registrarUso(id: string) {
    return this.db.chaveApi.update({ where: { id }, data: { ultimoUsoEm: new Date() } });
  }
}
