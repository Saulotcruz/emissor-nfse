import { NavLink, Outlet, Navigate, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuth } from '../App.jsx';
import { api } from '../api.js';

const navClass = ({ isActive }) =>
  `rounded-lg px-3 py-2 text-sm font-semibold transition ${
    isActive ? 'bg-white text-[var(--glink-hero)] shadow-sm' : 'text-white/82 hover:bg-white/12 hover:text-white'
  }`;

export default function Layout() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [emitente, setEmitente] = useState(null);
  const [senhaAberta, setSenhaAberta] = useState(false);
  const [senhaForm, setSenhaForm] = useState({ senhaAtual: '', novaSenha: '', confirmar: '' });
  const [senhaAviso, setSenhaAviso] = useState(null);

  useEffect(() => {
    api('/config/emitente').then((d) => setEmitente(d.emitente)).catch(() => {});
  }, []);

  if (!user) return <Navigate to="/login" />;

  async function logout() {
    try {
      await api('/logout', { method: 'POST' });
      setUser(null);
      navigate('/login');
    } catch (err) {
      alert(`Falha ao sair: ${err.message}`);
    }
  }

  async function alterarSenha(e) {
    e.preventDefault();
    setSenhaAviso(null);
    if (senhaForm.novaSenha.length < 10) {
      return setSenhaAviso({ tipo: 'erro', texto: 'A nova senha precisa ter ao menos 10 caracteres.' });
    }
    if (senhaForm.novaSenha !== senhaForm.confirmar) {
      return setSenhaAviso({ tipo: 'erro', texto: 'A confirmação não confere.' });
    }
    try {
      await api('/me/senha', {
        method: 'PUT',
        body: { senhaAtual: senhaForm.senhaAtual, novaSenha: senhaForm.novaSenha },
      });
      setSenhaForm({ senhaAtual: '', novaSenha: '', confirmar: '' });
      setSenhaAviso({ tipo: 'ok', texto: 'Senha alterada.' });
      window.setTimeout(() => { setSenhaAviso(null); setSenhaAberta(false); }, 1800);
    } catch (err) {
      setSenhaAviso({ tipo: 'erro', texto: err.message });
    }
  }

  const ehProducao = emitente?.ambiente === 'producao';

  return (
    <div className="app-shell">
      {/* Faixa permanente em produção restrita: saber em qual ambiente se está
          é a informação mais importante da tela — uma nota emitida achando que
          era teste, ou o contrário, é caro de descobrir depois. */}
      {emitente && !ehProducao && (
        <div className="bg-amber-400 px-4 py-1.5 text-center text-xs font-black uppercase tracking-wide text-amber-950">
          Produção Restrita — as notas emitidas aqui não têm efeito fiscal
        </div>
      )}

      <header className="sticky top-0 z-20 border-b border-white/20 bg-[var(--glink-hero)] text-white shadow-lg backdrop-blur">
        <div className="page-wrap flex flex-wrap items-center gap-3 py-3">
          <button type="button" onClick={() => navigate('/')} className="mr-2 flex items-center gap-3 text-left">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-white text-sm font-black text-[var(--glink-brand)]">
              NF
            </span>
            <span>
              <span className="block text-base font-black leading-tight">Emissor NFS-e</span>
              <span className="block text-xs font-medium text-white/70">
                {emitente?.nome_fantasia || emitente?.razao_social || 'notas fiscais de serviço'}
              </span>
            </span>
          </button>

          <nav className="flex flex-1 flex-wrap items-center gap-1">
            <NavLink to="/" end className={navClass}>
              Notas
            </NavLink>
            <NavLink to="/configuracao" className={navClass}>
              Configuração
            </NavLink>
            {/* A trilha mostra de onde cada pessoa entrou; não é para todo operador. */}
            {user.papel === 'admin' && (
              <NavLink to="/auditoria" className={navClass}>
                Auditoria
              </NavLink>
            )}
            {user.papel === 'admin' && (
              <NavLink to="/usuarios" className={navClass}>
                Usuários
              </NavLink>
            )}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-semibold leading-tight">{user.nome}</p>
              <p className="text-xs capitalize text-white/65">{user.papel}</p>
            </div>
            <button onClick={() => setSenhaAberta(!senhaAberta)} className="btn border-white/20 bg-white/10 text-white hover:bg-white/20">
              Senha
            </button>
            <button onClick={logout} className="btn border-white/20 bg-white/10 text-white hover:bg-white/20">
              Sair
            </button>
          </div>
        </div>

        {senhaAberta && (
          <div className="border-t border-white/15 bg-white/8">
            <form onSubmit={alterarSenha} className="page-wrap grid gap-3 py-4 md:grid-cols-[1fr_1fr_1fr_auto_auto]">
              <input className="field" type="password" autoComplete="current-password" placeholder="Senha atual" required
                value={senhaForm.senhaAtual} onChange={(e) => setSenhaForm({ ...senhaForm, senhaAtual: e.target.value })} />
              <input className="field" type="password" autoComplete="new-password" placeholder="Nova senha (mín. 10)" required
                value={senhaForm.novaSenha} onChange={(e) => setSenhaForm({ ...senhaForm, novaSenha: e.target.value })} />
              <input className="field" type="password" autoComplete="new-password" placeholder="Confirmar nova senha" required
                value={senhaForm.confirmar} onChange={(e) => setSenhaForm({ ...senhaForm, confirmar: e.target.value })} />
              <button className="btn btn-success">Salvar</button>
              <button type="button" className="btn border-white/20 bg-white text-[var(--glink-hero)]"
                onClick={() => { setSenhaAberta(false); setSenhaAviso(null); }}>Cancelar</button>
              {senhaAviso && (
                <p className={`md:col-span-5 rounded-lg px-3 py-2 text-sm font-bold ${senhaAviso.tipo === 'erro' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>
                  {senhaAviso.texto}
                </p>
              )}
            </form>
          </div>
        )}
      </header>

      <main className="page-wrap py-6">
        <Outlet />
      </main>
    </div>
  );
}
