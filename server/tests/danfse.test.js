import { describe, it, expect } from 'vitest';
import { lerNfse } from '../services/nfse/danfse-dados.js';
import { gerarDanfse } from '../services/nfse/danfse.js';

// NFS-e no formato que a SEFIN devolve, com os valores conferidos contra uma
// nota real: R$ 1,00 → ISS 0,02 · PIS 0,01 · COFINS 0,03.
const NFSE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">
  <infNFSe Id="NFS31567002251675482000110000000000003026087376456690">
    <xLocEmi>Sabará - MG</xLocEmi>
    <xLocPrestacao>Sabará - MG</xLocPrestacao>
    <nNFSe>30</nNFSe>
    <xTribNac>Licenciamento ou cessão de direito de uso de programas de computação.</xTribNac>
    <verAplic>SefinNacional_1.6.0</verAplic>
    <ambGer>2</ambGer>
    <tpEmis>1</tpEmis>
    <cStat>100</cStat>
    <dhProc>2026-08-07T10:21:23-03:00</dhProc>
    <nDFSe>30</nDFSe>
    <emit>
      <CNPJ>51675482000110</CNPJ>
      <xNome>EMPRESA DE TESTE LTDA</xNome>
      <email>contato@example.com</email>
      <fone>3130000000</fone>
      <end><endNac><cMun>3156700</cMun><CEP>34710070</CEP></endNac>
        <xLgr>RUA DE TESTE</xLgr><nro>183</nro><xBairro>CENTRO</xBairro></end>
    </emit>
    <valores><vBC>1.00</vBC><vISSQN>0.02</vISSQN><vLiq>1.00</vLiq></valores>
    <xOutInf>Totais aproximados dos Tributos: Federais R$ 0,04</xOutInf>
    <DPS versao="1.01">
      <infDPS Id="DPS315670025167548200011000001000000000000003">
        <tpAmb>1</tpAmb>
        <dhEmi>2026-08-07T10:21:23-03:00</dhEmi>
        <serie>1</serie><nDPS>3</nDPS>
        <dCompet>2026-08-07</dCompet>
        <tpEmit>1</tpEmit><cLocEmi>3156700</cLocEmi>
        <prest><CNPJ>51675482000110</CNPJ>
          <regTrib><opSimpNac>1</opSimpNac><regEspTrib>0</regEspTrib></regTrib></prest>
        <toma><CNPJ>19131243000197</CNPJ><xNome>EMPRESA CLIENTE LTDA</xNome>
          <email>cliente@example.com</email></toma>
        <serv><locPrest><cLocPrestacao>3156700</cLocPrestacao></locPrest>
          <cServ><cTribNac>010501</cTribNac><xDescServ>Emissão de teste</xDescServ></cServ></serv>
        <valores><vServPrest><vServ>1.00</vServ></vServPrest>
          <trib>
            <tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN><pAliq>2.00</pAliq></tribMun>
            <tribFed><piscofins><CST>01</CST><vBCPisCofins>1.00</vBCPisCofins>
              <pAliqPis>0.65</pAliqPis><pAliqCofins>3.00</pAliqCofins>
              <vPis>0.01</vPis><vCofins>0.03</vCofins>
              <tpRetPisCofins>0</tpRetPisCofins></piscofins></tribFed>
            <totTrib><indTotTrib>0</indTotTrib></totTrib>
          </trib></valores>
      </infDPS>
    </DPS>
  </infNFSe>
</NFSe>`;

describe('lerNfse', () => {
  const d = lerNfse(NFSE_XML);

  it('extrai a chave do atributo Id, sem o prefixo NFS', () => {
    expect(d.chaveAcesso).toBe('31567002251675482000110000000000003026087376456690');
    expect(d.chaveAcesso).toHaveLength(50);
  });

  it('lê identificação da nota e da DPS', () => {
    expect(d.numeroNfse).toBe('30');
    expect(d.dps).toMatchObject({ numero: '3', serie: '1', competencia: '2026-08-07' });
    expect(d.situacao).toBe('100');
  });

  // CNPJ aparece em emit, prest e toma; pegar o do grupo errado trocaria as
  // partes da nota.
  it('não confunde o CNPJ do prestador com o do tomador', () => {
    expect(d.prestador.cnpj).toBe('51675482000110');
    expect(d.tomador.cnpj).toBe('19131243000197');
    expect(d.tomador.nome).toBe('EMPRESA CLIENTE LTDA');
  });

  it('lê a tributação com os valores da nota real', () => {
    expect(d.issqn).toMatchObject({ aliquota: '2.00', valor: '0.02', tipoRetencao: '1' });
    expect(d.federal).toMatchObject({ valorPis: '0.01', valorCofins: '0.03', cst: '01' });
    expect(d.totais.valorServico).toBe('1.00');
  });

  it('separa a descrição do código da descrição escrita pelo prestador', () => {
    expect(d.servico.descricaoCodigo).toMatch(/Licenciamento/);
    expect(d.servico.descricao).toBe('Emissão de teste');
  });

  it('recusa XML que não seja uma NFS-e', async () => {
    expect(() => lerNfse('<DPS><infDPS/></DPS>')).toThrow(/infNFSe/);
  });

  // Campos que a NT 008/2026 acrescentou ao layout obrigatório.
  it('lê o tipo de emitente e o regime do Simples Nacional', () => {
    expect(d.tipoEmitente).toBe('1');
    expect(d.prestador.optanteSimplesNacional).toBe('1');
  });

  // Destinatário e intermediário viram a faixa "NÃO IDENTIFICADO" no PDF; o
  // leitor precisa devolver null, e não um objeto de campos vazios, para que o
  // gerador distinga grupo ausente de grupo presente e sem dados.
  it('devolve null para destinatário e intermediário ausentes', () => {
    expect(d.destinatario).toBeNull();
    expect(d.intermediario).toBeNull();
  });

  it('reconhece o intermediário quando ele existe', () => {
    const com = NFSE_XML.replace(
      '<serv>',
      '<interm><CNPJ>19131243000197</CNPJ><xNome>INTERMEDIARIO LTDA</xNome></interm><serv>'
    );
    expect(lerNfse(com).intermediario).toMatchObject({ nome: 'INTERMEDIARIO LTDA' });
  });

  // O bloco IBS/CBS é impresso mesmo vazio: o layout da NT é fixo.
  it('devolve o grupo IBS/CBS vazio enquanto a reforma não vale', () => {
    expect(d.ibsCbs.valorTotalIbs).toBeNull();
    expect(d.totais.totalIbsCbs).toBeNull();
  });

  // A SEFIN pode aplicar alíquota diferente da pedida na DPS; o DANFSe mostra
  // a aplicada.
  it('prefere a alíquota aplicada devolvida pela SEFIN', () => {
    const comAplicada = NFSE_XML.replace('<vBC>1.00</vBC>', '<vBC>1.00</vBC><pAliqAplic>3.00</pAliqAplic>');
    expect(lerNfse(comAplicada).issqn.aliquotaAplicada).toBe('3.00');
    expect(d.issqn.aliquotaAplicada).toBe('2.00');
  });
});

describe('gerarDanfse', () => {
  it('produz um PDF válido', async () => {
    const pdf = await gerarDanfse(NFSE_XML);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.subarray(-6).toString('latin1')).toContain('EOF');
    expect(pdf.length).toBeGreaterThan(3000);
  });

  const contarPaginas = (pdf) => (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

  it('gera em uma página só', async () => {
    expect(contarPaginas(await gerarDanfse(NFSE_XML))).toBe(1);
  });

  // O layout da NT é de posição fixa: o canhoto fica a 28,10 cm do topo, e a
  // descrição do serviço aceita até 1300 caracteres. Se o texto empurrasse o
  // resto, o documento viraria duas páginas e o canhoto sairia do lugar — por
  // isso a NT manda cortar com reticências, e é isso que o gerador faz.
  it('mantém uma página com a descrição no tamanho máximo do leiaute', async () => {
    const longo = NFSE_XML.replace('Emissão de teste', 'Serviço prestado. '.repeat(72).slice(0, 1300));
    expect(contarPaginas(await gerarDanfse(longo))).toBe(1);
  });

  // Exigência da NT 008/2026. O estado vem de fora porque o cStat da NFS-e
  // nunca muda para cancelada — sem a marca, o PDF de uma nota cancelada seria
  // visualmente idêntico ao de uma válida.
  it('imprime marca d\'agua em nota cancelada', async () => {
    const normal = await gerarDanfse(NFSE_XML);
    const cancelada = await gerarDanfse(NFSE_XML, { cancelada: true });
    expect(cancelada.length).toBeGreaterThan(normal.length);
  });

  it('distingue cancelada de substituída', async () => {
    const a = await gerarDanfse(NFSE_XML, { cancelada: true });
    const b = await gerarDanfse(NFSE_XML, { substituida: true });
    expect(a.length).not.toBe(b.length);
  });

  // Produção Restrita não tem efeito fiscal; quem imprime precisa ver isso.
  it('marca o documento quando a nota é de produção restrita', async () => {
    const restrita = NFSE_XML.replace('<tpAmb>1</tpAmb>', '<tpAmb>2</tpAmb>');
    const pdf = await gerarDanfse(restrita);
    expect(pdf.length).toBeGreaterThan((await gerarDanfse(NFSE_XML)).length - 500);
  });
});
