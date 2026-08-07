import nodemailer from 'nodemailer';

/**
 * Envio de e-mail de alerta.
 *
 * Com Gmail, SMTP_PASS tem que ser uma **Senha de app** — o Google não aceita
 * mais a senha da conta em SMTP, e a senha de app só existe com verificação em
 * duas etapas ativada.
 */

export function configuracaoSmtp(env = process.env) {
  const faltando = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'ALERTA_EMAIL_PARA'].filter((k) => !env[k]);
  if (faltando.length) {
    throw new Error(`Configure no .env para enviar alertas: ${faltando.join(', ')}`);
  }

  const porta = Number(env.SMTP_PORT || 587);
  return {
    host: env.SMTP_HOST,
    port: porta,
    // 465 é TLS direto; 587 sobe para TLS via STARTTLS.
    secure: porta === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    de: env.ALERTA_EMAIL_DE || env.SMTP_USER,
    para: env.ALERTA_EMAIL_PARA,
  };
}

export function criarTransporte(cfg = configuracaoSmtp()) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.auth,
  });
}

/** Confere host, porta e credenciais sem mandar mensagem nenhuma. */
export async function verificarConexao(cfg = configuracaoSmtp()) {
  const transporte = criarTransporte(cfg);
  try {
    await transporte.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: traduzirErroSmtp(e) };
  } finally {
    transporte.close();
  }
}

export async function enviarAlerta({ assunto, texto, cfg = configuracaoSmtp() }) {
  const transporte = criarTransporte(cfg);
  try {
    const r = await transporte.sendMail({
      from: cfg.de,
      to: cfg.para,
      subject: assunto,
      text: texto,
    });
    return { ok: true, messageId: r.messageId };
  } catch (e) {
    throw new Error(traduzirErroSmtp(e));
  } finally {
    transporte.close();
  }
}

/** As mensagens cruas do SMTP não dizem o que fazer; estas dizem. */
function traduzirErroSmtp(e) {
  const msg = String(e.message ?? e);
  if (/Username and Password not accepted|BadCredentials|535/i.test(msg)) {
    return (
      'Credenciais SMTP recusadas. Com Gmail, SMTP_PASS precisa ser uma Senha de app ' +
      '(myaccount.google.com → Segurança → Verificação em duas etapas → Senhas de app), ' +
      'não a senha da conta.'
    );
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(msg)) {
    return `Não foi possível conectar ao servidor SMTP: ${msg}. Confira SMTP_HOST e SMTP_PORT, e se a porta não está bloqueada no servidor.`;
  }
  return msg;
}
