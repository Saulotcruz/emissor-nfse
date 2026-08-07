import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';

const STATUS = {
  autorizada: { rotulo: 'Autorizada', classe: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
  pendente: { rotulo: 'Pendente', classe: 'border-amber-200 bg-amber-50 text-amber-800' },
  enviando: { rotulo: 'Enviando', classe: 'border-amber-200 bg-amber-50 text-amber-800' },
  erro: { rotulo: 'Erro', classe: 'status-badge-danger' },
  cancelada: { rotulo: 'Cancelada', classe: 'border-slate-200 bg-slate-100 text-slate-600' },
};

const brl = (v) => Number(v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const data = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—');
const doc = (d) =>
  String(d ?? '').length === 14
    ? String(d).replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')
    : String(d ?? '').replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

export default function Notas() {
  // Quem só visualiza não vê botões que o servidor recusaria com 403.
  const { user } = useAuth();
  const podeEmitir = user?.papel === 'emissao' || user?.papel === 'admin';
  const [notas, setNotas] = useState(null);
  const [erro, setErro] = useState(null);
  const [filtros, setFiltros] = useState({ status: '', ambiente: '', de: '', ate: '' });
  const [ocupada, setOcupada] = useState(null); // id da nota em ação
  const [detalhe, setDetalhe] = useState(null);
  const [aviso, setAviso] = useState(null);
  const [cancelamento, setCancelamento] = useState(null); // { nota, motivo, codigo }
  const [sincronizando, setSincronizando] = useState(false);

  const carregar = useCallback(async () => {
    setErro(null);
    const qs = new URLSearchParams(Object.entries(filtros).filter(([, v]) => v)).toString();
    try {
      const d = await api(`/notas${qs ? `?${qs}` : ''}`);
      setNotas(d.notas);
    } catch (e) {
      setErro(e.message);
      setNotas([]);
    }
  }, [filtros]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const resumo = useMemo(() => {
    const l = notas ?? [];
    return {
      total: l.length,
      autorizadas: l.filter((n) => n.status === 'autorizada').length,
      problemas: l.filter((n) => ['erro', 'pendente', 'enviando'].includes(n.status)).length,
      valor: l.filter((n) => n.status === 'autorizada').reduce((s, n) => s + Number(n.valor_servico), 0),
    };
  }, [notas]);

  /**
   * Cancelamento feito no Portal Nacional não chega aqui sozinho. Isto pergunta
   * à SEFIN quais notas foram canceladas por fora e acerta o banco.
   */
  async function sincronizar() {
    setSincronizando(true);
    setAviso(null);
    try {
      const r = await api('/notas/sincronizar', { method: 'POST' });
      setAviso({
        tipo: 'ok',
        texto: r.mudadas.length
          ? `${r.mudadas.length} nota(s) atualizada(s): ${r.mudadas.map((m) => `#${m.id}`).join(', ')}`
          : `${r.conferidas} nota(s) conferida(s). Nenhuma divergência.`,
      });
      await carregar();
    } catch (e) {
      setAviso({ tipo: 'erro', texto: e.message });
    } finally {
      setSincronizando(false);
    }
  }

  async function reemitir(nota) {
    if (!confirm(`Reemitir a nota #${nota.id}?\n\nA DPS ${nota.serie}/${nota.numero_dps} é reaproveitada — não gera nota duplicada.`)) return;
    setOcupada(nota.id);
    setAviso(null);
    try {
      const r = await api(`/notas/${nota.id}/reemitir`, { method: 'POST' });
      setAviso({ tipo: 'ok', texto: r.jaAutorizada ? 'A nota já estava autorizada.' : `Nota autorizada. Chave ${r.chaveAcesso}` });
      await carregar();
    } catch (e) {
      setAviso({ tipo: 'erro', texto: e.message });
    } finally {
      setOcupada(null);
    }
  }

  async function confirmarCancelamento(e) {
    e.preventDefault();
    const { nota, motivo, codigo } = cancelamento;
    setOcupada(nota.id);
    setAviso(null);
    try {
      await api(`/notas/${nota.id}/cancelar`, {
        method: 'POST',
        body: { motivo: motivo.trim(), codigoMotivo: codigo },
      });
      setAviso({ tipo: 'ok', texto: `Nota #${nota.id} cancelada.` });
      setCancelamento(null);
      await carregar();
    } catch (err) {
      setAviso({ tipo: 'erro', texto: err.message });
    } finally {
      setOcupada(null);
    }
  }

  async function abrirDetalhe(nota) {
    setDetalhe({ carregando: true, id: nota.id });
    try {
      const d = await api(`/notas/${nota.id}`);
      setDetalhe({ ...d, id: nota.id });
    } catch (e) {
      setDetalhe(null);
      setAviso({ tipo: 'erro', texto: e.message });
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-black">Notas fiscais</h1>
          <p className="muted text-sm font-semibold">
            {notas === null ? 'carregando…' : `${resumo.total} nota(s) · ${resumo.autorizadas} autorizada(s) · ${brl(resumo.valor)}`}
            {resumo.problemas > 0 && (
              <span className="ml-2 text-amber-700">· {resumo.problemas} precisam de atenção</span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {podeEmitir && (
          <button onClick={sincronizar} className="btn btn-subtle" disabled={sincronizando}>
            {sincronizando ? 'Conferindo…' : 'Conferir na SEFIN'}
          </button>
          )}
          <button onClick={carregar} className="btn btn-subtle">Atualizar</button>
        </div>
      </div>

      <div className="card grid gap-3 p-4 md:grid-cols-[1fr_1fr_1fr_1fr_auto]">
        <label className="label">
          Ambiente
          <select className="field" value={filtros.ambiente} onChange={(e) => setFiltros({ ...filtros, ambiente: e.target.value })}>
            <option value="">Todos</option>
            <option value="producao">Produção</option>
            <option value="producao_restrita">Produção Restrita</option>
          </select>
        </label>
        <label className="label">
          Status
          <select className="field" value={filtros.status} onChange={(e) => setFiltros({ ...filtros, status: e.target.value })}>
            <option value="">Todos</option>
            {Object.entries(STATUS).map(([v, s]) => (
              <option key={v} value={v}>{s.rotulo}</option>
            ))}
          </select>
        </label>
        <label className="label">
          Competência de
          <input className="field" type="date" value={filtros.de} onChange={(e) => setFiltros({ ...filtros, de: e.target.value })} />
        </label>
        <label className="label">
          até
          <input className="field" type="date" value={filtros.ate} onChange={(e) => setFiltros({ ...filtros, ate: e.target.value })} />
        </label>
        <button onClick={() => setFiltros({ status: '', ambiente: '', de: '', ate: '' })} className="btn btn-subtle self-end">
          Limpar
        </button>
      </div>

      {aviso && (
        <p className={`rounded-lg px-3 py-2 text-sm font-bold ${aviso.tipo === 'erro' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>
          {aviso.texto}
        </p>
      )}
      {erro && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-700">{erro}</p>}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-[#d7edf2] text-left text-xs font-black uppercase text-[var(--glink-muted)]">
              <th className="px-4 py-3">NFS-e / DPS</th>
              <th className="px-4 py-3">Tomador</th>
              <th className="px-4 py-3">Competência</th>
              <th className="px-4 py-3 text-right">Valor</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Ambiente</th>
              <th className="px-4 py-3">Origem</th>
              <th className="px-4 py-3 text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {notas === null && (
              <tr><td colSpan={8} className="px-4 py-8 text-center muted font-semibold">Carregando…</td></tr>
            )}
            {notas?.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center muted font-semibold">Nenhuma nota encontrada.</td></tr>
            )}
            {notas?.map((n) => {
              const s = STATUS[n.status] ?? { rotulo: n.status, classe: '' };
              const emAcao = ocupada === n.id;
              return (
                <tr key={n.id} className="border-b border-[#eef7f9] last:border-0 hover:bg-[var(--glink-soft)]">
                  <td className="px-4 py-3">
                    <button onClick={() => abrirDetalhe(n)} className="font-bold text-[var(--glink-brand)] hover:underline">
                      {n.numero_nfse ? `NFS-e ${n.numero_nfse}` : `#${n.id}`}
                    </button>
                    <span className="muted block text-xs font-semibold">DPS {n.serie}/{n.numero_dps}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-semibold">{n.tomador_razao_social}</span>
                    <span className="muted block text-xs">{doc(n.tomador_documento)}</span>
                  </td>
                  <td className="px-4 py-3">{data(n.competencia)}</td>
                  <td className="px-4 py-3 text-right font-bold">{brl(n.valor_servico)}</td>
                  <td className="px-4 py-3">
                    <span className={`status-badge ${s.classe}`}>{s.rotulo}</span>
                    {n.erro_mensagem && (
                      <span className="mt-1 block max-w-[22rem] text-xs text-red-700" title={n.erro_mensagem}>
                        {n.erro_codigo ? `[${n.erro_codigo}] ` : ''}{n.erro_mensagem.slice(0, 90)}
                        {n.erro_mensagem.length > 90 ? '…' : ''}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {/* Sem isto, distinguir nota válida de nota de teste exigia
                        abrir cada uma — e as duas convivem na mesma lista. */}
                    {n.ambiente === 'producao' ? (
                      <span className="status-badge border-emerald-200 bg-emerald-50 text-emerald-800">Produção</span>
                    ) : (
                      <span className="status-badge border-amber-300 bg-amber-100 text-amber-900">Teste</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="muted text-xs font-bold uppercase">{n.origem}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      {n.status === 'autorizada' && (
                        <>
                          <a className="btn btn-subtle" href={`/api/notas/${n.id}/xml`}>XML</a>
                          {/* O PDF é gerado sob demanda pelo ambiente nacional;
                              o XML é o documento fiscal, o PDF é representação. */}
                          <a className="btn btn-subtle" href={`/api/notas/${n.id}/danfse`} target="_blank" rel="noreferrer">PDF</a>
                          {podeEmitir && (
                            <button
                              className="btn btn-danger"
                              disabled={emAcao}
                              onClick={() => setCancelamento({ nota: n, motivo: '', codigo: '1' })}
                            >
                              {emAcao ? '…' : 'Cancelar'}
                            </button>
                          )}
                        </>
                      )}
                      {podeEmitir && ['erro', 'pendente', 'enviando'].includes(n.status) && (
                        <button className="btn btn-primary" disabled={emAcao} onClick={() => reemitir(n)}>
                          {emAcao ? 'Emitindo…' : 'Reemitir'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {cancelamento && (
        <div className="fixed inset-0 z-30 grid place-items-center bg-black/40 p-4">
          <form onSubmit={confirmarCancelamento} className="card w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-black">
              Cancelar {cancelamento.nota.numero_nfse ? `NFS-e ${cancelamento.nota.numero_nfse}` : `nota #${cancelamento.nota.id}`}
            </h2>
            <p className="muted mt-1 text-sm font-semibold">
              {cancelamento.nota.tomador_razao_social} · {brl(cancelamento.nota.valor_servico)}
            </p>

            <div className="mt-4 grid gap-3">
              <label className="label">
                Motivo
                <select
                  className="field"
                  value={cancelamento.codigo}
                  onChange={(e) => setCancelamento({ ...cancelamento, codigo: e.target.value })}
                >
                  <option value="1">Erro na emissão</option>
                  <option value="2">Serviço não prestado</option>
                  <option value="9">Outros</option>
                </select>
              </label>

              <label className="label">
                Justificativa
                <textarea
                  className="field"
                  rows={3}
                  minLength={15}
                  maxLength={255}
                  required
                  autoFocus
                  value={cancelamento.motivo}
                  onChange={(e) => setCancelamento({ ...cancelamento, motivo: e.target.value })}
                />
              </label>
              {/* O schema exige de 15 a 255 caracteres; mostrar a contagem evita
                  descobrir isso numa rejeição da SEFIN. */}
              <p className={`text-xs font-bold ${cancelamento.motivo.trim().length < 15 ? 'text-amber-700' : 'muted'}`}>
                {cancelamento.motivo.trim().length}/255 — mínimo de 15 caracteres
              </p>

              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                O prazo e as condições de cancelamento são definidos pelo município. Uma recusa
                pode ser legítima mesmo com tudo preenchido corretamente.
              </p>

              <div className="flex justify-end gap-2">
                <button type="button" className="btn btn-subtle" onClick={() => setCancelamento(null)}>
                  Voltar
                </button>
                <button
                  className="btn btn-danger"
                  disabled={ocupada === cancelamento.nota.id || cancelamento.motivo.trim().length < 15}
                >
                  {ocupada === cancelamento.nota.id ? 'Cancelando…' : 'Cancelar nota'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {detalhe && (
        <div className="fixed inset-0 z-30 grid place-items-center bg-black/40 p-4" onClick={() => setDetalhe(null)}>
          <div className="card max-h-[85vh] w-full max-w-2xl overflow-auto p-5" onClick={(e) => e.stopPropagation()}>
            {detalhe.carregando ? (
              <p className="muted font-semibold">Carregando…</p>
            ) : (
              <>
                <div className="mb-4 flex items-start justify-between gap-3">
                  <h2 className="text-lg font-black">
                    {detalhe.nota.numero_nfse ? `NFS-e ${detalhe.nota.numero_nfse}` : `Nota #${detalhe.nota.id}`}
                  </h2>
                  <button className="btn btn-subtle" onClick={() => setDetalhe(null)}>Fechar</button>
                </div>
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <Campo t="Tomador" v={`${detalhe.nota.tomador_razao_social} (${doc(detalhe.nota.tomador_documento)})`} />
                  <Campo t="Serviço" v={detalhe.nota.descricao_servico} />
                  <Campo t="Competência" v={data(detalhe.nota.competencia)} />
                  <Campo t="Valor" v={brl(detalhe.nota.valor_servico)} />
                  <Campo t="ISSQN" v={brl(detalhe.nota.valor_iss)} />
                  <Campo t="PIS / COFINS" v={`${brl(detalhe.nota.valor_pis)} / ${brl(detalhe.nota.valor_cofins)}`} />
                  <Campo t="Ambiente" v={detalhe.nota.ambiente === 'producao' ? 'Produção' : 'Produção Restrita'} />
                  <Campo t="Origem" v={detalhe.nota.origem} />
                  <Campo t="Chave de acesso" v={detalhe.nota.chave_acesso ?? '—'} largo />
                  <Campo t="idDPS" v={detalhe.nota.id_dps} largo />
                  {detalhe.nota.stripe_invoice_id && (
                    <Campo t="Fatura Stripe" v={detalhe.nota.stripe_invoice_id} largo />
                  )}
                  {detalhe.nota.erro_mensagem && (
                    <Campo t="Erro" v={`${detalhe.nota.erro_codigo ?? ''} ${detalhe.nota.erro_mensagem}`} largo />
                  )}
                </dl>

                {detalhe.eventos?.length > 0 && (
                  <>
                    <h3 className="mt-5 mb-2 text-sm font-black uppercase text-[var(--glink-muted)]">Eventos</h3>
                    <ul className="grid gap-1 text-sm">
                      {detalhe.eventos.map((e) => (
                        <li key={e.id} className="flex flex-wrap gap-2">
                          <span className="status-badge">{e.tipo}</span>
                          <span className="font-semibold">{e.status}</span>
                          <span className="muted">{e.motivo}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Campo({ t, v, largo }) {
  return (
    <div className={largo ? 'sm:col-span-2' : ''}>
      <dt className="label">{t}</dt>
      <dd className="break-all font-semibold">{v}</dd>
    </div>
  );
}
