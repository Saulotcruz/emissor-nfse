import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool } from '../db/pool.js';
import { reservarNota, carregarEmitente, carregarServicoPadrao } from '../services/nfse/client.js';
import { resetDb, createTomador } from './helpers/db.js';

let tomador;
let servico;

beforeEach(async () => {
  await resetDb();
  tomador = await createTomador();
  servico = await carregarServicoPadrao();
});

afterAll(async () => {
  await pool.end();
});

function dados(extra = {}) {
  return {
    tomadorId: tomador.id,
    servicoId: servico.id,
    valorServico: 148.83,
    descricaoServico: 'Plano Essential mensal',
    ...extra,
  };
}

describe('reservarNota', () => {
  it('grava a nota como pendente com número e idDPS coerentes', async () => {
    const r = await reservarNota(dados());
    expect(r.numeroDps).toBe(1);
    expect(r.idDps).toMatch(/^DPS[0-9]{42}$/);

    const [[nota]] = await pool.query('SELECT * FROM nota WHERE id = ?', [r.id]);
    expect(nota.status).toBe('pendente');
    expect(Number(nota.numero_dps)).toBe(1);
    expect(nota.id_dps).toBe(r.idDps);
    expect(Number(nota.valor_servico)).toBe(148.83);
    // O município de incidência do ISS é o do emitente por padrão.
    expect(nota.municipio_incidencia_iss).toBe((await carregarEmitente()).codigo_municipio);
  });

  it('avança o contador da série a cada reserva', async () => {
    expect((await reservarNota(dados())).numeroDps).toBe(1);
    expect((await reservarNota(dados())).numeroDps).toBe(2);
    expect((await reservarNota(dados())).numeroDps).toBe(3);

    const [[emitente]] = await pool.query('SELECT proximo_numero_dps FROM emitente LIMIT 1');
    expect(Number(emitente.proximo_numero_dps)).toBe(4);
  });

  // Sem o SELECT ... FOR UPDATE, duas emissões simultâneas pegariam o mesmo
  // número e a segunda seria rejeitada pela SEFIN como DPS duplicada.
  it('não entrega o mesmo número para reservas concorrentes', async () => {
    const reservas = await Promise.all([
      reservarNota(dados()),
      reservarNota(dados()),
      reservarNota(dados()),
      reservarNota(dados()),
      reservarNota(dados()),
    ]);
    const numeros = reservas.map((r) => r.numeroDps).sort((a, b) => a - b);
    expect(numeros).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(reservas.map((r) => r.idDps)).size).toBe(5);
  });

  it('impede duas notas para a mesma fatura da Stripe', async () => {
    await reservarNota(dados({ stripeInvoiceId: 'in_123', origem: 'stripe' }));
    await expect(reservarNota(dados({ stripeInvoiceId: 'in_123', origem: 'stripe' })))
      .rejects.toThrow(/Duplicate|duplicad/i);

    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM nota');
    expect(total).toBe(1);
  });

  it('permite várias notas manuais, que não têm fatura associada', async () => {
    await reservarNota(dados({ origem: 'manual' }));
    await reservarNota(dados({ origem: 'manual' }));
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM nota');
    expect(total).toBe(2);
  });

  it('usa a data de hoje como competência quando não é informada', async () => {
    const r = await reservarNota(dados());
    const [[nota]] = await pool.query('SELECT competencia FROM nota WHERE id = ?', [r.id]);
    expect(nota.competencia).toBe(new Date().toISOString().slice(0, 10));
  });

  it('não consome número quando a reserva falha', async () => {
    await expect(reservarNota(dados({ tomadorId: 999999 }))).rejects.toThrow();
    const [[emitente]] = await pool.query('SELECT proximo_numero_dps FROM emitente LIMIT 1');
    expect(Number(emitente.proximo_numero_dps)).toBe(1);
  });
});
