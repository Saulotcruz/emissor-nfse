import { describe, it, expect } from 'vitest';
import { montarDps } from '../services/nfse/dps-builder.js';
import { montarIdDps, serieDeWebservice, chaveValida } from '../services/nfse/id-dps.js';
import { dataHoraUtc, dec, escapar } from '../services/nfse/xml.js';
import { EMITENTE_FIXTURE, SERVICO_FIXTURE } from './fixtures/emitente.js';
import { temXmllint, validarDps } from './helpers/xsd.js';

const TOMADOR = {
  documento: '19131243000197',
  razao_social: 'OPEN KNOWLEDGE BRASIL',
  inscricao_municipal: null,
  email: 'contato@example.com',
  telefone: '1123851939',
  logradouro: 'AV PAULISTA',
  numero: '37',
  complemento: 'ANDAR 4',
  bairro: 'BELA VISTA',
  cep: '01311902',
  codigo_municipio: '3550308',
  uf: 'SP',
};

const NOTA = {
  numeroDps: 1,
  serie: '1',
  competencia: '2026-08-05',
  dhEmi: new Date('2026-08-05T15:56:21Z'),
  valorServico: 148.83,
  descricaoServico: 'Plano Essential mensal',
};

function montar(overrides = {}) {
  return montarDps({
    emitente: { ...EMITENTE_FIXTURE, ...overrides.emitente },
    tomador: { ...TOMADOR, ...overrides.tomador },
    servico: { ...SERVICO_FIXTURE, ...overrides.servico },
    nota: { ...NOTA, ...overrides.nota },
  });
}

describe('montarIdDps', () => {
  it('segue a regra do XSD: DPS + município(7) + tipo(1) + inscrição(14) + série(5) + número(15)', () => {
    const id = montarIdDps({
      codigoMunicipio: '3106200',
      documento: '11222333000181',
      serie: '1',
      numeroDps: 1,
    });
    expect(id).toBe('DPS3106200211222333000181' + '00001' + '000000000000001');
    expect(id).toHaveLength(45);
    expect(id).toMatch(/^DPS[0-9]{42}$/);
  });

  it('usa tipo 1 para CPF, completando a inscrição federal com zeros', () => {
    const id = montarIdDps({
      codigoMunicipio: '3106200',
      documento: '52998224725',
      serie: '1',
      numeroDps: 7,
    });
    expect(id.slice(10, 11)).toBe('1');
    expect(id.slice(11, 25)).toBe('00052998224725');
  });

  it('rejeita município fora do padrão IBGE e número inválido', () => {
    expect(() => montarIdDps({ codigoMunicipio: '31062', documento: '11222333000181', serie: 1, numeroDps: 1 }))
      .toThrow(/7 dígitos/);
    expect(() => montarIdDps({ codigoMunicipio: '3106200', documento: '11222333000181', serie: 1, numeroDps: 0 }))
      .toThrow(/inteiro positivo/);
  });
});

describe('faixas de série', () => {
  it('reconhece 1-49999 como webservice e rejeita a faixa do Portal Nacional', () => {
    expect(serieDeWebservice('1')).toBe(true);
    expect(serieDeWebservice(49999)).toBe(true);
    // 70000 é a faixa do Emissor Nacional — foi a série da nota emitida manualmente.
    expect(serieDeWebservice(70000)).toBe(false);
  });
});

describe('helpers de XML', () => {
  it('escapa caracteres que quebrariam o XML', () => {
    expect(escapar('A & B <c> "d"')).toBe('A &amp; B &lt;c&gt; &quot;d&quot;');
  });

  it('formata decimal com ponto e 2 casas, como o XSD exige', () => {
    expect(dec(148.83)).toBe('148.83');
    expect(dec(2)).toBe('2.00');
    expect(dec(0)).toBe('0.00');
  });

  it('gera dhEmi com offset explícito — toISOString() usa Z e o XSD rejeita', () => {
    const s = dataHoraUtc(new Date('2026-08-05T15:56:21Z'));
    expect(s).toBe('2026-08-05T12:56:21-03:00');
    expect(s).not.toMatch(/Z$/);
  });
});

describe('montarDps', () => {
  it('produz XML com a raiz, versão e Id corretos', () => {
    const { xml, id } = montar();
    expect(xml).toContain('<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">');
    expect(xml).toContain(`<infDPS Id="${id}">`);
    expect(id).toMatch(/^DPS[0-9]{42}$/);
  });

  it('respeita a ordem de TCInfDPS — <xs:sequence> não admite troca', () => {
    const { xml } = montar();
    const ordem = ['tpAmb', 'dhEmi', 'verAplic', 'serie', 'nDPS', 'dCompet', 'tpEmit', 'cLocEmi', 'prest', 'toma', 'serv', 'valores'];
    const posicoes = ordem.map((t) => xml.indexOf(`<${t}>`));
    expect(posicoes.every((p) => p > -1)).toBe(true);
    expect([...posicoes].sort((a, b) => a - b)).toEqual(posicoes);
  });

  it('marca ambiente 2 em produção restrita e 1 em produção', () => {
    expect(montar().xml).toContain('<tpAmb>2</tpAmb>');
    expect(montar({ nota: { ambiente: 'producao' } }).xml).toContain('<tpAmb>1</tpAmb>');
  });

  it('leva os tributos apurados, conferidos contra a nota real', () => {
    const { xml, tributos } = montar();
    expect(xml).toContain('<vServ>148.83</vServ>');
    expect(xml).toContain('<pAliq>2.00</pAliq>');
    expect(xml).toContain('<vPis>0.97</vPis>');
    expect(xml).toContain('<vCofins>4.46</vCofins>');
    expect(tributos.valorIss).toBe(2.98);
  });

  it('usa CST 01 e tpRetPisCofins 0 para operação tributável sem retenção', () => {
    const { xml } = montar();
    expect(xml).toContain('<CST>01</CST>');
    expect(xml).toContain('<tpRetPisCofins>0</tpRetPisCofins>');
    expect(xml).toContain('<tpRetISSQN>1</tpRetISSQN>');
    expect(xml).toContain('<tribISSQN>1</tribISSQN>');
  });

  it('marca ISS retido quando o serviço assim exige', () => {
    const { xml } = montar({ servico: { iss_retido: 1 } });
    expect(xml).toContain('<tpRetISSQN>2</tpRetISSQN>');
  });

  it('omite o grupo de endereço quando está incompleto, em vez de mandar pela metade', () => {
    const { xml } = montar({ tomador: { cep: null } });
    const toma = xml.slice(xml.indexOf('<toma>'), xml.indexOf('</toma>'));
    expect(toma).not.toContain('<end>');
    expect(toma).toContain('<xNome>OPEN KNOWLEDGE BRASIL</xNome>');
  });

  // Rejeição E0121 da SEFIN: com tpEmit=1 o nome do prestador não pode ir no XML.
  it('omite o nome do prestador, que a SEFIN preenche a partir do cadastro', () => {
    const { xml } = montar();
    const prest = xml.slice(xml.indexOf('<prest>'), xml.indexOf('</prest>'));
    expect(prest).not.toContain('<xNome>');
    expect(prest).toContain('<CNPJ>11222333000181</CNPJ>');
    // O tomador continua levando o nome — a regra vale só para o prestador.
    const toma = xml.slice(xml.indexOf('<toma>'), xml.indexOf('</toma>'));
    expect(toma).toContain('<xNome>OPEN KNOWLEDGE BRASIL</xNome>');
  });

  it('escapa a descrição do serviço', () => {
    const { xml } = montar({ nota: { descricaoServico: 'Plano "A" & cia <teste>' } });
    expect(xml).toContain('<xDescServ>Plano &quot;A&quot; &amp; cia &lt;teste&gt;</xDescServ>');
  });

  it('rejeita entradas incompletas com mensagem específica', () => {
    expect(() => montar({ tomador: { razao_social: null } })).toThrow(/razão social/i);
    expect(() => montar({ nota: { descricaoServico: null } })).toThrow(/descrição/i);
    expect(() => montar({ servico: { codigo_tributacao_nacional: '0105' } })).toThrow(/6 dígitos/);
  });
});

describe('chaveValida', () => {
  it('exige 50 dígitos, como TSChaveNFSe', () => {
    expect(chaveValida('3'.repeat(50))).toBe(true);
    expect(chaveValida('3'.repeat(49))).toBe(false);
    expect(chaveValida(null)).toBe(false);
  });
});

// O teste que realmente importa nesta fase: o XML tem que passar no XSD oficial.
describe.runIf(temXmllint())('validação contra o XSD oficial', () => {
  it('a DPS gerada valida contra DPS_v1.01.xsd', () => {
    const { valido, erros } = validarDps(montar().xml);
    expect(erros).toBe('');
    expect(valido).toBe(true);
  });

  it('valida também com tomador CPF e sem endereço', () => {
    const { valido, erros } = validarDps(
      montar({ tomador: { documento: '52998224725', cep: null, codigo_municipio: null } }).xml
    );
    expect(erros).toBe('');
    expect(valido).toBe(true);
  });

  it('valida com deduções e retenções federais', () => {
    const { valido, erros } = validarDps(
      montar({
        nota: { deducoes: 20 },
        servico: { ret_csll: 1, ret_ir: 1.5, ret_inss: 2 },
      }).xml
    );
    expect(erros).toBe('');
    expect(valido).toBe(true);
  });
});
