import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';

const NOVO = {
  tomador_id: '', servico_id: '', descricao: '', valor: '',
  dia_emissao: '21', vigencia_inicio: '', vigencia_fim: '', observacao: '',
};

const dinheiro = (v) =>
  Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function Contratos() {
  const { user } = useAuth();
  const podeEditar = user?.papel === 'emissao' || user?.papel === 'admin';

  const [contratos, setContratos] = useState(null);
  const [tomadores, setTomadores] = useState([]);
  const [servicos, setServicos] = useState([]);
  const [form, setForm] = useState(null); // null = fechado; objeto = criando/editando
  const [pendentes, setPendentes] = useState([]);
  const [aviso, setAviso] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  async function carregar() {
    const [c, t, s, p] = await Promise.all([
      api('/contratos'),
      api('/tomadores'),
      api('/config/servicos'),
      api('/contratos/previsao').catch(() => ({ pendentes: [] })),
    ]);
    setContratos(c.contratos);
    setTomadores(t.tomadores.filter((x) => x.ativo));
    setServicos(s.servicos.filter((x) => x.ativo));
    setPendentes(p.pendentes ?? []);
  }

  useEffect(() => { carregar().catch((e) => setAviso({ tipo: 'erro', texto: e.message })); }, []);

  async function tentar(fn, mensagem) {
    setAviso(null);
    setOcupado(true);
    try {
      await fn();
      await carregar();
      if (mensagem) setAviso({ tipo: 'ok', texto: mensagem });
    } catch (e) {
      setAviso({ tipo: 'erro', texto: e.message });
    } finally {
      setOcupado(false);
    }
  }

  const salvar = (e) => {
    e.preventDefault();
    const { id, ...corpo } = form;
    tentar(async () => {
      if (id) await api(`/contratos/${id}`, { method: 'PUT', body: corpo });
      else await api('/contratos', { method: 'POST', body: corpo });
      setForm(null);
    }, id ? 'Contrato atualizado.' : 'Contrato criado.');
  };

  const alternarAtivo = (c) =>
    tentar(() => api(`/contratos/${c.id}`, { method: 'PUT', body: { ativo: c.ativo ? 0 : 1 } }),
      c.ativo ? 'Contrato desativado.' : 'Contrato reativado.');

  const emitirAgora = () => {
    if (!confirm('Emitir agora os contratos vencidos?\n\nContrato já emitido neste mês não gera segunda nota.')) return;
    tentar(async () => {
      const r = await api('/contratos/emitir-agora', { method: 'POST' });
      const emitidas = r.resultados.filter((x) => x.status === 'emitida').length;
      setAviso({ tipo: 'ok', texto: `${emitidas} nota(s) emitida(s) de ${r.resultados.length} contrato(s) avaliado(s).` });
    });
  };

  const editar = (c) => setForm({
    id: c.id,
    tomador_id: c.tomador_id, servico_id: c.servico_id,
    descricao: c.descricao, valor: c.valor, dia_emissao: c.dia_emissao,
    vigencia_inicio: String(c.vigencia_inicio).slice(0, 10),
    vigencia_fim: c.vigencia_fim ? String(c.vigencia_fim).slice(0, 10) : '',
    observacao: c.observacao ?? '',
  });

  const campo = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-xl font-black">Contratos recorrentes</h1>
          <p className="muted text-xs font-semibold">
            Emissão por calendário, independente de pagamento. As alíquotas vêm do serviço.
          </p>
        </div>
        {podeEditar && (
          <>
            <button className="btn btn-subtle" onClick={emitirAgora} disabled={ocupado}>
              Emitir vencidos
            </button>
            <button className="btn btn-primary" onClick={() => setForm(form ? null : { ...NOVO })}>
              {form ? 'Cancelar' : 'Novo contrato'}
            </button>
          </>
        )}
      </header>

      {aviso && (
        <p className={`rounded-lg px-3 py-2 text-sm font-bold ${
          aviso.tipo === 'erro' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'
        }`}>{aviso.texto}</p>
      )}

      {/* A emissão automática só cobre o mês corrente. Um mês perdido aparece
          aqui para alguém decidir — não é emitido sozinho. */}
      {pendentes.length > 0 && (
        <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4">
          <h2 className="text-sm font-black text-amber-900">
            {pendentes.length} competência(s) passada(s) sem nota
          </h2>
          <p className="mt-1 text-xs font-semibold text-amber-800">
            A emissão automática cobre apenas o mês corrente. Estas ficaram para trás e
            precisam de decisão sua.
          </p>
          <ul className="mt-2 text-xs font-mono text-amber-900">
            {pendentes.map((p) => (
              <li key={`${p.contratoId}-${p.competenciaRef}`}>
                contrato {p.contratoId} · {p.competenciaRef} (previsto para {p.dataEmissao})
              </li>
            ))}
          </ul>
        </div>
      )}

      {form && (
        <form onSubmit={salvar} className="card grid gap-3 p-5 md:grid-cols-3">
          <label className="label">Cliente
            <select className="field" required value={form.tomador_id} onChange={campo('tomador_id')}>
              <option value="">Selecione…</option>
              {tomadores.map((t) => <option key={t.id} value={t.id}>{t.razao_social}</option>)}
            </select>
          </label>
          <label className="label">Serviço
            <select className="field" required value={form.servico_id} onChange={campo('servico_id')}>
              <option value="">Selecione…</option>
              {servicos.map((s) => (
                <option key={s.id} value={s.id}>{s.descricao} · ISS {s.aliquota_iss}%</option>
              ))}
            </select>
            <span className="text-[0.7rem] font-semibold normal-case">
              Define o código de tributação e as alíquotas da nota.
            </span>
          </label>
          <label className="label">Valor mensal
            <input className="field" type="number" step="0.01" min="0.01" required
              value={form.valor} onChange={campo('valor')} />
          </label>
          <label className="label md:col-span-3">Descrição na nota
            <input className="field" required maxLength={500} value={form.descricao} onChange={campo('descricao')} />
          </label>
          <label className="label">Dia da emissão
            <input className="field" type="number" min="1" max="31" required
              value={form.dia_emissao} onChange={campo('dia_emissao')} />
            <span className="text-[0.7rem] font-semibold normal-case">
              Meses sem esse dia usam o último dia do mês.
            </span>
          </label>
          <label className="label">Início da vigência
            <input className="field" type="date" required value={form.vigencia_inicio} onChange={campo('vigencia_inicio')} />
          </label>
          <label className="label">Fim da vigência
            <input className="field" type="date" value={form.vigencia_fim} onChange={campo('vigencia_fim')} />
            <span className="text-[0.7rem] font-semibold normal-case">Em branco = sem prazo.</span>
          </label>
          <label className="label md:col-span-3">Observação interna
            <input className="field" maxLength={500} value={form.observacao} onChange={campo('observacao')} />
            <span className="text-[0.7rem] font-semibold normal-case">Não sai na nota.</span>
          </label>
          <button className="btn btn-success md:justify-self-start" disabled={ocupado}>
            {form.id ? 'Salvar' : 'Criar contrato'}
          </button>
        </form>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Cliente</th>
              <th className="px-3 py-2">Serviço</th>
              <th className="px-3 py-2">Valor</th>
              <th className="px-3 py-2">Dia</th>
              <th className="px-3 py-2">Vigência</th>
              <th className="px-3 py-2">Próxima emissão</th>
              <th className="px-3 py-2">Ações</th>
            </tr>
          </thead>
          <tbody>
            {contratos?.map((c) => (
              <tr key={c.id} className={`border-b last:border-0 ${c.ativo ? '' : 'opacity-55'}`}>
                <td className="px-3 py-2 font-semibold">{c.tomador_nome}</td>
                <td className="max-w-xs px-3 py-2">
                  <span className="block truncate">{c.descricao}</span>
                  <span className="muted text-xs">{c.servico_descricao}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-bold">{dinheiro(c.valor)}</td>
                <td className="px-3 py-2">{c.dia_emissao}</td>
                <td className="whitespace-nowrap px-3 py-2 text-xs">
                  {String(c.vigencia_inicio).slice(0, 10).split('-').reverse().join('/')}
                  {c.vigencia_fim ? ` até ${String(c.vigencia_fim).slice(0, 10).split('-').reverse().join('/')}` : ''}
                </td>
                <td className="px-3 py-2 text-xs">
                  {/* Vem do mesmo cálculo que a cron usa — não é uma segunda conta. */}
                  {c.previsao?.emitir
                    ? <span className="badge bg-emerald-100 text-emerald-800">vencida hoje</span>
                    : <span className="muted">{c.previsao?.motivo}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {podeEditar && (
                    <>
                      <button className="btn py-1 text-xs" onClick={() => editar(c)}>Editar</button>
                      <button className="btn ml-1 py-1 text-xs" onClick={() => alternarAtivo(c)}>
                        {c.ativo ? 'Desativar' : 'Reativar'}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {contratos && !contratos.length && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                Nenhum contrato cadastrado.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
