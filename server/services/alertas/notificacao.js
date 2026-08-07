import { configuracaoSmtp, criarTransporte } from './email.js';

/**
 * Aviso de NFS-e emitida, com o XML em anexo.
 *
 * Diferente do alerta diário, que só fala quando há problema: este é o
 * comprovante de cada emissão. O XML anexado é o documento fiscal em si — o
 * DANFSe é só representação.
 *
 * Nunca derruba a emissão: a nota já está autorizada na SEFIN quando isto roda,
 * e falha de e-mail não pode desfazer nem mascarar isso.
 */

export const CONSULTA_PUBLICA = 'https://www.nfse.gov.br/consultapublica';

export function notificacaoAtiva(env = process.env) {
  // Ligada por padrão; desliga com NOTIFICAR_EMISSAO=0.
  return env.NOTIFICAR_EMISSAO !== '0';
}

export function montarMensagem({ nota, tomador, emitente }) {
  const valor = Number(nota.valor_servico).toFixed(2);
  const ehProducao = nota.ambiente === 'producao';

  const assunto = ehProducao
    ? `[NFS-e] Nota ${nota.numero_nfse ?? nota.numero_dps} emitida — ${tomador.razao_social} — R$ ${valor}`
    : `[NFS-e][TESTE] Nota ${nota.numero_nfse ?? nota.numero_dps} emitida — ${tomador.razao_social}`;

  const linhas = [
    ehProducao ? '' : '*** PRODUÇÃO RESTRITA — esta nota NÃO tem efeito fiscal ***\n',
    `Prestador     ${emitente.razao_social}`,
    `Tomador       ${tomador.razao_social} (${tomador.documento})`,
    `Serviço       ${nota.descricao_servico}`,
    `Competência   ${nota.competencia}`,
    `Valor         R$ ${valor}`,
    '',
    `NFS-e nº      ${nota.numero_nfse ?? '—'}`,
    `DPS           série ${nota.serie} nº ${nota.numero_dps}`,
    `Chave         ${nota.chave_acesso}`,
    '',
    'Tributos apurados:',
    `  ISSQN       R$ ${valorOuTraco(nota.valor_iss)}`,
    `  PIS         R$ ${valorOuTraco(nota.valor_pis)}`,
    `  COFINS      R$ ${valorOuTraco(nota.valor_cofins)}`,
    '',
    `Consulta pública: ${CONSULTA_PUBLICA}`,
    '',
    'O XML da NFS-e segue em anexo — é o documento fiscal; o DANFSe é representação.',
  ];

  return { assunto, texto: linhas.filter((l) => l !== null).join('\n') };
}

function valorOuTraco(v) {
  return v === null || v === undefined ? '—' : Number(v).toFixed(2);
}

export function nomeArquivoXml(nota) {
  const base = nota.chave_acesso ?? `${nota.serie}-${nota.numero_dps}`;
  return `nfse-${base}.xml`;
}

/**
 * @returns {{enviado: boolean, motivo?: string, aceitos?: string[]}}
 */
export async function notificarEmissao({ nota, tomador, emitente, env = process.env }) {
  if (!notificacaoAtiva(env)) return { enviado: false, motivo: 'notificação desligada' };
  if (!nota.nfse_xml) return { enviado: false, motivo: 'nota sem XML' };

  let cfg;
  try {
    cfg = configuracaoSmtp(env);
  } catch (e) {
    return { enviado: false, motivo: e.message };
  }

  const para = env.EMISSAO_EMAIL_PARA
    ? String(env.EMISSAO_EMAIL_PARA).split(',').map((x) => x.trim()).filter(Boolean).join(', ')
    : cfg.para;

  const { assunto, texto } = montarMensagem({ nota, tomador, emitente });
  const transporte = criarTransporte(cfg);
  try {
    const r = await transporte.sendMail({
      from: cfg.de,
      to: para,
      subject: assunto,
      text: texto,
      attachments: [
        { filename: nomeArquivoXml(nota), content: nota.nfse_xml, contentType: 'application/xml' },
      ],
    });
    return { enviado: true, aceitos: r.accepted ?? [] };
  } finally {
    transporte.close();
  }
}
