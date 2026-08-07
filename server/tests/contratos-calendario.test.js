import { describe, it, expect } from 'vitest';
import {
  diasNoMes,
  diaDoMes,
  dataDeEmissao,
  competenciaRef,
  avaliar,
  competenciasAnteriores,
  hojeLocal,
} from '../services/contratos/calendario.js';

describe('diasNoMes', () => {
  it.each([
    [2026, 1, 31], [2026, 2, 28], [2026, 3, 31], [2026, 4, 30],
    [2026, 12, 31],
    [2024, 2, 29], // bissexto
    [2000, 2, 29], // divisível por 400
    [1900, 2, 28], // divisível por 100 mas não por 400
  ])('%i-%i tem %i dias', (ano, mes, esperado) => {
    expect(diasNoMes(ano, mes)).toBe(esperado);
  });
});

describe('dia de emissão em mês curto', () => {
  // O contrato do dia 31 não pode sumir em fevereiro: pular deixaria o cliente
  // sem nota e a receita sem lançamento.
  it('recua para o último dia quando o dia não existe', () => {
    expect(diaDoMes(2026, 2, 31)).toBe(28);
    expect(diaDoMes(2024, 2, 31)).toBe(29);
    expect(diaDoMes(2026, 4, 31)).toBe(30);
    expect(diaDoMes(2026, 2, 30)).toBe(28);
  });

  it('não mexe quando o dia existe', () => {
    expect(diaDoMes(2026, 8, 21)).toBe(21);
    expect(diaDoMes(2026, 1, 31)).toBe(31);
  });

  it('formata a data com zero à esquerda', () => {
    expect(dataDeEmissao(2026, 2, 31)).toBe('2026-02-28');
    expect(dataDeEmissao(2026, 8, 21)).toBe('2026-08-21');
    expect(dataDeEmissao(2026, 9, 5)).toBe('2026-09-05');
  });

  it('monta a competência de referência', () => {
    expect(competenciaRef(2026, 8)).toBe('2026-08');
    expect(competenciaRef(2026, 12)).toBe('2026-12');
  });
});

describe('avaliar', () => {
  const contrato = (extra = {}) => ({
    ativo: 1,
    dia_emissao: 21,
    vigencia_inicio: '2026-01-01',
    vigencia_fim: null,
    ...extra,
  });

  it('emite no dia marcado', () => {
    const r = avaliar(contrato(), '2026-08-21');
    expect(r.emitir).toBe(true);
    expect(r.competenciaRef).toBe('2026-08');
    expect(r.dataEmissao).toBe('2026-08-21');
  });

  it('não emite antes do dia', () => {
    const r = avaliar(contrato(), '2026-08-20');
    expect(r.emitir).toBe(false);
    expect(r.motivo).toMatch(/aguardando o dia 21/);
  });

  // Servidor fora do ar no dia 21 emite quando voltar, no mesmo mês. A trava
  // contra duplicar é o índice único (contrato_id, competencia_ref), não a data.
  it('emite depois do dia, se ainda não emitiu no mês', () => {
    expect(avaliar(contrato(), '2026-08-23').emitir).toBe(true);
    expect(avaliar(contrato(), '2026-08-31').emitir).toBe(true);
  });

  it('não emite contrato inativo', () => {
    const r = avaliar(contrato({ ativo: 0 }), '2026-08-21');
    expect(r.emitir).toBe(false);
    expect(r.motivo).toMatch(/inativo/);
  });

  // Contrato cadastrado dia 25 com emissão dia 21 não dispara na hora.
  it('não emite retroativo no mês em que a vigência começou', () => {
    const r = avaliar(contrato({ vigencia_inicio: '2026-08-25' }), '2026-08-25');
    expect(r.emitir).toBe(false);
    expect(r.motivo).toMatch(/antes do início/);
  });

  it('emite no mês seguinte ao início da vigência', () => {
    expect(avaliar(contrato({ vigencia_inicio: '2026-08-25' }), '2026-09-21').emitir).toBe(true);
  });

  it('para de emitir depois do fim da vigência', () => {
    const c = contrato({ vigencia_fim: '2026-08-31' });
    expect(avaliar(c, '2026-08-21').emitir).toBe(true);
    expect(avaliar(c, '2026-09-21').emitir).toBe(false);
    expect(avaliar(c, '2026-09-21').motivo).toMatch(/após o fim/);
  });

  // O MySQL devolve DATE como objeto Date; o texto vem do painel.
  it('aceita vigência como Date ou como texto', () => {
    const comData = contrato({ vigencia_inicio: new Date(2026, 7, 25) }); // 25/08/2026
    expect(avaliar(comData, '2026-08-25').emitir).toBe(false);
    expect(avaliar(comData, '2026-09-21').emitir).toBe(true);
  });

  it('funciona no dia 28 de fevereiro para contrato do dia 31', () => {
    const c = contrato({ dia_emissao: 31 });
    expect(avaliar(c, '2026-02-27').emitir).toBe(false);
    expect(avaliar(c, '2026-02-28').emitir).toBe(true);
    expect(avaliar(c, '2026-02-28').competenciaRef).toBe('2026-02');
  });
});

describe('competenciasAnteriores', () => {
  const contrato = { ativo: 1, dia_emissao: 21, vigencia_inicio: '2025-01-01', vigencia_fim: null };

  it('lista os meses anteriores, do mais recente para trás', () => {
    const lista = competenciasAnteriores(contrato, '2026-03-10', 3);
    expect(lista.map((c) => c.competenciaRef)).toEqual(['2026-02', '2026-01', '2025-12']);
  });

  // Virada de ano não pode gerar mês 0 nem ano errado.
  it('atravessa a virada de ano corretamente', () => {
    const lista = competenciasAnteriores(contrato, '2026-01-15', 3);
    expect(lista.map((c) => c.competenciaRef)).toEqual(['2025-12', '2025-11', '2025-10']);
  });

  it('para no início da vigência', () => {
    const c = { ...contrato, vigencia_inicio: '2026-01-01' };
    const lista = competenciasAnteriores(c, '2026-03-10', 6);
    expect(lista.map((c2) => c2.competenciaRef)).toEqual(['2026-02', '2026-01']);
  });

  it('respeita o dia curto de fevereiro', () => {
    const c = { ...contrato, dia_emissao: 31 };
    const lista = competenciasAnteriores(c, '2026-03-10', 1);
    expect(lista[0]).toEqual({ competenciaRef: '2026-02', dataEmissao: '2026-02-28' });
  });
});

describe('hojeLocal', () => {
  // Data local, não UTC: às 21h de Brasília o UTC já é o dia seguinte, e um
  // contrato do dia 21 emitiria no dia 20 à noite.
  it('usa o calendário local', () => {
    expect(hojeLocal(new Date(2026, 7, 21, 22, 30))).toBe('2026-08-21');
    expect(hojeLocal(new Date(2026, 0, 5, 0, 5))).toBe('2026-01-05');
  });
});
