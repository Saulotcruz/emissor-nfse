import crypto from 'node:crypto';
import { URLSearchParams } from 'node:url';

/**
 * TOTP — o código de 6 dígitos do Google Authenticator (RFC 6238 sobre RFC 4226).
 *
 * Implementado aqui em vez de trazer uma biblioteca: é HMAC-SHA1 sobre um
 * contador de 30 em 30 segundos, cabe numa leitura, e o que guarda a emissão de
 * documento fiscal merece ser auditável. Mesmo critério da verificação de
 * assinatura da Stripe.
 *
 * SHA1 aqui não é escolha de segurança: é o que o RFC fixa e o que os
 * aplicativos autenticadores implementam. Trocar por SHA256 geraria códigos que
 * o Google Authenticator não reconhece.
 */

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // base32, RFC 4648
export const DIGITOS = 6;
export const PASSO_S = 30;

export function base32Encode(buf) {
  let bits = 0;
  let valor = 0;
  let saida = '';
  for (const byte of buf) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      saida += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) saida += ALFABETO[(valor << (5 - bits)) & 31];
  return saida;
}

export function base32Decode(texto) {
  // Autenticadores mostram o segredo em grupos separados por espaço, e alguns
  // colam com "=" no fim. Nada disso faz parte do valor.
  const limpo = String(texto ?? '').toUpperCase().replace(/[=\s-]/g, '');
  let bits = 0;
  let valor = 0;
  const bytes = [];
  for (const c of limpo) {
    const i = ALFABETO.indexOf(c);
    if (i < 0) throw new Error('Segredo base32 inválido');
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Segredo novo. 20 bytes é o tamanho que o RFC 4226 recomenda para SHA1. */
export function gerarSegredo(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** Qual intervalo de 30s estamos. */
export function contadorAtual(agora = Date.now(), passo = PASSO_S) {
  return Math.floor(agora / 1000 / passo);
}

export function codigoTotp(segredo, contador, digitos = DIGITOS) {
  const bloco = Buffer.alloc(8);
  bloco.writeBigUInt64BE(BigInt(contador));
  const hmac = crypto.createHmac('sha1', base32Decode(segredo)).update(bloco).digest();

  // Truncamento dinâmico do RFC 4226: os 4 bits finais escolhem de onde ler.
  const inicio = hmac[hmac.length - 1] & 0x0f;
  const numero =
    ((hmac[inicio] & 0x7f) << 24) |
    (hmac[inicio + 1] << 16) |
    (hmac[inicio + 2] << 8) |
    hmac[inicio + 3];

  return String(numero % 10 ** digitos).padStart(digitos, '0');
}

function iguais(a, b) {
  const A = Buffer.from(a, 'utf8');
  const B = Buffer.from(b, 'utf8');
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/**
 * Confere um código e devolve o contador que o gerou, ou null.
 *
 * Quem chama deve **guardar o contador devolvido** e passá-lo como
 * `contadorMinimo` na próxima verificação: sem isso, um código visto por cima
 * do ombro (ou capturado num proxy) continua valendo pelos 30 segundos dele.
 *
 * `janela: 1` aceita o intervalo anterior e o seguinte, tolerância para relógio
 * de celular fora de hora. Cada passo a mais amplia a janela de reuso, então 1
 * é o padrão — não subir sem motivo.
 */
export function verificarTotp(
  segredo,
  codigo,
  { agora = Date.now(), janela = 1, contadorMinimo = null, passo = PASSO_S } = {}
) {
  const informado = String(codigo ?? '').replace(/\D/g, '');
  if (informado.length !== DIGITOS) return null;

  const atual = contadorAtual(agora, passo);
  for (let d = -janela; d <= janela; d += 1) {
    const contador = atual + d;
    // Já usado (ou anterior ao já usado): recusa mesmo que o código confira.
    if (contadorMinimo !== null && contador <= contadorMinimo) continue;
    if (iguais(codigoTotp(segredo, contador), informado)) return contador;
  }
  return null;
}

/**
 * URI que vira o QR Code lido pelo aplicativo.
 *
 * O rótulo leva emissor e conta para o app não mostrar só "6 dígitos" numa
 * lista de várias contas.
 */
export function uriOtpauth({ segredo, conta, emissor = 'Emissor NFS-e' }) {
  const rotulo = encodeURIComponent(`${emissor}:${conta}`);
  const parametros = new URLSearchParams({
    secret: segredo,
    issuer: emissor,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PASSO_S),
  });
  return `otpauth://totp/${rotulo}?${parametros}`;
}

/**
 * Códigos de recuperação, para quando o celular se perde.
 *
 * Formato agrupado (`a1b2-c3d4`) para conseguir ser copiado à mão sem erro.
 * Sem eles, perder o celular significa perder o acesso ao sistema que emite as
 * notas — e não há "esqueci minha senha" aqui.
 */
export function gerarCodigosBackup(quantidade = 10) {
  return Array.from({ length: quantidade }, () => {
    const bruto = crypto.randomBytes(4).toString('hex'); // 8 caracteres
    return `${bruto.slice(0, 4)}-${bruto.slice(4)}`;
  });
}

export const normalizarCodigoBackup = (c) => String(c ?? '').toLowerCase().replace(/[^a-f0-9]/g, '');
