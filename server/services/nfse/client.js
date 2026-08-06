import fs from 'node:fs';
import { pool, withTransaction } from '../../db/pool.js';
import { montarDps } from './dps-builder.js';
import { montarIdDps } from './id-dps.js';
import { lerCertificado, assinarDps, assinarPedidoEvento } from './signer.js';
import { SefinClient } from './transport.js';
import { montarCancelamento, MOTIVO_CANCELAMENTO } from './evento-builder.js';
import { SefinError, TransporteSefinError } from './errors.js';

/**
 * Fachada da emissão: banco -> DPS -> assinatura -> SEFIN -> banco.
 *
 * A reserva do número da DPS é separada do envio de propósito. Reservar grava a
 * nota com número definitivo; enviar pode falhar e ser retentado depois — sempre
 * com o MESMO número, o que mantém o idDPS determinístico e permite perguntar à
 * SEFIN se aquela DPS já virou nota antes de reenviar.
 */

export async function carregarEmitente() {
  const [[emitente]] = await pool.query('SELECT * FROM emitente ORDER BY id LIMIT 1');
  if (!emitente) throw new Error('Emitente não configurado. Rode npm run seed.');
  return emitente;
}

export async function carregarServicoPadrao() {
  const [[servico]] = await pool.query(
    'SELECT * FROM servico WHERE ativo = 1 ORDER BY padrao DESC, id LIMIT 1'
  );
  if (!servico) throw new Error('Nenhum serviço cadastrado. Rode npm run seed.');
  return servico;
}

/**
 * Reserva o próximo número da série e grava a nota como `pendente`.
 * O incremento acontece dentro da transação, com SELECT ... FOR UPDATE, para
 * duas emissões simultâneas não pegarem o mesmo número.
 */
export async function reservarNota({
  tomadorId,
  servicoId,
  valorServico,
  descricaoServico,
  competencia = null,
  origem = 'manual',
  stripeInvoiceId = null,
  stripeSubscriptionId = null,
}) {
  return withTransaction(async (conn) => {
    const [[emitente]] = await conn.query('SELECT * FROM emitente ORDER BY id LIMIT 1 FOR UPDATE');
    if (!emitente) throw new Error('Emitente não configurado');

    const numeroDps = Number(emitente.proximo_numero_dps);
    const idDps = montarIdDps({
      codigoMunicipio: emitente.codigo_municipio,
      documento: emitente.cnpj,
      serie: emitente.serie_dps,
      numeroDps,
    });

    const [r] = await conn.query(
      `INSERT INTO nota
         (tomador_id, servico_id, stripe_invoice_id, stripe_subscription_id, origem,
          serie, numero_dps, id_dps, competencia, valor_servico, descricao_servico,
          municipio_incidencia_iss, ambiente, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURDATE()), ?, ?, ?, ?, 'pendente')`,
      [
        tomadorId,
        servicoId,
        stripeInvoiceId,
        stripeSubscriptionId,
        origem,
        emitente.serie_dps,
        numeroDps,
        idDps,
        competencia,
        valorServico,
        descricaoServico,
        emitente.codigo_municipio,
        emitente.ambiente,
      ]
    );

    await conn.query('UPDATE emitente SET proximo_numero_dps = ? WHERE id = ?', [
      numeroDps + 1,
      emitente.id,
    ]);

    return { id: r.insertId, numeroDps, idDps, serie: emitente.serie_dps };
  });
}

/** Monta o cliente da SEFIN a partir do .env e do ambiente do emitente. */
export function criarClienteSefin(emitente) {
  const caminho = process.env.NFSE_CERT_PATH;
  const senha = process.env.NFSE_CERT_PASSWORD;
  if (!caminho) throw new Error('NFSE_CERT_PATH não definido');
  if (!senha) throw new Error('NFSE_CERT_PASSWORD não definido');

  const pfx = fs.readFileSync(caminho);
  const certificado = lerCertificado({ buffer: pfx, senha });

  return {
    // Vai o PEM, não o .pfx: o OpenSSL 3 recusa o PKCS#12 da ICP-Brasil.
    // A cadeia completa (titular + intermediários) segue no `cert`.
    client: new SefinClient({
      ambiente: emitente.ambiente,
      chavePem: certificado.privateKeyPem,
      certPem: certificado.cadeiaPem ?? certificado.certificatePem,
    }),
    certificado,
  };
}

/**
 * Emite uma nota já reservada.
 *
 * @param {number} notaId
 * @param {object} [opcoes]
 * @param {'sha256'|'sha1'} [opcoes.algoritmo]  algoritmo da assinatura
 * @param {boolean} [opcoes.conferirAntes]      consulta a SEFIN antes de enviar
 */
export async function emitirNota(notaId, { algoritmo = 'sha256', conferirAntes = true } = {}) {
  const [[nota]] = await pool.query('SELECT * FROM nota WHERE id = ?', [notaId]);
  if (!nota) throw new Error(`Nota ${notaId} não encontrada`);
  if (nota.status === 'autorizada') {
    return { jaAutorizada: true, chaveAcesso: nota.chave_acesso, nota };
  }

  const [[tomador]] = await pool.query('SELECT * FROM tomador WHERE id = ?', [nota.tomador_id]);
  const [[servico]] = await pool.query('SELECT * FROM servico WHERE id = ?', [nota.servico_id]);
  const emitente = await carregarEmitente();

  const { xml, id } = montarDps({
    emitente,
    tomador,
    servico,
    nota: {
      numeroDps: Number(nota.numero_dps),
      serie: nota.serie,
      competencia: nota.competencia,
      valorServico: Number(nota.valor_servico),
      descricaoServico: nota.descricao_servico,
      municipioIncidencia: nota.municipio_incidencia_iss,
      ambiente: nota.ambiente,
    },
  });

  const { client, certificado } = criarClienteSefin(emitente);
  const assinado = assinarDps(xml, certificado, { algoritmo });

  await pool.query(
    'UPDATE nota SET status = ?, dps_xml = ?, tentativas = tentativas + 1 WHERE id = ?',
    ['enviando', assinado, notaId]
  );

  // Se a DPS já existe na SEFIN (envio anterior que se perdeu no caminho),
  // recuperar é sempre melhor que reenviar.
  if (conferirAntes && nota.tentativas > 0) {
    const existente = await client.consultarDps(id).catch(() => null);
    if (existente?.nfseXml) {
      return gravarSucesso(notaId, { chaveAcesso: extrairChave(existente), nfseXml: existente.nfseXml });
    }
  }

  try {
    const r = await client.enviarDps(assinado);
    return gravarSucesso(notaId, r);
  } catch (e) {
    await gravarErro(notaId, e);
    throw e;
  }
}

async function gravarSucesso(notaId, { chaveAcesso, nfseXml }) {
  const numero = nfseXml ? extrairNumeroNfse(nfseXml) : null;
  await pool.query(
    `UPDATE nota
        SET status = 'autorizada', chave_acesso = ?, numero_nfse = ?, nfse_xml = ?,
            erro_codigo = NULL, erro_mensagem = NULL, autorizada_em = NOW()
      WHERE id = ?`,
    [chaveAcesso, numero, nfseXml, notaId]
  );
  const [[nota]] = await pool.query('SELECT * FROM nota WHERE id = ?', [notaId]);
  return { jaAutorizada: false, chaveAcesso, numeroNfse: numero, nota };
}

async function gravarErro(notaId, e) {
  // Transporte não é rejeição: a nota continua pendente porque pode ser retentada.
  const status = e instanceof TransporteSefinError ? 'pendente' : 'erro';
  await pool.query('UPDATE nota SET status = ?, erro_codigo = ?, erro_mensagem = ? WHERE id = ?', [
    status,
    e instanceof SefinError ? e.codigo : null,
    e.message?.slice(0, 2000) ?? String(e),
    notaId,
  ]);
}

function extrairChave(resposta) {
  return (
    resposta.corpo?.chaveAcesso ??
    resposta.nfseXml?.match(/<chNFSe>([0-9]{50})<\/chNFSe>/)?.[1] ??
    resposta.nfseXml?.match(/Id="NFS?([0-9]{50})"/)?.[1] ??
    null
  );
}

function extrairNumeroNfse(nfseXml) {
  return nfseXml.match(/<nNFSe>([^<]+)<\/nNFSe>/)?.[1] ?? null;
}

/**
 * Cancela uma NFS-e autorizada, via evento e101101.
 *
 * O prazo e as condições de cancelamento são parametrizados pelo município
 * (E0822 prazo, E0823 valor, E0824 tomador não identificado), então a rejeição
 * pode ser legítima mesmo com o XML correto.
 *
 * @param {number} notaId
 * @param {object} p
 * @param {string} p.motivo        entre 15 e 255 caracteres
 * @param {string} [p.codigoMotivo] '1' erro na emissão | '2' serviço não prestado | '9' outros
 */
export async function cancelarNota(notaId, { motivo, codigoMotivo = MOTIVO_CANCELAMENTO.erro_emissao, algoritmo = 'sha256' } = {}) {
  const [[nota]] = await pool.query('SELECT * FROM nota WHERE id = ?', [notaId]);
  if (!nota) throw new Error(`Nota ${notaId} não encontrada`);
  if (nota.status === 'cancelada') return { jaCancelada: true, nota };
  if (nota.status !== 'autorizada' || !nota.chave_acesso) {
    throw new Error(`Só é possível cancelar nota autorizada. Nota ${notaId} está "${nota.status}"`);
  }

  const emitente = await carregarEmitente();
  const { xml, id } = montarCancelamento({
    emitente,
    chaveAcesso: nota.chave_acesso,
    motivo,
    codigoMotivo,
    ambiente: nota.ambiente,
  });

  const { client, certificado } = criarClienteSefin(emitente);
  const assinado = assinarPedidoEvento(xml, certificado, { algoritmo });

  const [r] = await pool.query(
    'INSERT INTO nota_evento (nota_id, tipo, motivo, status, evento_xml) VALUES (?, ?, ?, ?, ?)',
    [notaId, 'e101101', motivo, 'pendente', assinado]
  );

  try {
    const retorno = await client.enviarEvento(nota.chave_acesso, assinado);
    // Guarda o XML do evento registrado — é o comprovante do cancelamento.
    await pool.query('UPDATE nota_evento SET status = ?, retorno_xml = ? WHERE id = ?', [
      'aceito',
      retorno.eventoXml ?? JSON.stringify(retorno.corpo)?.slice(0, 60000) ?? null,
      r.insertId,
    ]);
    await pool.query('UPDATE nota SET status = ? WHERE id = ?', ['cancelada', notaId]);
    return { jaCancelada: false, idPedido: id, eventoXml: retorno.eventoXml, retorno: retorno.corpo };
  } catch (e) {
    await pool.query('UPDATE nota_evento SET status = ?, erro_mensagem = ? WHERE id = ?', [
      'rejeitado',
      e.message?.slice(0, 2000) ?? String(e),
      r.insertId,
    ]);
    throw e;
  }
}
