import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { montarCancelamento, montarIdPedidoEvento, EVENTOS, MOTIVO_CANCELAMENTO } from '../services/nfse/evento-builder.js';
import { assinarPedidoEvento, verificarAssinatura, lerCertificado } from '../services/nfse/signer.js';
import { gerarPfxDeTeste } from './helpers/certificado.js';
import { EMITENTE_FIXTURE } from './fixtures/emitente.js';
import { temXmllint } from './helpers/xsd.js';

const CHAVE = '31567002251675482000110000000000000126080216358800';
const MOTIVO = 'Emissao de teste em ambiente de homologacao';

let certificado;
beforeAll(() => {
  const pfx = gerarPfxDeTeste();
  certificado = lerCertificado({ buffer: pfx.buffer, senha: pfx.senha });
});

function montar(over = {}) {
  return montarCancelamento({
    emitente: EMITENTE_FIXTURE,
    chaveAcesso: CHAVE,
    motivo: MOTIVO,
    ...over,
  });
}

describe('montarIdPedidoEvento', () => {
  // O texto dentro do XSD cita um "número sequencial" que não existe na
  // composição; o anexo de leiaute oficial confirma só chave + código, e é o
  // que fecha com pattern="PRE[0-9]{56}".
  it('é PRE + chave (50) + código do evento (6)', () => {
    const id = montarIdPedidoEvento({ chaveAcesso: CHAVE, codigoEvento: EVENTOS.cancelamento });
    expect(id).toBe(`PRE${CHAVE}101101`);
    expect(id).toHaveLength(59);
    expect(id).toMatch(/^PRE[0-9]{56}$/);
  });

  it('recusa chave fora de 50 dígitos e código fora de 6', () => {
    expect(() => montarIdPedidoEvento({ chaveAcesso: '123', codigoEvento: '101101' })).toThrow(/50 dígitos/);
    expect(() => montarIdPedidoEvento({ chaveAcesso: CHAVE, codigoEvento: '1011' })).toThrow(/6 dígitos/);
  });
});

describe('montarCancelamento', () => {
  it('monta o pedido na ordem de TCInfPedReg', () => {
    const { xml, id } = montar();
    expect(xml).toContain(`<pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">`);
    expect(xml).toContain(`<infPedReg Id="${id}">`);

    const ordem = ['tpAmb', 'verAplic', 'dhEvento', 'CNPJAutor', 'chNFSe', 'e101101'];
    const pos = ordem.map((t) => xml.indexOf(`<${t}`));
    expect(pos.every((p) => p > -1)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  // E0812: o CNPJ do autor tem que bater com o do certificado que assina.
  it('usa o CNPJ do emitente como autor do evento', () => {
    expect(montar().xml).toContain(`<CNPJAutor>${EMITENTE_FIXTURE.cnpj}</CNPJAutor>`);
  });

  it('usa o texto exato que o XSD enumera em xDesc', () => {
    expect(montar().xml).toContain('<xDesc>Cancelamento de NFS-e</xDesc>');
  });

  it('leva a chave, o código e a justificativa', () => {
    const { xml } = montar({ codigoMotivo: MOTIVO_CANCELAMENTO.servico_nao_prestado });
    expect(xml).toContain(`<chNFSe>${CHAVE}</chNFSe>`);
    expect(xml).toContain('<cMotivo>2</cMotivo>');
    expect(xml).toContain(`<xMotivo>${MOTIVO}</xMotivo>`);
  });

  // TSMotivo exige 15 a 255 caracteres — pegar isso aqui evita ida à SEFIN.
  it('recusa justificativa curta ou longa demais', () => {
    expect(() => montar({ motivo: 'curto' })).toThrow(/entre 15 e 255/);
    expect(() => montar({ motivo: 'x'.repeat(256) })).toThrow(/entre 15 e 255/);
  });

  it('recusa código de motivo fora do domínio', () => {
    expect(() => montar({ codigoMotivo: '5' })).toThrow(/Use 1, 2 ou 9/);
  });

  it('marca o ambiente da nota que está sendo cancelada', () => {
    expect(montar().xml).toContain('<tpAmb>2</tpAmb>');
    expect(montar({ ambiente: 'producao' }).xml).toContain('<tpAmb>1</tpAmb>');
  });
});

describe('assinatura do pedido de evento', () => {
  it('assina o infPedReg e verifica offline', () => {
    const { xml, id } = montar();
    const assinado = assinarPedidoEvento(xml, certificado);

    expect(assinado).toContain(`URI="#${id}"`);
    expect(assinado).toMatch(/<\/infPedReg>\s*<(?:\w+:)?Signature/);
    expect(verificarAssinatura(assinado, certificado.certificatePem).valido).toBe(true);
  });

  it('detecta adulteração da justificativa', () => {
    const assinado = assinarPedidoEvento(montar().xml, certificado);
    const adulterado = assinado.replace(MOTIVO, 'Outro motivo qualquer aqui');
    expect(verificarAssinatura(adulterado, certificado.certificatePem).valido).toBe(false);
  });
});

describe.runIf(temXmllint())('validação contra o XSD oficial', () => {
  it('o pedido assinado valida contra pedRegEvento_v1.01.xsd', () => {
    const raiz = path.resolve(import.meta.dirname, '../..');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evt-'));
    for (const nome of fs.readdirSync(path.join(raiz, 'schemas/1.01'))) {
      fs.copyFileSync(path.join(raiz, 'schemas/1.01', nome), path.join(dir, nome));
    }
    const arquivo = path.join(dir, 'evt.xml');
    fs.writeFileSync(arquivo, assinarPedidoEvento(montar().xml, certificado), 'utf8');

    let erros = '';
    try {
      execFileSync('xmllint', ['--noout', '--schema', path.join(dir, 'pedRegEvento_v1.01.xsd'), arquivo], { stdio: 'pipe' });
    } catch (e) {
      erros = String(e.stderr ?? e.message).split(dir).join('').trim();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(erros).toBe('');
  });
});
