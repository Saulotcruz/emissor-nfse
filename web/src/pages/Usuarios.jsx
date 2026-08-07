import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';

const DESCRICAO = {
  visualizacao: 'Vê notas e baixa XML/DANFSe',
  emissao: 'O acima + emite, reemite, cancela e cadastra tomadores',
  admin: 'Tudo + alíquotas, emitente, usuários e auditoria',
};

const NOVO = { nome: '', email: '', senha: '', papel: 'visualizacao' };

export default function Usuarios() {
  const { user } = useAuth();
  const [usuarios, setUsuarios] = useState(null);
  const [papeis, setPapeis] = useState([]);
  const [novo, setNovo] = useState(NOVO);
  const [criando, setCriando] = useState(false);
  const [senhaDe, setSenhaDe] = useState(null); // { id, nome }
  const [novaSenha, setNovaSenha] = useState('');
  const [aviso, setAviso] = useState(null);

  const carregar = () =>
    api('/usuarios').then((d) => { setUsuarios(d.usuarios); setPapeis(d.papeis); }).catch((e) => erro(e.message));

  useEffect(() => { carregar(); }, []);

  const erro = (texto) => setAviso({ tipo: 'erro', texto });
  const ok = (texto) => setAviso({ tipo: 'ok', texto });

  async function tentar(fn, mensagem) {
    setAviso(null);
    try {
      await fn();
      await carregar();
      if (mensagem) ok(mensagem);
    } catch (e) {
      erro(e.message);
    }
  }

  const criar = (e) => {
    e.preventDefault();
    tentar(async () => {
      await api('/usuarios', { method: 'POST', body: novo });
      setNovo(NOVO);
      setCriando(false);
    }, 'Usuário criado. Ele precisará trocar a senha no primeiro acesso.');
  };

  const alterar = (id, mudanca) =>
    tentar(() => api(`/usuarios/${id}`, { method: 'PUT', body: mudanca }), 'Usuário atualizado.');

  const definirSenha = (e) => {
    e.preventDefault();
    tentar(async () => {
      await api(`/usuarios/${senhaDe.id}/senha`, { method: 'PUT', body: { senha: novaSenha } });
      setSenhaDe(null);
      setNovaSenha('');
    }, 'Senha redefinida. O usuário terá de trocá-la ao entrar.');
  };

  const desligarMfa = (u) => {
    if (!confirm(`Desligar a verificação em duas etapas de ${u.nome}? Faça isso apenas se a pessoa perdeu o acesso ao aplicativo e aos códigos de recuperação.`)) return;
    tentar(() => api(`/usuarios/${u.id}/mfa`, { method: 'DELETE' }), 'MFA desligado para este usuário.');
  };

  if (user?.papel !== 'admin') {
    return <p className="card p-5 text-sm font-semibold">Somente administradores podem gerenciar usuários.</p>;
  }

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-xl font-black">Usuários</h1>
          <p className="muted text-xs font-semibold">Quem entra no sistema e o que cada um pode fazer.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCriando(!criando)}>
          {criando ? 'Cancelar' : 'Novo usuário'}
        </button>
      </header>

      {aviso && (
        <p className={`rounded-lg px-3 py-2 text-sm font-bold ${
          aviso.tipo === 'erro' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'
        }`}>
          {aviso.texto}
        </p>
      )}

      {criando && (
        <form onSubmit={criar} className="card grid gap-3 p-5 md:grid-cols-4">
          <label className="label">Nome
            <input className="field" required value={novo.nome}
              onChange={(e) => setNovo({ ...novo, nome: e.target.value })} />
          </label>
          <label className="label">E-mail
            <input className="field" type="email" required value={novo.email}
              onChange={(e) => setNovo({ ...novo, email: e.target.value })} />
          </label>
          <label className="label">Senha provisória
            <input className="field" type="text" required minLength={10} value={novo.senha}
              onChange={(e) => setNovo({ ...novo, senha: e.target.value })} />
            <span className="text-[0.7rem] font-semibold normal-case">
              Mínimo 10. Será trocada no primeiro acesso.
            </span>
          </label>
          <label className="label">Perfil
            <select className="field" value={novo.papel}
              onChange={(e) => setNovo({ ...novo, papel: e.target.value })}>
              {papeis.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <span className="text-[0.7rem] font-semibold normal-case">{DESCRICAO[novo.papel]}</span>
          </label>
          <button className="btn btn-success md:col-span-4 md:justify-self-start">Criar</button>
        </form>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Nome</th>
              <th className="px-3 py-2">E-mail</th>
              <th className="px-3 py-2">Perfil</th>
              <th className="px-3 py-2">MFA</th>
              <th className="px-3 py-2">Último acesso</th>
              <th className="px-3 py-2">Situação</th>
              <th className="px-3 py-2">Ações</th>
            </tr>
          </thead>
          <tbody>
            {usuarios?.map((u) => {
              const eu = u.id === user.id;
              return (
                <tr key={u.id} className="border-b last:border-0">
                  <td className="px-3 py-2 font-semibold">
                    {u.nome} {eu && <span className="muted text-xs">(você)</span>}
                  </td>
                  <td className="px-3 py-2">{u.email}</td>
                  <td className="px-3 py-2">
                    {/* Trocar o próprio papel é bloqueado no servidor; aqui o
                        select some para não oferecer o que vai ser recusado. */}
                    {eu ? (
                      <span className="badge bg-slate-100 text-slate-700">{u.papel}</span>
                    ) : (
                      <select className="field py-1" value={u.papel}
                        onChange={(e) => alterar(u.id, { papel: e.target.value })}>
                        {papeis.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {u.mfa_ativo
                      ? <span className="badge bg-emerald-100 text-emerald-800">ativo</span>
                      : <span className="badge bg-amber-100 text-amber-900">sem MFA</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">
                    {u.ultimo_acesso_em ? new Date(u.ultimo_acesso_em).toLocaleString('pt-BR') : '—'}
                  </td>
                  <td className="px-3 py-2">
                    {u.ativo
                      ? <span className="badge bg-emerald-100 text-emerald-800">ativo</span>
                      : <span className="badge bg-slate-200 text-slate-600">inativo</span>}
                    {Boolean(u.deve_trocar_senha) && (
                      <span className="badge ml-1 bg-amber-100 text-amber-900">senha provisória</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <button className="btn py-1 text-xs" onClick={() => setSenhaDe(u)}>Senha</button>
                    {Boolean(u.mfa_ativo) && (
                      <button className="btn ml-1 py-1 text-xs" onClick={() => desligarMfa(u)}>Desligar MFA</button>
                    )}
                    {!eu && (
                      <button className="btn ml-1 py-1 text-xs"
                        onClick={() => alterar(u.id, { ativo: u.ativo ? 0 : 1 })}>
                        {u.ativo ? 'Desativar' : 'Reativar'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {senhaDe && (
        <form onSubmit={definirSenha} className="card grid gap-3 p-5 md:grid-cols-[1fr_auto_auto]">
          <label className="label">Nova senha para {senhaDe.nome}
            <input className="field" type="text" required minLength={10} autoFocus
              value={novaSenha} onChange={(e) => setNovaSenha(e.target.value)} />
            <span className="text-[0.7rem] font-semibold normal-case">
              Entregue por um canal seguro. O usuário terá de trocá-la ao entrar.
            </span>
          </label>
          <button className="btn btn-success self-start">Definir</button>
          <button type="button" className="btn self-start"
            onClick={() => { setSenhaDe(null); setNovaSenha(''); }}>Cancelar</button>
        </form>
      )}
    </div>
  );
}
