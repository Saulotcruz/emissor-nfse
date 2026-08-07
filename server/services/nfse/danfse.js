import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import {
  lerNfse,
  TRIBUTACAO_ISSQN,
  RETENCAO_ISSQN,
  RETENCAO_PIS_COFINS,
  SITUACAO,
  TIPO_EMITENTE,
  OPTANTE_SIMPLES,
  REGIME_APURACAO_SN,
} from './danfse-dados.js';

/**
 * Geração do DANFSe em PDF, no layout da NT SE/CGNFSE 008/2026 v1.02.
 *
 * A API oficial que gerava este PDF foi **desligada em 1º de julho de 2026**:
 * a responsabilidade passou para os sistemas emissores, e o layout da NT virou
 * padrão nacional obrigatório (prazo de adaptação em 03/08/2026). Um ERP que
 * importe o documento espera exatamente estes campos, nesta ordem.
 *
 * A geometria abaixo é a tabela "Posição c/ relação à margem" do anexo da NT,
 * em centímetros: cada campo tem altura, largura, distância da esquerda e do
 * topo. Daí a grade de quatro colunas e as alturas de linha fixas — não são
 * escolha de estilo, são o anexo.
 *
 * Outras exigências que o layout observa:
 *  - fontes Arial ou MS Sans Serif, mínimo 7pt
 *  - QR Code de 1,52 cm × 1,52 cm, no canto superior direito
 *  - paridade XML–PDF: só aparece o que está no XML
 *  - descrições das opções de leiaute por extenso, nunca o número do código
 *  - texto que estoura o campo é cortado com reticências
 *  - documento cancelado ou substituído leva marca d'água diagonal
 *
 * Sobre a fonte: o PDF usa Helvetica, que é a métrica equivalente de Arial e
 * está embutida em todo leitor de PDF. Embutir a Arial exigiria distribuir o
 * arquivo da fonte, que é licenciado.
 */

const CM = 28.3465; // 1 cm em pontos PostScript
const cm = (v) => v * CM;

/* ----------------------------------------------------------------- geometria */

const MARGEM = cm(0.3);
const LARGURA = cm(20.4);

/** Colunas da grade, em cm a partir da borda esquerda da página. */
const COLUNA = [cm(0.3), cm(5.41), cm(10.51), cm(15.62)];
/** Larguras válidas: uma, duas ou quatro colunas. */
const LARG = { 1: cm(5.09), 2: cm(10.19), 4: cm(20.4) };

const ALT_CABECALHO = cm(1.16);
const ALT_LINHA = cm(0.63); // blocos de pessoa e tributação
const ALT_LINHA_DADOS = cm(0.67); // bloco de dados da NFS-e e totais
const ALT_CHAVE = cm(0.77);
const LARG_CHAVE = cm(15.3);
const QR_LADO = cm(1.52);
const QR_X = cm(17.48);
const QR_Y = cm(1.67);
const COMPL_QR = { x: cm(15.8), y: cm(3.36), largura: cm(4.72), altura: cm(0.68) };
const CANHOTO_Y = cm(28.1);
const ALT_CANHOTO = cm(0.67);

/* -------------------------------------------------------------------- estilo */

const CINZA = '#eeeeee';
const LINHA = '#000000';
const TINTA = '#000000';

const FONTE_TITULO_BLOCO = 9;
const FONTE_ROTULO = 7; // mínimo permitido pela NT
const FONTE_VALOR = 8.5;

export const URL_CONSULTA = process.env.NFSE_URL_CONSULTA || 'https://www.nfse.gov.br/consultapublica';

/* ----------------------------------------------------------------- formatação */

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

/** Máscara nn.nnn.nnn/nnnn-nn (CNPJ) ou nnn.nnn.nnn-nn (CPF), conforme a NT. */
const documento = (p) => {
  if (!p) return '-';
  if (p.cnpj) return p.cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  if (p.cpf) return p.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (p.nif) return p.nif;
  return '-';
};

const cep = (v) => (v ? String(v).replace(/(\d{5})(\d{3})/, '$1-$2') : null);

/** "CÓDIGO IBGE / CEP" — a NT manda concatenar os dois campos. */
function ibgeCep(e) {
  const partes = [e?.codigoMunicipio ?? null, cep(e?.cep)];
  return partes.every((p) => !p) ? '-' : partes.map((p) => p ?? '-').join(' / ');
}

function enderecoLinha(e) {
  if (!e) return '-';
  return [e.logradouro, e.numero, e.complemento, e.bairro].filter(Boolean).join(', ') || '-';
}

const texto = (v) => (v === null || v === undefined || v === '' ? '-' : String(v));

/** Descrição da opção do leiaute; nunca o número. */
const opcao = (tabela, codigo) =>
  codigo === null || codigo === undefined || codigo === '' ? '-' : (tabela[codigo] ?? String(codigo));

/** Código de tributação nacional no formato nn.nn.nn. */
function codigoTributacao(c) {
  if (!c) return '-';
  const s = String(c).padStart(6, '0');
  return `${s.slice(0, 2)}.${s.slice(2, 4)}.${s.slice(4, 6)}`;
}

/* ------------------------------------------------------------------- entrada */

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

  const doc = new PDFDocument({
    size: 'A4',
    margin: 0, // a grade da NT posiciona tudo em coordenadas absolutas
    info: {
      Title: `DANFSe ${d.numeroNfse ?? ''}`,
      Author: d.prestador?.nome ?? 'NFS-e',
    },
  });

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
  const rotulo = cancelada ? 'CANCELADA' : substituida ? 'SUBSTITUÍDA' : null;
  if (!rotulo) return;

  doc.save();
  doc.rotate(-45, { origin: [297, 421] });
  doc.font('Helvetica-Bold').fontSize(64).fillColor('#c0392b').opacity(0.28)
    .text(rotulo, 0, 400, { width: 595, align: 'center' });
  doc.restore();
}

/* ---------------------------------------------------------------- primitivas */

/**
 * Maior corpo de fonte, a partir de `ideal`, em que o texto cabe numa linha só.
 *
 * As larguras de coluna são fixas pela NT, e vários rótulos do próprio anexo
 * não cabem em 7pt — "Base de Cálculo Após Exclusões e Reduções" numa coluna de
 * 5,09 cm, por exemplo. Quebrar em duas linhas comeria o espaço do valor, então
 * o rótulo encolhe. O piso de 6pt vale só para rótulos: os **valores** ficam
 * sempre nos 8,5pt, acima do mínimo de 7pt que a NT exige para o conteúdo.
 */
function corpoQueCabe(doc, conteudo, largura, ideal, minimo) {
  // A folga de 2pt evita o caso em que o texto mede um décimo de ponto menos
  // que a caixa e o pdfkit quebra a linha mesmo assim.
  const limite = largura - 2;
  let tamanho = ideal;
  while (tamanho > minimo && doc.fontSize(tamanho).widthOfString(conteudo) > limite) {
    tamanho -= 0.25;
  }
  return tamanho;
}

/**
 * Uma célula da grade: rótulo em negrito no topo, valor abaixo.
 *
 * `col` é o índice da coluna (0 a 3) e `cols` quantas ela ocupa. O texto que
 * não couber é cortado com reticências, como a NT determina.
 */
function celula(doc, { col = 0, cols = 1, y, altura = ALT_LINHA, rotulo, valor, fundo, titulo, largura: larguraFixa }) {
  const x = COLUNA[col];
  const largura = larguraFixa ?? LARG[cols];

  if (fundo || titulo) {
    doc.rect(x, y, largura, altura).fillColor(CINZA).fill();
    doc.rect(x, y, largura, altura).strokeColor(LINHA).lineWidth(0.5).stroke();
  }

  if (titulo) {
    doc.fillColor(TINTA).font('Helvetica-Bold');
    const corpo = corpoQueCabe(doc, rotulo, largura - 8, FONTE_TITULO_BLOCO, 7);
    doc.fontSize(corpo)
      .text(rotulo, x + 4, y + (altura - corpo) / 2 - 0.5, { width: largura - 8, lineBreak: false });
    return;
  }

  if (rotulo) {
    doc.fillColor(TINTA).font('Helvetica-Bold');
    doc.fontSize(corpoQueCabe(doc, rotulo, largura - 8, FONTE_ROTULO, 6))
      .text(rotulo, x + 4, y + 1.5, { width: largura - 8, lineBreak: false });
  }
  doc.fillColor(TINTA).font('Helvetica').fontSize(FONTE_VALOR)
    .text(texto(valor), x + 4, y + (rotulo ? 10 : 3), {
      width: largura - 8,
      height: altura - (rotulo ? 11 : 4),
      ellipsis: true,
    });
}

/** Linha horizontal de largura total, separando blocos. */
function separador(doc, y) {
  doc.moveTo(MARGEM, y).lineTo(MARGEM + LARGURA, y).strokeColor(LINHA).lineWidth(0.5).stroke();
}

/** Uma linha inteira de células; devolve o y da linha seguinte. */
function linha(doc, y, celulas, altura = ALT_LINHA) {
  for (const c of celulas) celula(doc, { ...c, y, altura: c.altura ?? altura });
  return y + altura;
}

/**
 * Faixa centralizada que substitui um bloco ausente.
 *
 * A NT prevê isso para destinatário e intermediário: quando o grupo não existe
 * no XML, imprime-se "NÃO IDENTIFICADO NA NFS-e" — não um bloco de traços, que
 * sugeriria um dado faltando em vez de um grupo que não se aplica.
 */
function faixaAusente(doc, rotulo, y) {
  const altura = cm(0.4);
  doc.fillColor(TINTA).font('Helvetica').fontSize(FONTE_VALOR)
    .text(`${rotulo} NÃO IDENTIFICADO NA NFS-e`, MARGEM, y + 2, { width: LARGURA, align: 'center' });
  separador(doc, y + altura);
  return y + altura;
}

/* -------------------------------------------------------------------- blocos */

function desenhar(doc, d, qr) {
  // Moldura externa do documento, do topo até o pé do canhoto.
  doc.rect(MARGEM, MARGEM, LARGURA, CANHOTO_Y + ALT_CANHOTO - MARGEM)
    .strokeColor(LINHA).lineWidth(0.8).stroke();

  cabecalho(doc, d);
  let y = blocoDados(doc, d, qr);

  y = blocoPrestador(doc, d, y);
  y = blocoTomador(doc, d, y);

  y = d.destinatario
    ? blocoSimples(doc, 'DESTINATÁRIO DA OPERAÇÃO', d.destinatario, y)
    : faixaAusente(doc, 'DESTINATÁRIO DA OPERAÇÃO', y);
  y = d.intermediario
    ? blocoSimples(doc, 'INTERMEDIÁRIO DA OPERAÇÃO', d.intermediario, y)
    : faixaAusente(doc, 'INTERMEDIÁRIO DA OPERAÇÃO', y);

  y = blocoServico(doc, d, y);
  y = blocoIssqn(doc, d, y);
  y = blocoFederal(doc, d, y);
  y = blocoIbsCbs(doc, d, y);
  y = blocoTotais(doc, d, y);
  blocoComplementares(doc, d, y);

  canhoto(doc, d);
}

/** Faixa superior: logomarca, título centralizado e identificação do município. */
function cabecalho(doc, d) {
  const y = MARGEM;
  doc.rect(MARGEM, y, LARGURA, ALT_CABECALHO).fillColor('#f7f7f7').fill();
  doc.rect(MARGEM, y, LARGURA, ALT_CABECALHO).strokeColor(LINHA).lineWidth(0.5).stroke();

  // Logomarca da NFS-e — 0,85 × 4,00 cm em 0,49 / 0,44.
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#0b8043')
    .text('NFS', cm(0.49), cm(0.5), { continued: true })
    .fillColor('#1a73e8').text('e');
  doc.font('Helvetica').fontSize(5.5).fillColor('#555')
    .text('Nota Fiscal de\nServiço eletrônica', cm(0.49) + 52, cm(0.55), { width: cm(2.4) });

  // Quadro da descrição, centralizado no espaço de 10,19 cm a partir de 5,41.
  doc.fillColor(TINTA).font('Helvetica-Bold').fontSize(11)
    .text('DANFSe v2.0', COLUNA[1], y + 6, { width: LARG[2], align: 'center' });
  doc.font('Helvetica-Bold').fontSize(10)
    .text('Documento Auxiliar da NFS-e', COLUNA[1], y + 19, { width: LARG[2], align: 'center' });

  // Quadro da identificação do município e do ambiente, à direita.
  // O município não é exibido quando o código de tributação nacional é 99.
  const municipio = String(d.servico?.codigoTributacaoNacional ?? '').startsWith('99')
    ? ''
    : `Município: ${texto(d.localEmissao)}`;
  doc.font('Helvetica').fontSize(9).fillColor(TINTA)
    .text(municipio, COLUNA[3], y + 4, { width: LARG[1], lineBreak: false, ellipsis: true });
  doc.fontSize(6.5)
    .text(`Ambiente Gerador: ${texto(d.ambienteGerador)}`, COLUNA[3], cm(0.9), { width: LARG[1] })
    .text(`Tipo de Ambiente: ${texto(d.ambiente)}`, COLUNA[3], cm(1.13), { width: LARG[1] });
}

/** Bloco "DADOS DA NFS-e": chave de acesso, numeração, datas e QR Code. */
function blocoDados(doc, d, qr) {
  const inicio = cm(1.48);
  separador(doc, inicio);

  // A chave ocupa uma faixa de 15,30 cm — mais larga que a grade de colunas,
  // para não colidir com o QR Code que fica à direita dela.
  celula(doc, {
    col: 0, y: inicio, altura: ALT_CHAVE, largura: LARG_CHAVE,
    rotulo: 'CHAVE DE ACESSO DA NFS-e',
    valor: d.chaveAcesso,
  });

  let y = inicio + ALT_CHAVE;
  y = linha(doc, y, [
    { col: 0, rotulo: 'NÚMERO DA NFS-e', valor: d.numeroNfse },
    { col: 1, rotulo: 'COMPETÊNCIA DA NFS-e', valor: dataBr(d.dps.competencia) },
    { col: 2, rotulo: 'DATA E HORA DA EMISSÃO DA NFS-e', valor: dataHoraBr(d.dataHoraProcessamento) },
  ], ALT_LINHA_DADOS);
  y = linha(doc, y, [
    { col: 0, rotulo: 'NÚMERO DA DPS', valor: d.dps.numero },
    { col: 1, rotulo: 'SÉRIE DA DPS', valor: d.dps.serie },
    { col: 2, rotulo: 'DATA E HORA DA EMISSÃO DA DPS', valor: dataHoraBr(d.dps.dataHoraEmissao) },
  ], ALT_LINHA_DADOS);
  y = linha(doc, y, [
    { col: 0, rotulo: 'EMITENTE DA NFS-e', valor: opcao(TIPO_EMITENTE, d.tipoEmitente), fundo: true },
    { col: 1, rotulo: 'SITUAÇÃO DA NFS-e', valor: opcao(SITUACAO, d.situacao) },
    { col: 2, rotulo: 'FINALIDADE', valor: d.finalidade },
  ], ALT_LINHA_DADOS);

  // QR Code de 1,52 cm exatos, na posição fixada pela NT.
  doc.image(qr, QR_X, QR_Y, { width: QR_LADO, height: QR_LADO });
  doc.font('Helvetica').fontSize(5.8).fillColor(TINTA)
    .text(
      'A autenticidade desta NFS-e pode ser verificada pela leitura deste código QR ou pela consulta da chave de acesso no portal nacional da NFS-e',
      COMPL_QR.x, COMPL_QR.y,
      { width: COMPL_QR.largura, height: COMPL_QR.altura + 6, ellipsis: true }
    );

  separador(doc, y);
  return y;
}

/** Prestador tem duas linhas a mais que os demais: regime do Simples Nacional. */
function blocoPrestador(doc, d, y) {
  const p = d.prestador;
  y = linhasDePessoa(doc, 'PRESTADOR / FORNECEDOR', p, y, { municipio: d.localEmissao });
  y = linha(doc, y, [
    { col: 0, rotulo: 'Simples Nacional na Data de Competência', valor: opcao(OPTANTE_SIMPLES, p?.optanteSimplesNacional) },
    { col: 2, cols: 2, rotulo: 'Regime de Apuração Tributária pelo SN', valor: opcao(REGIME_APURACAO_SN, p?.regimeApuracaoSN) },
  ]);
  separador(doc, y);
  return y;
}

function blocoTomador(doc, d, y) {
  y = linhasDePessoa(doc, 'TOMADOR / ADQUIRENTE', d.tomador, y);
  separador(doc, y);
  return y;
}

function blocoSimples(doc, rotulo, p, y) {
  y = linhasDePessoa(doc, rotulo, p, y);
  separador(doc, y);
  return y;
}

/**
 * As três linhas comuns a prestador, tomador, destinatário e intermediário.
 *
 * `municipio` vem de fora porque o XML só traz o código IBGE de 7 dígitos, e a
 * NT manda imprimir o nome concatenado com a UF. Para o prestador a própria
 * NFS-e traz o texto pronto em `xLocEmi`; para os demais não temos a tabela do
 * IBGE, então o campo sai como traço em vez de um código que ninguém lê.
 */
function linhasDePessoa(doc, rotulo, p, y, { municipio } = {}) {
  y = linha(doc, y, [
    { col: 0, rotulo, titulo: true },
    { col: 1, rotulo: 'CNPJ / CPF / NIF', valor: documento(p) },
    { col: 2, rotulo: 'Indicador Municipal (Inscrição)', valor: p?.inscricaoMunicipal },
    { col: 3, rotulo: 'Telefone', valor: p?.telefone },
  ]);
  y = linha(doc, y, [
    { col: 0, cols: 2, rotulo: 'Nome / Nome Empresarial', valor: p?.nome },
    { col: 2, rotulo: 'Município / Sigla UF', valor: municipio },
    { col: 3, rotulo: 'Código IBGE / CEP', valor: ibgeCep(p?.endereco) },
  ]);
  return linha(doc, y, [
    { col: 0, cols: 2, rotulo: 'Endereço', valor: enderecoLinha(p?.endereco) },
    { col: 2, cols: 2, rotulo: 'E-mail', valor: p?.email },
  ]);
}

function blocoServico(doc, d, y) {
  const s = d.servico;
  y = linha(doc, y, [
    { col: 0, rotulo: 'SERVIÇO PRESTADO', titulo: true },
    {
      col: 1,
      rotulo: 'Código de Tributação Nacional/Municipal',
      valor: `${codigoTributacao(s.codigoTributacaoNacional)} / ${texto(s.codigoTributacaoMunicipal)}`,
    },
    { col: 2, rotulo: 'Código da NBS', valor: s.codigoNbs },
    { col: 3, rotulo: 'Local da Prestação / Sigla UF / País', valor: s.localPrestacao },
  ]);

  // A descrição do código e a descrição do serviço são campos distintos: o
  // primeiro é o texto oficial do item da lista, o segundo é o que o
  // prestador escreveu.
  y = linha(doc, y, [{ col: 0, cols: 4, valor: s.descricaoCodigo }], cm(0.38));
  y = linha(doc, y, [{ col: 0, cols: 4, rotulo: 'Descrição do Serviço', valor: s.descricao }], cm(0.63));

  separador(doc, y);
  return y;
}

function blocoIssqn(doc, d, y) {
  const i = d.issqn;
  y = linha(doc, y, [
    { col: 0, rotulo: 'TRIBUTAÇÃO MUNICIPAL (ISSQN)', titulo: true },
    { col: 1, rotulo: 'Tipo de Tributação do ISSQN', valor: opcao(TRIBUTACAO_ISSQN, i.tipoTributacao) },
    { col: 2, cols: 2, rotulo: 'Município / Sigla UF / País de Incidência do ISSQN', valor: d.localIncidencia },
  ]);
  y = linha(doc, y, [
    { col: 0, rotulo: 'BC ISSQN', valor: dinheiro(i.base) },
    { col: 1, rotulo: 'Alíquota Aplicada', valor: percentual(i.aliquotaAplicada) },
    { col: 2, rotulo: 'Retenção do ISSQN', valor: opcao(RETENCAO_ISSQN, i.tipoRetencao) },
    { col: 3, rotulo: 'ISSQN Apurado', valor: dinheiro(i.valor) },
  ]);
  separador(doc, y);
  return y;
}

function blocoFederal(doc, d, y) {
  const f = d.federal;
  y = linha(doc, y, [
    { col: 0, rotulo: 'TRIBUTAÇÃO FEDERAL (EXCETO CBS)', titulo: true },
    { col: 1, rotulo: 'IRRF', valor: f.irrf ? dinheiro(f.irrf) : '-' },
    { col: 2, rotulo: 'Contribuição Previdenciária - Retida', valor: f.previdenciaria ? dinheiro(f.previdenciaria) : '-' },
    { col: 3, rotulo: 'Contribuições Sociais - Retidas', valor: f.contribuicoesSociais ? dinheiro(f.contribuicoesSociais) : '-' },
  ]);
  y = linha(doc, y, [
    { col: 0, rotulo: 'PIS - Débito Apuração Própria', valor: dinheiro(f.valorPis) },
    { col: 1, rotulo: 'COFINS - Débito Apuração Própria', valor: dinheiro(f.valorCofins) },
    { col: 2, cols: 2, rotulo: 'Descrição Contrib. Sociais - Retidas', valor: opcao(RETENCAO_PIS_COFINS, f.tipoRetencaoPisCofins) },
  ]);
  separador(doc, y);
  return y;
}

/**
 * Bloco da reforma tributária.
 *
 * Hoje sai todo com traços — o grupo IBSCBS ainda não é preenchido. Mesmo
 * assim ele precisa ser impresso: o layout da NT é fixo, e um ERP que leia o
 * documento espera as células nesta posição.
 */
function blocoIbsCbs(doc, d, y) {
  const b = d.ibsCbs;
  const par = (a, c) => `${texto(a)} / ${texto(c)}`;

  y = linha(doc, y, [
    { col: 0, rotulo: 'TRIBUTAÇÃO IBS/CBS', titulo: true },
    { col: 1, rotulo: 'CST / cClassTrib', valor: par(b.cst, b.classificacao) },
    {
      col: 2, cols: 2,
      rotulo: 'Indicador de Operação / Código IBGE Incidência / Município Incidência / Sigla UF',
      valor: '- / - / - / -',
    },
  ]);
  y = linha(doc, y, [
    { col: 0, rotulo: 'Exclusões e Reduções da Base de Cálculo', valor: b.exclusoesReducoes ? dinheiro(b.exclusoesReducoes) : '-' },
    { col: 1, rotulo: 'Base de Cálculo Após Exclusões e Reduções', valor: b.base ? dinheiro(b.base) : '-' },
    { col: 2, rotulo: 'Red. Alíquota IBS / Red. Alíquota CBS', valor: '- / -' },
    { col: 3, rotulo: 'Alíquota - IBS UF / IBS Mun', valor: par(b.aliquotaIbsUf, b.aliquotaIbsMun) },
  ]);
  y = linha(doc, y, [
    { col: 0, rotulo: 'Alíq. Efetiva Municipal - IBS', valor: b.aliquotaEfetivaMun },
    { col: 1, rotulo: 'Valor Apurado Municipal - IBS', valor: b.valorMunicipal ? dinheiro(b.valorMunicipal) : '-' },
    { col: 2, rotulo: 'Alíq. Efetiva Estadual - IBS', valor: b.aliquotaEfetivaUf },
    { col: 3, rotulo: 'Valor Apurado Estadual - IBS', valor: b.valorEstadual ? dinheiro(b.valorEstadual) : '-' },
  ]);
  y = linha(doc, y, [
    { col: 0, rotulo: 'Valor Total Apurado - IBS', valor: b.valorTotalIbs ? dinheiro(b.valorTotalIbs) : '-' },
    { col: 1, rotulo: 'Alíquota - CBS', valor: b.aliquotaCbs },
    { col: 2, rotulo: 'Alíquota Efetiva - CBS', valor: b.aliquotaEfetivaCbs },
    { col: 3, rotulo: 'Valor Total Apurado - CBS', valor: b.valorTotalCbs ? dinheiro(b.valorTotalCbs) : '-' },
  ]);
  separador(doc, y);
  return y;
}

function blocoTotais(doc, d, y) {
  const t = d.totais;
  y = linha(doc, y, [
    { col: 0, rotulo: 'VALOR TOTAL DA NFS-e', titulo: true },
    { col: 1, rotulo: 'VALOR DA OPERAÇÃO / SERVIÇO', valor: dinheiro(t.valorServico) },
    { col: 2, rotulo: 'Desconto Incondicionado', valor: t.descontoIncondicionado ? dinheiro(t.descontoIncondicionado) : '-' },
    { col: 3, rotulo: 'Desconto Condicionado', valor: t.descontoCondicionado ? dinheiro(t.descontoCondicionado) : '-' },
  ], ALT_LINHA_DADOS);
  y = linha(doc, y, [
    { col: 0, rotulo: 'Total das Retenções (ISSQN / Federais)', valor: t.totalRetencoes ? dinheiro(t.totalRetencoes) : '-' },
    { col: 1, rotulo: 'VALOR LÍQUIDO DA NFS-e', valor: dinheiro(t.valorLiquido ?? t.valorServico) },
    { col: 2, rotulo: 'Total do IBS/CBS', valor: dinheiro(t.totalIbsCbs ?? 0) },
    { col: 3, rotulo: 'VALOR LÍQUIDO DA NFS-e + IBS/CBS', valor: dinheiro(t.valorLiquidoComIbsCbs ?? 0), fundo: true },
  ], ALT_LINHA_DADOS);
  separador(doc, y);
  return y;
}

/**
 * Informações complementares. Ocupa tudo que sobra até o canhoto — é o único
 * bloco elástico do layout, e é onde a NT manda concatenar, nesta ordem, as
 * informações do contribuinte, do fisco e os totais aproximados de tributos.
 */
function blocoComplementares(doc, d, y) {
  doc.fillColor(TINTA).font('Helvetica-Bold').fontSize(FONTE_TITULO_BLOCO)
    .text('INFORMAÇÕES COMPLEMENTARES', MARGEM + 4, y + 3, { width: LARGURA - 8 });

  const topo = y + cm(0.55);
  doc.font('Helvetica').fontSize(FONTE_VALOR)
    .text(texto(d.informacoesComplementares), MARGEM + 4, topo, {
      width: LARGURA - 8,
      height: CANHOTO_Y - topo - 4,
      ellipsis: true,
    });

  // Produção Restrita não tem efeito fiscal; quem imprime precisa ver isso.
  if (String(d.ambiente) === '2') {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#b45309')
      .text('AMBIENTE DE PRODUÇÃO RESTRITA — DOCUMENTO SEM VALOR FISCAL',
        MARGEM, CANHOTO_Y - cm(1), { width: LARGURA, align: 'center' });
  }
}

/** Canhoto de recebimento, em posição fixa a 28,10 cm do topo. */
function canhoto(doc, d) {
  separador(doc, CANHOTO_Y);
  // Divisórias verticais entre as três células do canhoto.
  for (const x of [COLUNA[1], COLUNA[2]]) {
    doc.moveTo(x, CANHOTO_Y).lineTo(x, CANHOTO_Y + ALT_CANHOTO).strokeColor(LINHA).lineWidth(0.5).stroke();
  }

  linha(doc, CANHOTO_Y, [
    { col: 0, rotulo: 'DATA CIENTIFICAÇÃO:', valor: '' },
    { col: 1, rotulo: 'IDENTIFICAÇÃO E ASSINATURA', valor: '' },
    { col: 2, cols: 2, rotulo: 'Nº NFS-e / CHAVE NFS-e', valor: `${texto(d.numeroNfse)} / ${texto(d.chaveAcesso)}` },
  ], ALT_CANHOTO);
}
