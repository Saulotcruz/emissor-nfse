import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';

/**
 * Trilha de auditoria — só leitura, e só para admin.
 *
 * A tabela no banco é append-only: não há rota que altere ou apague linha, e
 * esta tela não tem botão que sugira o contrário.
 */

const ROTULOS = {
  login: 'Entrou',
  login_falha: 'Falha de login',
  login_mfa_falha: 'Falha no código MFA',
  logout: 'Saiu',
  senha_alterada: 'Trocou a senha',
  mfa_ativado: 'Ativou o MFA',
  mfa_desativado: 'Desativou o MFA',
  mfa_backup_usado: 'Usou código de recuperação',
  nota_emitida: 'Emitiu nota',
  nota_reemitida: 'Reemitiu nota',
  nota_cancelada: 'Cancelou nota',
  notas_sincronizadas: 'Sincronizou notas',
  tomador_criado: 'Criou tomador',
  tomador_alterado: 'Alterou tomador',
  tomador_excluido: 'Inativou tomador',
  emitente_alterado: 'Alterou o emitente',
  servico_criado: 'Criou serviço',
  servico_alterado: 'Alterou serviço',
};

// As que merecem destaque: falha de autenticação e ato fiscal irreversível.
const CORES = {
  login_falha: 'bg-red-100 text-red-800',
  login_mfa_falha: 'bg-red-100 text-red-800',
  mfa_desativado: 'bg-amber-100 text-amber-900',
  mfa_backup_usado: 'bg-amber-100 text-amber-900',
  nota_cancelada: 'bg-amber-100 text-amber-900',
  nota_emitida: 'bg-emerald-100 text-emerald-800',
};

const POR_PAGINA = 100;

export default function Auditoria() {
  const { user } = useAuth();
  const [dados, setDados] = useState(null);
  const [acoes, setAcoes] = useState([]);
  const [filtro, setFiltro] = useState({ acao: '', de: '', ate: '' });
  const [pagina, setPagina] = useState(0);
  const [erro, setErro] = useState(null);

  useEffect(() => {
    api('/auditoria/acoes').then((d) => setAcoes(d.acoes)).catch(() => {});
  }, []);

  useEffect(() => {
    const q = new URLSearchParams({ limite: POR_PAGINA, offset: pagina * POR_PAGINA });
    for (const [k, v] of Object.entries(filtro)) if (v) q.set(k, v);
    setErro(null);
    api(`/auditoria?${q}`).then(setDados).catch((e) => setErro(e.message));
  }, [filtro, pagina]);

  if (user?.papel !== 'admin') {
    return <p className="card p-5 text-sm font-semibold">Somente administradores podem ver a trilha de auditoria.</p>;
  }

  const trocar = (campo) => (e) => {
    setPagina(0);
    setFiltro({ ...filtro, [campo]: e.target.value });
  };

  const total = dados?.total ?? 0;
  const ultimaPagina = Math.max(0, Math.ceil(total / POR_PAGINA) - 1);

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-xl font-black">Auditoria</h1>
          <p className="muted text-xs font-semibold">
            {total} registro(s). Quem fez o quê, quando e de onde.
          </p>
        </div>
        <label className="label">
          Ação
          <select className="field" value={filtro.acao} onChange={trocar('acao')}>
            <option value="">Todas</option>
            {acoes.map((a) => <option key={a} value={a}>{ROTULOS[a] ?? a}</option>)}
          </select>
        </label>
        <label className="label">
          De
          <input className="field" type="date" value={filtro.de} onChange={trocar('de')} />
        </label>
        <label className="label">
          Até
          <input className="field" type="date" value={filtro.ate} onChange={trocar('ate')} />
        </label>
      </header>

      {erro && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-700">{erro}</p>}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Quando</th>
              <th className="px-3 py-2">Quem</th>
              <th className="px-3 py-2">Ação</th>
              <th className="px-3 py-2">Alvo</th>
              <th className="px-3 py-2">Detalhe</th>
              <th className="px-3 py-2">IP</th>
            </tr>
          </thead>
          <tbody>
            {dados?.auditoria.map((l) => (
              <tr key={l.id} className="border-b last:border-0 align-top">
                <td className="whitespace-nowrap px-3 py-2 font-medium">
                  {new Date(l.created_at).toLocaleString('pt-BR')}
                </td>
                {/* Emissão automática não tem usuário: o autor é a Stripe. */}
                <td className="px-3 py-2">{l.usuario_email ?? <span className="muted">automático</span>}</td>
                <td className="px-3 py-2">
                  <span className={`badge ${CORES[l.acao] ?? 'bg-slate-100 text-slate-700'}`}>
                    {ROTULOS[l.acao] ?? l.acao}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {l.entidade ? `${l.entidade} ${l.entidade_id ?? ''}` : '—'}
                </td>
                <td className="max-w-md px-3 py-2 font-mono text-xs text-slate-600">
                  {l.detalhe ? JSON.stringify(l.detalhe) : '—'}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{l.ip ?? '—'}</td>
              </tr>
            ))}
            {dados && !dados.auditoria.length && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">Nenhum registro no filtro.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {ultimaPagina > 0 && (
        <div className="flex items-center gap-3">
          <button className="btn" disabled={pagina === 0} onClick={() => setPagina(pagina - 1)}>
            Anterior
          </button>
          <span className="text-sm font-semibold">Página {pagina + 1} de {ultimaPagina + 1}</span>
          <button className="btn" disabled={pagina >= ultimaPagina} onClick={() => setPagina(pagina + 1)}>
            Próxima
          </button>
        </div>
      )}
    </div>
  );
}
