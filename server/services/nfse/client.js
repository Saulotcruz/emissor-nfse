import fs from 'node:fs';
import { pool, withTransaction } from '../../db/pool.js';
import { montarDps } from './dps-builder.js';
import { montarIdDps } from './id-dps.js';
import { lerCertificado, assinarDps, assinarPedidoEvento } from './signer.js';
import { SefinClient } from './transport.js';
import { montarCancelamento, MOTIVO_CANCELAMENTO } from './evento-builder.js';
import { SefinError, TransporteSefinError } from './errors.js';
import { notificarEmissao } from '../alertas/notificacao.js';

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

/**
 * Monta o cliente da SEFIN.
 *
 * O `ambiente` pode ser sobrescrito porque cada nota carrega o seu: depois da
 * virada para produção, o emitente fica em `producao` mas as notas antigas
 * continuam em `producao_restrita`. Consultar, cancelar ou reemitir uma delas
 * usando o endpoint de produção falaria com o ambiente errado — a chave de
 * acesso não existe lá, e a resposta seria um 404 enganoso.
 */
export function criarClienteSefin(emitente, { ambiente } = {}) {
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
      ambiente: ambiente ?? emitente.ambiente,
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

  const { client, certificado } = criarClienteSefin(emitente, { ambiente: nota.ambiente });
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
    const resultado = await gravarSucesso(notaId, r);
    await avisarPorEmail(resultado.nota, tomador, emitente);
    return resultado;
  } catch (e) {
    await gravarErro(notaId, e);
    throw e;
  }
}

/**
 * A nota já está autorizada na SEFIN quando isto roda. Falha de e-mail é
 * registrada no log e segue o jogo — derrubar aqui faria a emissão parecer
 * malsucedida quando ela deu certo.
 */
async function avisarPorEmail(nota, tomador, emitente) {
  try {
    const r = await notificarEmissao({ nota, tomador, emitente });
    if (r.enviado) console.log(`Nota #${nota.id}: aviso enviado para ${r.aceitos.join(', ')}`);
    else if (r.motivo !== 'notificação desligada') {
      console.warn(`Nota #${nota.id}: aviso não enviado (${r.motivo})`);
    }
  } catch (e) {
    console.error(`Nota #${nota.id}: falha ao enviar o aviso por e-mail: ${e.message}`);
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
export async function cancelarNota(notaId, { motivo, codigoMotivo, algoritmo = 'sha256' } = {}) {
  const motivoCodigo = codigoMotivo ?? MOTIVO_CANCELAMENTO.erro_emissao;
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
    codigoMotivo: motivoCodigo,
    ambiente: nota.ambiente,
  });

  const { client, certificado } = criarClienteSefin(emitente, { ambiente: nota.ambiente });
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

/**
 * Códigos de evento que deixam a NFS-e cancelada.
 * Cobrir todos importa: o cancelamento pode ter vindo por substituição, por
 * análise fiscal ou de ofício pela prefeitura, não só pelo pedido comum.
 */
export const EVENTOS_DE_CANCELAMENTO = ['101101', '105102', '105104', '305101'];

/**
 * Confere na SEFIN se a nota foi cancelada fora daqui — pelo Portal Nacional,
 * por exemplo — e atualiza o banco.
 *
 * Cancelamento NÃO devolve o número da DPS: ele foi consumido na emissão e a
 * sequência segue adiante. O que a divergência causa não é falha de numeração,
 * e sim o sistema afirmar que uma nota está válida quando não está.
 */
export async function sincronizarNota(notaId) {
  const [[nota]] = await pool.query('SELECT * FROM nota WHERE id = ?', [notaId]);
  if (!nota) throw new Error(`Nota ${notaId} não encontrada`);
  if (nota.status !== 'autorizada' || !nota.chave_acesso) {
    return { mudou: false, motivo: `status ${nota.status}` };
  }

  const emitente = await carregarEmitente();
  const { client } = criarClienteSefin(emitente, { ambiente: nota.ambiente });

  // A consulta exige o tipo do evento: GET /nfse/{chave}/eventos responde 405,
  // porque esse caminho é o do POST de registro. Com o tipo, funciona.
  let cancelamento = null;
  let consultados = 0;
  for (const tipo of EVENTOS_DE_CANCELAMENTO) {
    const eventos = await client.consultarEventos(nota.chave_acesso, tipo);
    consultados += 1;
    if (eventos.length) {
      cancelamento = eventos[0];
      break;
    }
  }

  if (!cancelamento) return { mudou: false, eventos: 0, consultados };

  const [[jaRegistrado]] = await pool.query(
    'SELECT id FROM nota_evento WHERE nota_id = ? AND status = ? LIMIT 1',
    [notaId, 'aceito']
  );
  if (!jaRegistrado) {
    await pool.query(
      'INSERT INTO nota_evento (nota_id, tipo, motivo, status, retorno_xml) VALUES (?, ?, ?, ?, ?)',
      [notaId, 'cancelamento', 'Cancelada fora do sistema (Portal Nacional)', 'aceito', cancelamento.eventoXml ?? null]
    );
  }
  await pool.query('UPDATE nota SET status = ? WHERE id = ?', ['cancelada', notaId]);
  return { mudou: true, novoStatus: 'cancelada' };
}

/**
 * Sincroniza as notas autorizadas de um período.
 *
 * A janela existe para a carga não crescer junto com o histórico: rodando de
 * meia em meia hora, conferir todas as notas já emitidas seria desperdício —
 * uma nota de um ano atrás não vai ser cancelada agora. `dias = 0` desliga a
 * janela e confere tudo, útil para uma varredura pontual.
 */
export async function sincronizarNotas({ limite = 500, dias = 90 } = {}) {
  const filtroPeriodo = dias > 0 ? 'AND autorizada_em >= DATE_SUB(NOW(), INTERVAL ? DAY)' : '';
  const params = dias > 0 ? [dias, limite] : [limite];
  const [notas] = await pool.query(
    `SELECT id FROM nota
      WHERE status = 'autorizada' AND chave_acesso IS NOT NULL ${filtroPeriodo}
      ORDER BY id DESC LIMIT ?`,
    params
  );
  const resultados = [];
  for (const n of notas) {
    try {
      resultados.push({ id: n.id, ...(await sincronizarNota(n.id)) });
    } catch (e) {
      resultados.push({ id: n.id, erro: e.message });
    }
  }
  return resultados;
}
