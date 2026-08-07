import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../App.jsx';
import { api } from '../api.js';

export default function Login() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', senha: '' });
  const [erro, setErro] = useState(null);
  const [enviando, setEnviando] = useState(false);

  if (user) return <Navigate to="/" />;

  async function entrar(e) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      const d = await api('/login', { method: 'POST', body: form });
      setUser(d.user);
      navigate('/');
    } catch (err) {
      setErro(err.message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="app-shell grid min-h-screen place-items-center px-4">
      <form onSubmit={entrar} className="card w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-lg bg-[var(--glink-hero)] text-sm font-black text-white">
            NF
          </span>
          <div>
            <h1 className="text-lg font-black leading-tight">Emissor NFS-e</h1>
            <p className="muted text-xs font-semibold">notas fiscais de serviço</p>
          </div>
        </div>

        <div className="grid gap-3">
          <label className="label">
            E-mail
            <input
              className="field"
              type="email"
              autoComplete="username"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          </label>
          <label className="label">
            Senha
            <input
              className="field"
              type="password"
              autoComplete="current-password"
              value={form.senha}
              onChange={(e) => setForm({ ...form, senha: e.target.value })}
              required
            />
          </label>

          {erro && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-700">{erro}</p>
          )}

          <button className="btn btn-primary" disabled={enviando}>
            {enviando ? 'Entrando…' : 'Entrar'}
          </button>
        </div>
      </form>
    </div>
  );
}
