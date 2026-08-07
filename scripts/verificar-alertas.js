#!/usr/bin/env node
/**
 * Varre o sistema em busca do que precisa de atenção e envia e-mail se houver.
 *
 *   npm run alertas                 # verifica e envia se houver problema
 *   npm run alertas -- --dry-run    # só mostra na tela, não envia
 *   npm run alertas -- --testar     # manda um e-mail de teste e sai
 *   npm run alertas -- --reemitir   # tenta reenviar as notas presas em pendente
 *
 * Feito para rodar no cron. Quando não há nada a relatar, não manda e-mail —
 * alerta que chega todo dia sem motivo deixa de ser lido.
 */
import dotenv from 'dotenv';
import { pool } from '../server/db/pool.js';
import { coletarAlertas, formatarRelatorio, notasPendentes } from '../server/services/alertas/verificacao.js';
import { enviarAlerta, verificarConexao, configuracaoSmtp } from '../server/services/alertas/email.js';
import { emitirNota } from '../server/services/nfse/client.js';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const testar = args.has('--testar');
const reemitir = args.has('--reemitir');

async function main() {
  if (testar) {
    const cfg = configuracaoSmtp();
    console.log(`Conectando em ${cfg.host}:${cfg.port} como ${cfg.auth.user}…`);
    const conexao = await verificarConexao(cfg);
    if (!conexao.ok) {
      console.error(`✗ ${conexao.erro}`);
      process.exitCode = 1;
      return;
    }
    console.log('✓ Conexão SMTP ok');
    const r = await enviarAlerta({
      assunto: '[NFS-e] E-mail de teste',
      texto: 'Se você está lendo isto, os alertas do emissor de NFS-e estão configurados.',
      cfg,
    });
    console.log(`  remetente  ${r.envelopeDe}`);
    console.log(`  aceitos    ${r.aceitos.join(', ') || '(nenhum)'}`);
    if (r.rejeitados.length) console.log(`  REJEITADOS ${r.rejeitados.join(', ')}`);
    console.log(`  messageId  ${r.messageId}`);
    console.log(`  resposta   ${r.resposta}`);

    if (!r.aceitos.length) {
      console.error('\n✗ O servidor não aceitou nenhum destinatário.');
      process.exitCode = 1;
      return;
    }
    console.log(`\n✓ ${cfg.host} aceitou entregar para ${r.aceitos.join(', ')}.`);
    console.log('  Aceito não é entregue: se não chegar, procure em spam e confira');
    console.log('  se há filtro ou encaminhamento no destinatário.');
    return;
  }

  // Retentativa antes de relatar: o que sair daqui não precisa virar alerta.
  if (reemitir) {
    const presas = await notasPendentes();
    for (const n of presas) {
      try {
        const r = await emitirNota(n.id);
        console.log(`✓ Nota #${n.id} emitida — chave ${r.chaveAcesso}`);
      } catch (e) {
        console.error(`✗ Nota #${n.id}: ${e.message}`);
      }
    }
  }

  const relatorio = await coletarAlertas();
  const { problemas, contadores } = relatorio;

  if (!problemas.length) {
    console.log(
      `Nada a relatar. Notas com erro: ${contadores.erros} | presas: ${contadores.pendentes} | ` +
        `eventos: ${contadores.eventos}`
    );
    return;
  }

  const texto = formatarRelatorio(relatorio);
  const criticos = problemas.filter((p) => p.gravidade === 'crítico').length;
  const assunto = criticos
    ? `[NFS-e] ${criticos} problema(s) crítico(s)`
    : `[NFS-e] ${problemas.length} ponto(s) de atenção`;

  console.log(assunto);
  console.log(texto);

  if (dryRun) {
    console.log('(dry-run: nenhum e-mail enviado)');
    return;
  }

  try {
    const r = await enviarAlerta({ assunto, texto });
    console.log(`E-mail aceito para ${r.aceitos.join(', ')} (${r.messageId})`);
    if (r.rejeitados.length) console.error(`Destinatários recusados: ${r.rejeitados.join(', ')}`);
  } catch (e) {
    console.error(`✗ Falha ao enviar o alerta: ${e.message}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  await pool.end();
}
