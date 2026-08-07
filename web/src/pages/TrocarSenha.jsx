import { useState } from 'react';
import { useAuth } from '../App.jsx';
import { api } from '../api.js';

/**
 * Tela obrigatória para quem entrou com a senha que um admin definiu.
 *
 * O bloqueio de verdade está no servidor (`exigirSenhaDefinitiva`): esta tela
 * existe para o usuário ter como sair da situação, não como barreira. Não há
 * botão de pular, porque não haveria o que fazer depois de pular.
 */
export default function TrocarSenha() {
  const { user, setUser } = useAuth();
  const [form, setForm] = useState({ senhaAtual: '', novaSenha: '', confirmar: '' });
  const [erro, setErro] = useState(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(e) {
    e.preventDefault();
    setErro(null);
    if (form.novaSenha.length < 10) return setErro('A nova senha precisa ter ao menos 10 caracteres.');
    if (form.novaSenha !== form.confirmar) return setErro('A confirmação não confere.');

    setEnviando(true);
    try {
      await api('/me/senha', {
        method: 'PUT',
        body: { senhaAtual: form.senhaAtual, novaSenha: form.novaSenha },
      });
      setUser({ ...user, deveTrocarSenha: false });
    } catch (err) {
      setErro(err.message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="app-shell grid min-h-screen place-items-center px-4">
      <form onSubmit={enviar} className="card w-full max-w-sm p-6">
        <h1 className="text-lg font-black leading-tight">Defina sua senha</h1>
        <p className="muted mt-1 text-xs font-semibold">
          Sua senha atual foi criada por um administrador. Enquanto ela for conhecida por outra
          pessoa, o registro de auditoria não pode dizer que foi você quem agiu.
        </p>

        <div className="mt-5 grid gap-3">
          <label className="label">Senha atual
            <input className="field" type="password" autoComplete="current-password" required
              value={form.senhaAtual} onChange={(e) => setForm({ ...form, senhaAtual: e.target.value })} />
          </label>
          <label className="label">Nova senha
            <input className="field" type="password" autoComplete="new-password" required
              value={form.novaSenha} onChange={(e) => setForm({ ...form, novaSenha: e.target.value })} />
          </label>
          <label className="label">Confirmar
            <input className="field" type="password" autoComplete="new-password" required
              value={form.confirmar} onChange={(e) => setForm({ ...form, confirmar: e.target.value })} />
          </label>

          {erro && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-700">{erro}</p>}

          <button className="btn btn-primary" disabled={enviando}>
            {enviando ? 'Salvando…' : 'Salvar e continuar'}
          </button>
        </div>
      </form>
    </div>
  );
}
