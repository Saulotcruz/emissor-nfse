import { apenasDigitos } from '../documento.js';
import { chaveValida } from './id-dps.js';
import { tag, grupo, dataHoraUtc } from './xml.js';
import { NAMESPACE, VERSAO, VER_APLIC, TP_AMB } from './dps-builder.js';

/**
 * Monta o Pedido de Registro de Evento (cancelamento e afins).
 *
 * Estrutura, conforme `TCPedRegEvt` em schemas/1.01/tiposEventos_v1.01.xsd:
 *
 *   <pedRegEvento versao="1.01">
 *     <infPedReg Id="PRE…">
 *       tpAmb, verAplic, dhEvento, CNPJAutor|CPFAutor, chNFSe, <e101101>…
 *     </infPedReg>
 *     <ds:Signature/>
 *   </pedRegEvento>
 */

export const EVENTOS = {
  cancelamento: '101101',
  cancelamentoPorSubstituicao: '105102',
  solicitacaoAnaliseFiscalCancelamento: '101103',
};

/**
 * Justificativas aceitas no cancelamento (`TSCodJustCanc`).
 */
export const MOTIVO_CANCELAMENTO = {
  erro_emissao: '1',
  servico_nao_prestado: '2',
  outros: '9',
};

const DESCRICAO_CANCELAMENTO = 'Cancelamento de NFS-e';
const MOTIVO_MIN = 15;
const MOTIVO_MAX = 255;

/**
 * Id do pedido de registro de evento.
 *
 * "PRE" + chave de acesso da NFS-e (50) + código do evento (6) = PRE + 56 dígitos.
 *
 * Atenção: a documentação dentro do XSD (`TSIdPedRegEvt`) menciona um número
 * sequencial que NÃO existe na composição — o anexo de leiaute oficial
 * (anexo_ii, linha 13) confirma que são só os dois campos, e é o que fecha com
 * o `pattern="PRE[0-9]{56}"`.
 */
export function montarIdPedidoEvento({ chaveAcesso, codigoEvento }) {
  const chave = apenasDigitos(chaveAcesso);
  if (!chaveValida(chave)) {
    throw new Error(`Chave de acesso deve ter 50 dígitos: ${chaveAcesso}`);
  }
  const codigo = apenasDigitos(codigoEvento);
  if (codigo.length !== 6) {
    throw new Error(`Código do evento deve ter 6 dígitos: ${codigoEvento}`);
  }

  const id = `PRE${chave}${codigo}`;
  if (!/^PRE[0-9]{56}$/.test(id)) {
    throw new Error(`Id do pedido de evento não bate com o padrão do XSD: ${id}`);
  }
  return id;
}

/**
 * Monta o pedido de cancelamento de uma NFS-e.
 *
 * @param {object} p
 * @param {object} p.emitente      Linha da tabela `emitente` (autor do evento)
 * @param {string} p.chaveAcesso   Chave de 50 dígitos da nota a cancelar
 * @param {string} p.motivo        Texto entre 15 e 255 caracteres
 * @param {string} [p.codigoMotivo] '1' erro na emissão | '2' serviço não prestado | '9' outros
 * @param {string} [p.ambiente]
 * @param {Date}   [p.dhEvento]
 */
export function montarCancelamento({
  emitente,
  chaveAcesso,
  motivo,
  codigoMotivo = MOTIVO_CANCELAMENTO.erro_emissao,
  ambiente,
  dhEvento,
}) {
  if (!emitente?.cnpj) throw new Error('Emitente sem CNPJ para autorar o evento');
  if (!Object.values(MOTIVO_CANCELAMENTO).includes(String(codigoMotivo))) {
    throw new Error(`Código de motivo inválido: ${codigoMotivo}. Use 1, 2 ou 9`);
  }

  const texto = String(motivo ?? '').trim();
  if (texto.length < MOTIVO_MIN || texto.length > MOTIVO_MAX) {
    throw new Error(
      `O motivo do cancelamento deve ter entre ${MOTIVO_MIN} e ${MOTIVO_MAX} caracteres (tem ${texto.length})`
    );
  }

  const id = montarIdPedidoEvento({ chaveAcesso, codigoEvento: EVENTOS.cancelamento });
  const doc = apenasDigitos(emitente.cnpj);
  const amb = ambiente ?? emitente.ambiente ?? 'producao_restrita';

  const infPedReg = grupo(
    'infPedReg',
    [
      tag('tpAmb', TP_AMB[amb] ?? TP_AMB.producao_restrita),
      tag('verAplic', VER_APLIC),
      tag('dhEvento', dataHoraUtc(dhEvento ?? new Date())),
      // E0812: o CNPJ do autor tem que bater com o do certificado que assina.
      doc.length === 14 ? tag('CNPJAutor', doc) : tag('CPFAutor', doc),
      tag('chNFSe', apenasDigitos(chaveAcesso)),
      grupo('e101101', [
        // xDesc é enumerado no XSD: só este texto exato é aceito.
        tag('xDesc', DESCRICAO_CANCELAMENTO),
        tag('cMotivo', String(codigoMotivo)),
        tag('xMotivo', texto),
      ]),
    ],
    { atributos: ` Id="${id}"` }
  );

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<pedRegEvento xmlns="${NAMESPACE}" versao="${VERSAO}">${infPedReg}</pedRegEvento>`;

  return { xml, id };
}
