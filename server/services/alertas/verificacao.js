import fs from 'node:fs';
import { pool } from '../../db/pool.js';
import { lerCertificado, diasParaVencer } from '../nfse/signer.js';

/**
 * Levantamento do que precisa de atenção humana.
 *
 * Com a emissão automática rodando, uma nota que não sai não avisa ninguém: o
 * webhook responde 200 e o erro fica só no banco. Este módulo é o que transforma
 * esse silêncio em e-mail.
 */

export const DIAS_ALERTA_CERTIFICADO = Number(process.env.ALERTA_DIAS_CERTIFICADO || 30);
// Nota parada em "pendente" por mais que isto provavelmente não vai sair sozinha.
export const HORAS_PENDENTE = Number(process.env.ALERTA_HORAS_PENDENTE || 2);

export const GRAVIDADE = { critico: 'crítico', atencao: 'atenção' };

/** Notas rejeitadas pela SEFIN: exigem correção, não adianta retentar igual. */
export async function notasComErro() {
  const [rows] = await pool.query(
    `SELECT n.id, n.serie, n.numero_dps, n.valor_servico, n.competencia,
            n.erro_codigo, n.erro_mensagem, t.razao_social, t.documento
       FROM nota n JOIN tomador t ON t.id = n.tomador_id
      WHERE n.status = 'erro'
      ORDER BY n.id DESC`
  );
  return rows;
}

/**
 * Notas presas em "pendente": o envio falhou por transporte e ninguém retentou.
 * Diferente de erro — estas podem sair sozinhas com uma nova tentativa.
 */
export async function notasPendentes() {
  const [rows] = await pool.query(
    `SELECT n.id, n.serie, n.numero_dps, n.id_dps, n.valor_servico, n.tentativas,
            n.erro_mensagem, n.created_at, t.razao_social
       FROM nota n JOIN tomador t ON t.id = n.tomador_id
      WHERE n.status IN ('pendente', 'enviando')
        AND n.created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
      ORDER BY n.id`,
    [HORAS_PENDENTE]
  );
  return rows;
}

/** Faturas que chegaram mas não viraram nota — inclusive as ignoradas por regra. */
export async function eventosComProblema() {
  const [rows] = await pool.query(
    `SELECT stripe_event_id, tipo, erro_mensagem, created_at
       FROM stripe_evento
      WHERE erro_mensagem IS NOT NULL
         OR processado_em IS NULL
      ORDER BY id DESC
      LIMIT 50`
  );
  return rows;
}

/**
 * Situação do certificado A1. É o ponto único de falha do sistema: quando vence,
 * a emissão para em silêncio.
 */
export function situacaoCertificado() {
  const caminho = process.env.NFSE_CERT_PATH;
  const senha = process.env.NFSE_CERT_PASSWORD;
  if (!caminho || !senha) {
    return { ok: false, erro: 'NFSE_CERT_PATH ou NFSE_CERT_PASSWORD não configurados' };
  }
  if (!fs.existsSync(caminho)) return { ok: false, erro: `Certificado não encontrado: ${caminho}` };

  try {
    const cert = lerCertificado({ caminho, senha });
    const dias = diasParaVencer(cert);
    return { ok: true, titular: cert.titular, validoAte: cert.validoAte, dias };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

/**
 * Junta tudo num relatório. `problemas` vazio significa que não há o que avisar
 * — e nesse caso o cron não manda e-mail nenhum.
 */
export async function coletarAlertas() {
  const [erros, pendentes, eventos] = await Promise.all([
    notasComErro(),
    notasPendentes(),
    eventosComProblema(),
  ]);
  const certificado = situacaoCertificado();

  const problemas = [];

  if (erros.length) {
    problemas.push({
      gravidade: GRAVIDADE.critico,
      titulo: `${erros.length} nota(s) rejeitada(s) pela SEFIN`,
      detalhe: erros.map(
        (n) =>
          `#${n.id} — ${n.razao_social} — R$ ${Number(n.valor_servico).toFixed(2)} — ` +
          `${n.erro_codigo ? `[${n.erro_codigo}] ` : ''}${n.erro_mensagem ?? ''}`
      ),
      acao: 'Corrija o cadastro ou a configuração e reemita.',
    });
  }

  if (pendentes.length) {
    problemas.push({
      gravidade: GRAVIDADE.critico,
      titulo: `${pendentes.length} nota(s) presa(s) sem envio há mais de ${HORAS_PENDENTE}h`,
      detalhe: pendentes.map(
        (n) => `#${n.id} — DPS ${n.serie}/${n.numero_dps} — ${n.razao_social} — ${n.tentativas} tentativa(s)`
      ),
      acao: 'Retentativa é segura: o idDPS é consultado na SEFIN antes de reenviar.',
    });
  }

  if (eventos.length) {
    problemas.push({
      gravidade: GRAVIDADE.atencao,
      titulo: `${eventos.length} evento(s) da Stripe sem nota`,
      detalhe: eventos.map((e) => `${e.stripe_event_id} — ${e.erro_mensagem ?? 'não processado'}`),
      acao: 'Alguns são normais (trial, moeda estrangeira). Confira os demais.',
    });
  }

  if (!certificado.ok) {
    problemas.push({
      gravidade: GRAVIDADE.critico,
      titulo: 'Certificado A1 inacessível',
      detalhe: [certificado.erro],
      acao: 'Sem certificado válido, nenhuma nota é emitida.',
    });
  } else if (certificado.dias < 0) {
    problemas.push({
      gravidade: GRAVIDADE.critico,
      titulo: `Certificado A1 VENCIDO há ${Math.abs(certificado.dias)} dias`,
      detalhe: [`${certificado.titular} — venceu em ${certificado.validoAte.toISOString().slice(0, 10)}`],
      acao: 'A emissão está parada. Renove e substitua o arquivo.',
    });
  } else if (certificado.dias <= DIAS_ALERTA_CERTIFICADO) {
    problemas.push({
      gravidade: GRAVIDADE.atencao,
      titulo: `Certificado A1 vence em ${certificado.dias} dias`,
      detalhe: [`${certificado.titular} — vence em ${certificado.validoAte.toISOString().slice(0, 10)}`],
      acao: 'Providencie a renovação antes do vencimento.',
    });
  }

  return { problemas, certificado, contadores: { erros: erros.length, pendentes: pendentes.length, eventos: eventos.length } };
}

/** Monta o texto do e-mail. Separado da coleta para poder ser testado sozinho. */
export function formatarRelatorio({ problemas, certificado }) {
  const linhas = [];
  for (const p of problemas) {
    linhas.push(`[${p.gravidade.toUpperCase()}] ${p.titulo}`);
    for (const d of p.detalhe.slice(0, 20)) linhas.push(`    ${d}`);
    if (p.detalhe.length > 20) linhas.push(`    … e mais ${p.detalhe.length - 20}`);
    linhas.push(`    → ${p.acao}`);
    linhas.push('');
  }

  if (certificado.ok) {
    linhas.push(`Certificado: ${certificado.titular} — ${certificado.dias} dias restantes`);
  }
  return linhas.join('\n');
}
