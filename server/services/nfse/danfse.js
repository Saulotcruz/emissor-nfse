import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import {
  lerNfse,
  TRIBUTACAO_ISSQN,
  RETENCAO_ISSQN,
  RETENCAO_PIS_COFINS,
  SITUACAO,
} from './danfse-dados.js';

/**
 * Geração do DANFSe em PDF.
 *
 * A API oficial que gerava este PDF foi **desligada em 1º de julho de 2026**
 * (NT SE/CGSN 008/2026): a responsabilidade passou para os sistemas emissores.
 * Por isso montamos o documento aqui.
 *
 * Regras da nota técnica que o layout observa:
 *  - fontes Arial ou MS Sans Serif, mínimo 7pt
 *  - QR Code de 1,52 cm × 1,52 cm
 *  - paridade XML–PDF: só aparece o que está no XML
 *  - documento cancelado ou substituído leva marca d'água diagonal
 *
 * Sobre a fonte: o PDF usa Helvetica, que é a métrica equivalente de Arial e
 * está embutida em todo leitor de PDF. Embutir a Arial exigiria distribuir o
 * arquivo da fonte, que é licenciado.
 */

const CM = 28.3465; // 1 cm em pontos PostScript
const QR_LADO = 1.52 * CM; // exigência da NT 008/2026
const MARGEM = 28;
const LARGURA = 595.28 - MARGEM * 2; // A4 retrato

const CINZA = '#f2f2f2';
const LINHA = '#999999';
const TINTA = '#000000';

export const URL_CONSULTA = process.env.NFSE_URL_CONSULTA || 'https://www.nfse.gov.br/consultapublica';

const dinheiro = (v) =>
  v === null || v === undefined || v === ''
    ? '-'
    : `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const percentual = (v) =>
  v === null || v === undefined || v === '' ? '-' : `${Number(v).toFixed(2).replace('.', ',')} %`;

const dataBr = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '-');

function dataHoraBr(iso) {
  if (!iso) return '-';
  const [d, h] = String(iso).split('T');
  return `${d.split('-').reverse().join('/')} ${String(h ?? '').slice(0, 8)}`;
}

const documento = (p) => {
  if (!p) return '-';
  if (p.cnpj) return p.cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  if (p.cpf) return p.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return '-';
};

const cep = (v) => (v ? String(v).replace(/(\d{5})(\d{3})/, '$1-$2') : '-');

function enderecoLinha(e) {
  if (!e) return '-';
  return [e.logradouro, e.numero, e.complemento, e.bairro].filter(Boolean).join(', ') || '-';
}

/** Chave em blocos de 4, como o DANFSe oficial mostra. */
const chaveFormatada = (c) => (c ? String(c).replace(/(\d{4})(?=\d)/g, '$1 ').trim() : '-');

/**
 * @param {string} nfseXml XML autorizado da NFS-e
 * @param {object} [estado] situação atual da nota
 * @param {boolean} [estado.cancelada]
 * @param {boolean} [estado.substituida]
 * @returns {Promise<Buffer>} PDF
 */
export async function gerarDanfse(nfseXml, estado = {}) {
  const d = lerNfse(nfseXml);
  const qr = await QRCode.toBuffer(`${URL_CONSULTA}?chave=${d.chaveAcesso}`, {
    margin: 0,
    errorCorrectionLevel: 'M',
    width: 300,
  });

  const doc = new PDFDocument({ size: 'A4', margin: MARGEM, info: {
    Title: `DANFSe ${d.numeroNfse ?? ''}`,
    Author: d.prestador?.nome ?? 'NFS-e',
  } });

  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const pronto = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  desenhar(doc, d, qr);
  marcaDagua(doc, estado);
  doc.end();
  return pronto;
}

/**
 * Marca d'água diagonal exigida pela NT 008/2026 para documento cancelado ou
 * substituído.
 *
 * O estado vem de fora, não do XML: o `cStat` da NFS-e nunca muda para
 * cancelada — o cancelamento é um evento separado. Sem esta marca, o PDF de uma
 * nota cancelada é visualmente idêntico ao de uma válida.
 */
function marcaDagua(doc, { cancelada, substituida }) {
  const texto = cancelada ? 'CANCELADA' : substituida ? 'SUBSTITUÍDA' : null;
  if (!texto) return;

  doc.save();
  doc.rotate(-45, { origin: [297, 421] });
  doc.font('Helvetica-Bold').fontSize(64).fillColor('#c0392b').opacity(0.28)
    .text(texto, 0, 400, { width: 595, align: 'center' });
  doc.restore();
}

function desenhar(doc, d, qr) {
  doc.font('Helvetica').fontSize(7).fillColor(TINTA);
  let y = MARGEM;

  y = cabecalho(doc, d, y);
  y = blocoChave(doc, d, qr, y);
  y = blocoIdentificacao(doc, d, y);
  y = blocoPessoa(doc, 'PRESTADOR / FORNECEDOR', d.prestador, y);
  y = blocoPessoa(doc, 'TOMADOR / ADQUIRENTE', d.tomador, y);
  y = blocoServico(doc, d, y);
  y = blocoIssqn(doc, d, y);
  y = blocoFederal(doc, d, y);
  y = blocoTotais(doc, d, y);
  blocoComplementares(doc, d, y);
}

/* ---------------------------------------------------------------- primitivas */

function titulo(doc, texto, y, altura = 12) {
  doc.rect(MARGEM, y, LARGURA, altura).fill(CINZA);
  doc.fillColor(TINTA).font('Helvetica-Bold').fontSize(7).text(texto, MARGEM + 3, y + 3.5);
  return y + altura;
}

/**
 * Uma linha de campos rotulados. As larguras são frações da largura útil,
 * então o layout acompanha a página em vez de depender de posições fixas.
 */
function campos(doc, y, itens, { altura = 22 } = {}) {
  let x = MARGEM;
  for (const item of itens) {
    const largura = LARGURA * item.w;
    doc.rect(x, y, largura, altura).strokeColor(LINHA).lineWidth(0.4).stroke();
    doc.font('Helvetica').fontSize(5.5).fillColor('#444')
      .text(item.rotulo, x + 3, y + 3, { width: largura - 6, lineBreak: false });
    doc.font(item.forte ? 'Helvetica-Bold' : 'Helvetica').fontSize(item.fonte ?? 7).fillColor(TINTA)
      .text(item.valor ?? '-', x + 3, y + 10.5, { width: largura - 6, height: altura - 12, ellipsis: true });
    x += largura;
  }
  return y + altura;
}

function faixa(doc, texto, y, altura = 11) {
  doc.rect(MARGEM, y, LARGURA, altura).strokeColor(LINHA).lineWidth(0.4).stroke();
  doc.font('Helvetica').fontSize(6).fillColor('#555')
    .text(texto, MARGEM, y + 3, { width: LARGURA, align: 'center' });
  return y + altura;
}

/* -------------------------------------------------------------------- blocos */

function cabecalho(doc, d, y) {
  const altura = 34;
  doc.rect(MARGEM, y, LARGURA, altura).strokeColor(LINHA).lineWidth(0.6).stroke();

  doc.font('Helvetica-Bold').fontSize(13).fillColor('#1a7a3c')
    .text('NFS', MARGEM + 8, y + 8, { continued: true })
    .fillColor('#1a5fa8').text('e');
  doc.font('Helvetica').fontSize(5.5).fillColor('#444')
    .text('Nota Fiscal de\nServiço eletrônica', MARGEM + 8, y + 22);

  doc.font('Helvetica-Bold').fontSize(9).fillColor(TINTA)
    .text('DANFSe v2.0', MARGEM, y + 8, { width: LARGURA, align: 'center' });
  doc.font('Helvetica').fontSize(7)
    .text('Documento Auxiliar da NFS-e', MARGEM, y + 20, { width: LARGURA, align: 'center' });

  const dir = MARGEM + LARGURA - 150;
  doc.font('Helvetica').fontSize(6).fillColor(TINTA)
    .text(`Município: ${d.localEmissao ?? '-'}`, dir, y + 6, { width: 145 })
    .text(`Ambiente Gerador: ${d.ambienteGerador ?? '-'}`, dir, y + 15, { width: 145 })
    .text(`Tipo de Ambiente: ${d.ambiente ?? '-'}`, dir, y + 24, { width: 145 });

  return y + altura;
}

function blocoChave(doc, d, qr, y) {
  const altura = Math.max(QR_LADO + 16, 60);
  doc.rect(MARGEM, y, LARGURA, altura).strokeColor(LINHA).lineWidth(0.4).stroke();

  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(TINTA)
    .text('CHAVE DE ACESSO DA NFS-e', MARGEM + 4, y + 4);
  doc.font('Helvetica').fontSize(7.5)
    .text(chaveFormatada(d.chaveAcesso), MARGEM + 4, y + 14, { width: LARGURA - QR_LADO - 160 });

  // QR de 1,52 cm exatos, como a NT 008/2026 exige.
  const qrX = MARGEM + LARGURA - QR_LADO - 8;
  doc.image(qr, qrX, y + 6, { width: QR_LADO, height: QR_LADO });

  doc.font('Helvetica').fontSize(5).fillColor('#444')
    .text(
      'A autenticidade desta NFS-e pode ser verificada pela leitura deste código QR ou pela consulta da chave de acesso no portal nacional da NFS-e',
      MARGEM + LARGURA - QR_LADO - 165, y + 6,
      { width: 150 }
    );

  return y + altura;
}

function blocoIdentificacao(doc, d, y) {
  y = campos(doc, y, [
    { rotulo: 'NÚMERO DA NFS-e', valor: d.numeroNfse, w: 0.22, forte: true },
    { rotulo: 'COMPETÊNCIA DA NFS-e', valor: dataBr(d.dps.competencia), w: 0.26 },
    { rotulo: 'DATA E HORA DA EMISSÃO DA NFS-e', valor: dataHoraBr(d.dataHoraProcessamento), w: 0.52 },
  ]);
  y = campos(doc, y, [
    { rotulo: 'NÚMERO DA DPS', valor: d.dps.numero, w: 0.22 },
    { rotulo: 'SÉRIE DA DPS', valor: d.dps.serie, w: 0.26 },
    { rotulo: 'DATA E HORA DA EMISSÃO DA DPS', valor: dataHoraBr(d.dps.dataHoraEmissao), w: 0.52 },
  ]);
  return campos(doc, y, [
    { rotulo: 'EMITENTE DA NFS-e', valor: 'Prestador', w: 0.22 },
    { rotulo: 'SITUAÇÃO DA NFS-e', valor: SITUACAO[d.situacao] ?? d.situacao, w: 0.26 },
    { rotulo: 'FINALIDADE', valor: '-', w: 0.52 },
  ]);
}

function blocoPessoa(doc, rotulo, p, y) {
  y = titulo(doc, rotulo, y);
  y = campos(doc, y, [
    { rotulo: 'CNPJ / CPF / NIF', valor: documento(p), w: 0.34 },
    { rotulo: 'Indicador Municipal (Inscrição)', valor: p?.inscricaoMunicipal ?? '-', w: 0.33 },
    { rotulo: 'Telefone', valor: p?.telefone ?? '-', w: 0.33 },
  ]);
  y = campos(doc, y, [
    { rotulo: 'Nome / Nome Empresarial', valor: p?.nome ?? '-', w: 0.34, forte: true },
    { rotulo: 'Município / Código IBGE', valor: p?.endereco?.codigoMunicipio ?? '-', w: 0.33 },
    { rotulo: 'CEP', valor: cep(p?.endereco?.cep), w: 0.33 },
  ]);
  return campos(doc, y, [
    { rotulo: 'Endereço', valor: enderecoLinha(p?.endereco), w: 0.67 },
    { rotulo: 'E-mail', valor: p?.email ?? '-', w: 0.33, fonte: 6 },
  ]);
}

function blocoServico(doc, d, y) {
  y = titulo(doc, 'SERVIÇO PRESTADO', y);
  y = campos(doc, y, [
    { rotulo: 'Código de Tributação Nacional/Municipal', valor: `${formatarCodigo(d.servico.codigoTributacaoNacional)} / ${d.servico.codigoTributacaoMunicipal ?? '-'}`, w: 0.34 },
    { rotulo: 'Código da NBS', valor: d.servico.codigoNbs ?? '-', w: 0.33 },
    { rotulo: 'Local da Prestação', valor: d.servico.localPrestacao ?? '-', w: 0.33 },
  ]);

  // A descrição do código e a descrição do serviço são campos distintos: o
  // primeiro é o texto oficial do item da lista, o segundo é o que o
  // prestador escreveu.
  y = campos(doc, y, [{ rotulo: 'Descrição do código', valor: d.servico.descricaoCodigo ?? '-', w: 1, fonte: 6.5 }]);

  const alturaDesc = Math.max(24, doc.heightOfString(d.servico.descricao ?? '-', { width: LARGURA - 6 }) + 14);
  return campos(doc, y, [{ rotulo: 'Descrição do Serviço', valor: d.servico.descricao ?? '-', w: 1 }], { altura: alturaDesc });
}

function blocoIssqn(doc, d, y) {
  y = titulo(doc, 'TRIBUTAÇÃO MUNICIPAL (ISSQN)', y);
  y = campos(doc, y, [
    { rotulo: 'Tipo de Tributação do ISSQN', valor: TRIBUTACAO_ISSQN[d.issqn.tipoTributacao] ?? '-', w: 0.5 },
    { rotulo: 'Município de Incidência do ISSQN', valor: d.servico.localPrestacao ?? '-', w: 0.5 },
  ]);
  return campos(doc, y, [
    { rotulo: 'BC ISSQN', valor: dinheiro(d.issqn.base ?? d.totais.valorServico), w: 0.25 },
    { rotulo: 'Alíquota Aplicada', valor: percentual(d.issqn.aliquota), w: 0.25 },
    { rotulo: 'Retenção do ISSQN', valor: RETENCAO_ISSQN[d.issqn.tipoRetencao] ?? '-', w: 0.25 },
    { rotulo: 'ISSQN Apurado', valor: dinheiro(d.issqn.valor), w: 0.25, forte: true },
  ]);
}

function blocoFederal(doc, d, y) {
  y = titulo(doc, 'TRIBUTAÇÃO FEDERAL', y);
  y = campos(doc, y, [
    { rotulo: 'PIS - Débito Apuração Própria', valor: dinheiro(d.federal.valorPis), w: 0.25 },
    { rotulo: 'COFINS - Débito Apuração Própria', valor: dinheiro(d.federal.valorCofins), w: 0.25 },
    { rotulo: 'Alíquota PIS / COFINS', valor: `${percentual(d.federal.aliquotaPis)} / ${percentual(d.federal.aliquotaCofins)}`, w: 0.25 },
    { rotulo: 'CST PIS/COFINS', valor: d.federal.cst ?? '-', w: 0.25 },
  ]);
  return campos(doc, y, [
    { rotulo: 'Descrição Contrib. Sociais - Retidas', valor: RETENCAO_PIS_COFINS[d.federal.tipoRetencaoPisCofins] ?? '-', w: 1 },
  ]);
}

function blocoTotais(doc, d, y) {
  y = titulo(doc, 'VALOR TOTAL DA NFS-e', y);
  return campos(doc, y, [
    { rotulo: 'VALOR DA OPERAÇÃO / SERVIÇO', valor: dinheiro(d.totais.valorServico), w: 0.34, forte: true, fonte: 8 },
    { rotulo: 'Total das Retenções (ISSQN / Federais)', valor: dinheiro(d.totais.totalRetencoes), w: 0.33 },
    { rotulo: 'VALOR LÍQUIDO DA NFS-e', valor: dinheiro(d.totais.valorLiquido ?? d.totais.valorServico), w: 0.33, forte: true, fonte: 8 },
  ], { altura: 26 });
}

function blocoComplementares(doc, d, y) {
  y = titulo(doc, 'INFORMAÇÕES COMPLEMENTARES', y);
  const texto = d.informacoesComplementares ?? '-';
  const altura = Math.max(30, doc.heightOfString(texto, { width: LARGURA - 6 }) + 10);
  y = campos(doc, y, [{ rotulo: '', valor: texto, w: 1, fonte: 6.5 }], { altura });

  // Produção Restrita não tem efeito fiscal; quem imprime precisa ver isso.
  if (String(d.ambiente) === '2') {
    faixa(doc, 'AMBIENTE DE PRODUÇÃO RESTRITA — DOCUMENTO SEM VALOR FISCAL', y + 4, 14);
  }
}

function formatarCodigo(c) {
  if (!c) return '-';
  const s = String(c).padStart(6, '0');
  return `${s.slice(0, 2)}.${s.slice(2, 4)}.${s.slice(4, 6)}`;
}
