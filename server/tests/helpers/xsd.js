import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCHEMAS = path.join(RAIZ, 'schemas/1.01');

/**
 * Defeito conhecido do pacote oficial v1.01 (NFSe-ESQUEMAS_XSD-v1.01-20260209):
 *
 *   <xs:simpleType name="TSSerieDPS">
 *     <xs:pattern value="^0{0,4}\d{1,5}$"/>
 *
 * Em XML Schema, os patterns são ancorados implicitamente e `^`/`$` são
 * caracteres LITERAIS — não âncoras. Do jeito que está, o valor teria que
 * conter os símbolos `^` e `$` para validar, o que torna o campo `serie`
 * impossível de preencher. É o único pattern do arquivo com âncoras, e a
 * v1.00 não tinha pattern nenhum nesse tipo: é erro de digitação do schema.
 *
 * A SEFIN aceita séries normais na prática (notas reais são emitidas com
 * série 70000). Então mantemos `schemas/` com os arquivos oficiais INTACTOS e
 * corrigimos apenas na cópia temporária usada para validar, para a divergência
 * ficar explícita em vez de escondida.
 */
const CORRECOES = [
  {
    arquivo: 'tiposSimples_v1.01.xsd',
    de: '<xs:pattern value="^0{0,4}\\d{1,5}$"/>',
    para: '<xs:pattern value="0{0,4}\\d{1,5}"/>',
    motivo: 'TSSerieDPS: âncoras literais tornam o campo serie inpreenchível',
  },
];

/** xmllint vem no macOS; no Linux é o pacote libxml2-utils. */
export function temXmllint() {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Copia os XSDs para um diretório temporário aplicando as correções acima. */
function prepararSchemas() {
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd-'));
  for (const nome of fs.readdirSync(SCHEMAS)) {
    let conteudo = fs.readFileSync(path.join(SCHEMAS, nome), 'utf8');
    for (const c of CORRECOES) {
      if (c.arquivo !== nome) continue;
      if (!conteudo.includes(c.de)) {
        throw new Error(
          `Correção de XSD não se aplica mais em ${nome} (${c.motivo}). ` +
            'O pacote oficial provavelmente foi atualizado — revise CORRECOES em helpers/xsd.js.'
        );
      }
      conteudo = conteudo.replace(c.de, c.para);
    }
    fs.writeFileSync(path.join(destino, nome), conteudo, 'utf8');
  }
  return destino;
}

/**
 * Valida um XML contra o XSD oficial da DPS.
 * @returns {{ valido: boolean, erros: string }}
 */
export function validarDps(xml) {
  const dir = prepararSchemas();
  const arquivo = path.join(dir, 'dps.xml');
  fs.writeFileSync(arquivo, xml, 'utf8');
  try {
    execFileSync('xmllint', ['--noout', '--schema', path.join(dir, 'DPS_v1.01.xsd'), arquivo], {
      stdio: 'pipe',
    });
    return { valido: true, erros: '' };
  } catch (e) {
    const saida = String(e.stderr ?? e.message);
    // Tira o caminho temporário do texto, senão o erro fica ilegível no relatório.
    return { valido: false, erros: saida.split(dir).join('').trim() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
