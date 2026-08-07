import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Ativação e desativação do segundo fator.
 *
 * O fluxo tem três telas porque a ativação tem três momentos distintos: ler o
 * QR, provar que o aplicativo funciona, e guardar os códigos de recuperação —
 * que aparecem uma única vez.
 */
export default function Mfa() {
  const [estado, setEstado] = useState(null);
  const [inicio, setInicio] = useState(null); // { qr, segredo, uri }
  const [codigo, setCodigo] = useState('');
  const [senha, setSenha] = useState('');
  const [backup, setBackup] = useState(null);
  const [aviso, setAviso] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = () => api('/mfa').then(setEstado).catch(() => {});
  useEffect(() => { carregar(); }, []);

  async function acao(fn) {
    setAviso(null);
    setOcupado(true);
    try {
      await fn();
    } catch (e) {
      setAviso({ tipo: 'erro', texto: e.message });
    } finally {
      setOcupado(false);
    }
  }

  const iniciar = () => acao(async () => setInicio(await api('/mfa/iniciar', { method: 'POST' })));

  const confirmar = () => acao(async () => {
    const d = await api('/mfa/confirmar', { method: 'POST', body: { codigo } });
    setBackup(d.codigos_backup);
    setInicio(null);
    setCodigo('');
    await carregar();
  });

  const desativar = () => acao(async () => {
    await api('/mfa/desativar', { method: 'POST', body: { senha, codigo } });
    setSenha('');
    setCodigo('');
    setAviso({ tipo: 'ok', texto: 'Verificação em duas etapas desativada.' });
    await carregar();
  });

  if (!estado) return null;

  return (
    <section className="card p-5">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-base font-black">Verificação em duas etapas</h2>
        <span className={`badge ${estado.ativo ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}`}>
          {estado.ativo ? 'Ativa' : 'Desativada'}
        </span>
      </header>

      {aviso && (
        <p className={`mb-4 rounded-lg px-3 py-2 text-sm font-bold ${
          aviso.tipo === 'erro' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'
        }`}>
          {aviso.texto}
        </p>
      )}

      {/* Os códigos aparecem uma vez só; a tela fica até o usuário confirmar
          que guardou, para não sumir num clique acidental. */}
      {backup && (
        <div className="mb-4 rounded-xl border-2 border-amber-300 bg-amber-50 p-4">
          <h3 className="text-sm font-black text-amber-900">Guarde estes códigos de recuperação</h3>
          <p className="mt-1 text-xs font-semibold text-amber-800">
            São a única forma de entrar se você perder o celular. Cada um vale uma vez, e eles
            não serão mostrados de novo.
          </p>
          <ul className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm font-bold sm:grid-cols-5">
            {backup.map((c) => (
              <li key={c} className="rounded-lg bg-white px-2 py-1.5 text-center">{c}</li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <button
              className="btn"
              onClick={() => navigator.clipboard?.writeText(backup.join('\n'))}
            >
              Copiar
            </button>
            <button className="btn btn-success" onClick={() => setBackup(null)}>
              Guardei os códigos
            </button>
          </div>
        </div>
      )}

      {!estado.ativo && !inicio && !backup && (
        <div className="grid gap-3">
          <p className="text-sm text-slate-600">
            Com ela ligada, saber a sua senha não basta para emitir ou cancelar nota em nome da
            empresa: é preciso também o código do aplicativo no seu celular.
          </p>
          <button className="btn btn-primary justify-self-start" onClick={iniciar} disabled={ocupado}>
            Ativar
          </button>
        </div>
      )}

      {inicio && (
        <div className="grid gap-4 md:grid-cols-[auto_1fr]">
          <img src={inicio.qr} alt="QR Code para o aplicativo autenticador" className="rounded-lg border" width={200} height={200} />
          <div className="grid content-start gap-3">
            <p className="text-sm text-slate-600">
              Leia o QR Code no Google Authenticator (ou outro app TOTP) e digite o código de 6
              dígitos que ele mostrar.
            </p>
            <details className="text-xs">
              <summary className="cursor-pointer font-bold text-slate-600">Não consigo ler o QR</summary>
              <p className="mt-1 break-all font-mono text-slate-700">{inicio.segredo}</p>
            </details>
            <div className="flex flex-wrap gap-2">
              <input
                className="field w-40 text-center text-xl font-black tracking-[0.3em]"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
              />
              <button className="btn btn-success" onClick={confirmar} disabled={ocupado || codigo.length < 6}>
                Confirmar e ativar
              </button>
              <button className="btn" onClick={() => { setInicio(null); setCodigo(''); }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {estado.ativo && !backup && (
        <div className="grid gap-3">
          <p className="text-sm text-slate-600">
            Ativa desde {new Date(estado.confirmado_em).toLocaleDateString('pt-BR')}.{' '}
            <strong>{estado.codigos_backup_restantes}</strong> código(s) de recuperação sem uso.
          </p>
          {estado.codigos_backup_restantes <= 2 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900">
              Restam poucos códigos de recuperação. Desative e ative de novo para gerar outros dez.
            </p>
          )}
          <details>
            <summary className="cursor-pointer text-sm font-bold text-slate-600">Desativar</summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <input
                className="field" type="password" autoComplete="current-password" placeholder="Sua senha"
                value={senha} onChange={(e) => setSenha(e.target.value)}
              />
              <input
                className="field" inputMode="numeric" maxLength={6} placeholder="Código de 6 dígitos"
                value={codigo} onChange={(e) => setCodigo(e.target.value)}
              />
              <button className="btn btn-danger" onClick={desativar} disabled={ocupado}>
                Desativar
              </button>
              <p className="muted text-xs sm:col-span-3">
                Pedimos senha e código porque só a sessão não basta: uma sessão roubada poderia
                desligar justamente a proteção contra sessão roubada.
              </p>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
