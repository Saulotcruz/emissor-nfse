import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool } from '../db/pool.js';
import { resetDb, createTomador } from './helpers/db.js';
import {
  coletarAlertas,
  formatarRelatorio,
  notasComErro,
  notasPendentes,
  eventosComProblema,
  GRAVIDADE,
} from '../services/alertas/verificacao.js';
import { configuracaoSmtp } from '../services/alertas/email.js';

let tomador;

beforeEach(async () => {
  await resetDb();
  tomador = await createTomador();
  // Sem certificado configurado, a verificação acusa — é o comportamento certo,
  // mas atrapalha os testes de nota. Cada teste decide se quer isso.
  delete process.env.NFSE_CERT_PATH;
  delete process.env.NFSE_CERT_PASSWORD;
});

afterAll(async () => {
  await pool.end();
});

async function criarNota({ status = 'pendente', horas = 0, ...extra } = {}) {
  const [[servico]] = await pool.query('SELECT id FROM servico LIMIT 1');
  const [r] = await pool.query(
    `INSERT INTO nota (tomador_id, servico_id, origem, serie, numero_dps, id_dps, competencia,
                       valor_servico, descricao_servico, status, erro_codigo, erro_mensagem,
                       tentativas, created_at)
     VALUES (?, ?, 'manual', '1', ?, ?, CURDATE(), 100.00, 'Serviço', ?, ?, ?, ?,
             DATE_SUB(NOW(), INTERVAL ? HOUR))`,
    [
      tomador.id,
      servico.id,
      extra.numeroDps ?? Math.floor(Math.random() * 1e6),
      `DPS${String(Math.floor(Math.random() * 1e12)).padStart(42, '0')}`,
      status,
      extra.erroCodigo ?? null,
      extra.erroMensagem ?? null,
      extra.tentativas ?? 1,
      horas,
    ]
  );
  return r.insertId;
}

describe('notasComErro', () => {
  it('lista só as rejeitadas, com o código da SEFIN', async () => {
    await criarNota({ status: 'erro', erroCodigo: 'E0617', erroMensagem: 'Alíquota indevida' });
    await criarNota({ status: 'autorizada' });

    const rows = await notasComErro();
    expect(rows).toHaveLength(1);
    expect(rows[0].erro_codigo).toBe('E0617');
    expect(rows[0].razao_social).toBe(tomador.razao_social);
  });
});

describe('notasPendentes', () => {
  // Nota recém-criada pode estar simplesmente sendo processada agora.
  it('ignora nota pendente recente e acusa a antiga', async () => {
    await criarNota({ status: 'pendente', horas: 0 });
    const antiga = await criarNota({ status: 'pendente', horas: 5 });

    const rows = await notasPendentes();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(antiga);
  });

  it('inclui as presas em "enviando", que é onde um timeout deixa a nota', async () => {
    await criarNota({ status: 'enviando', horas: 5 });
    expect(await notasPendentes()).toHaveLength(1);
  });

  it('não confunde com nota autorizada antiga', async () => {
    await criarNota({ status: 'autorizada', horas: 100 });
    expect(await notasPendentes()).toHaveLength(0);
  });
});

describe('eventosComProblema', () => {
  it('pega tanto os não processados quanto os que registraram erro', async () => {
    await pool.query(
      `INSERT INTO stripe_evento (stripe_event_id, tipo, payload, processado_em, erro_mensagem)
       VALUES ('evt_ok', 'invoice.payment_succeeded', '{}', NOW(), NULL),
              ('evt_erro', 'invoice.payment_succeeded', '{}', NOW(), 'Sem CNPJ do tomador'),
              ('evt_parado', 'invoice.payment_succeeded', '{}', NULL, NULL)`
    );
    const rows = await eventosComProblema();
    expect(rows.map((r) => r.stripe_event_id).sort()).toEqual(['evt_erro', 'evt_parado']);
  });
});

describe('coletarAlertas', () => {
  it('não reporta nada quando está tudo em ordem', async () => {
    await criarNota({ status: 'autorizada' });
    const { problemas } = await coletarAlertas();
    // Sem certificado configurado sobra só esse aviso; nenhum sobre notas.
    expect(problemas.filter((p) => /nota|evento/i.test(p.titulo))).toHaveLength(0);
  });

  it('classifica rejeição e nota presa como críticos', async () => {
    await criarNota({ status: 'erro', erroCodigo: 'E0121', erroMensagem: 'Nome do prestador' });
    await criarNota({ status: 'pendente', horas: 5 });

    const { problemas, contadores } = await coletarAlertas();
    expect(contadores).toMatchObject({ erros: 1, pendentes: 1 });

    const criticos = problemas.filter((p) => p.gravidade === GRAVIDADE.critico);
    expect(criticos.some((p) => /rejeitada/i.test(p.titulo))).toBe(true);
    expect(criticos.some((p) => /presa/i.test(p.titulo))).toBe(true);
  });

  it('acusa certificado inacessível como crítico', async () => {
    process.env.NFSE_CERT_PATH = '/caminho/que/nao/existe.pfx';
    process.env.NFSE_CERT_PASSWORD = 'x';
    const { problemas } = await coletarAlertas();
    const cert = problemas.find((p) => /certificado/i.test(p.titulo));
    expect(cert.gravidade).toBe(GRAVIDADE.critico);
  });
});

describe('formatarRelatorio', () => {
  it('traz gravidade, detalhe e ação de cada problema', async () => {
    await criarNota({ status: 'erro', erroCodigo: 'E0617', erroMensagem: 'Alíquota indevida' });
    const texto = formatarRelatorio(await coletarAlertas());

    expect(texto).toContain('[CRÍTICO]');
    expect(texto).toContain('E0617');
    expect(texto).toContain('Alíquota indevida');
    expect(texto).toContain('→');
  });

  it('corta a lista longa em vez de mandar um e-mail gigante', async () => {
    for (let i = 0; i < 25; i++) {
      await criarNota({ status: 'erro', erroMensagem: `erro ${i}`, numeroDps: 1000 + i });
    }
    const texto = formatarRelatorio(await coletarAlertas());
    expect(texto).toContain('e mais 5');
  });
});

describe('configuracaoSmtp', () => {
  it('lista as variáveis que faltam em vez de falhar na conexão', () => {
    expect(() => configuracaoSmtp({})).toThrow(/SMTP_HOST, SMTP_USER, SMTP_PASS, ALERTA_EMAIL_PARA/);
  });

  it('usa TLS direto na 465 e STARTTLS na 587', () => {
    const base = { SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'a@b.c', SMTP_PASS: 'x', ALERTA_EMAIL_PARA: 'd@e.f' };
    expect(configuracaoSmtp({ ...base, SMTP_PORT: '465' }).secure).toBe(true);
    expect(configuracaoSmtp({ ...base, SMTP_PORT: '587' }).secure).toBe(false);
    // Sem SMTP_PORT, assume 587.
    expect(configuracaoSmtp(base).port).toBe(587);
  });

  it('usa o próprio usuário como remetente quando ALERTA_EMAIL_DE não é definido', () => {
    const cfg = configuracaoSmtp({
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_USER: 'a@b.c',
      SMTP_PASS: 'x',
      ALERTA_EMAIL_PARA: 'd@e.f',
    });
    expect(cfg.de).toBe('a@b.c');
  });
});
