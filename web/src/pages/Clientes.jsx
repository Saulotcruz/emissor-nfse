import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';

/**
 * Cadastro de clientes (tomadores).
 *
 * Convive com a ingestão automática da Stripe: quem paga uma assinatura entra
 * sozinho, com `origem = stripe`. Esta tela existe para o outro caso — o
 * cliente que só tem contrato, e nunca passou pelo checkout.
 */

const VAZIO = {
  documento: '', razao_social: '', nome_fantasia: '', inscricao_municipal: '',
  email: '', telefone: '', logradouro: '', numero: '', complemento: '',
  bairro: '', cep: '', codigo_municipio: '', uf: '',
};

const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');

function documentoFormatado(t) {
  const d = soDigitos(t.documento);
  if (t.tipo_doc === 'cpf' || d.length === 11) {
    return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  }
  return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}

export default function Clientes() {
  const { user } = useAuth();
  const podeEditar = user?.papel === 'emissao' || user?.papel === 'admin';

  const [clientes, setClientes] = useState(null);
  const [busca, setBusca] = useState('');
  const [form, setForm] = useState(null);
  const [aviso, setAviso] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = (termo = busca) =>
    api(`/tomadores?busca=${encodeURIComponent(termo)}`).then((d) => setClientes(d.tomadores));

  // Espera o usuário parar de digitar antes de consultar: sem isso, cada tecla
  // vira uma requisição, e o limitador da API acabaria barrando uma busca
  // legítima.
  useEffect(() => {
    const t = setTimeout(() => {
      api(`/tomadores?busca=${encodeURIComponent(busca)}`)
        .then((d) => setClientes(d.tomadores))
        .catch((e) => setAviso({ tipo: 'erro', texto: e.message }));
    }, 250);
    return () => clearTimeout(t);
  }, [busca]);

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

  /**
   * Preenche o formulário a partir do CNPJ, via BrasilAPI.
   *
   * O código do município não vem: a BrasilAPI devolve o padrão SIAFI e a DPS
   * exige o IBGE de 7 dígitos. Por isso o campo continua em branco e com aviso,
   * em vez de ser preenchido com um número que a SEFIN recusaria.
   */
  const buscarCnpj = () => tentar(async () => {
    const doc = soDigitos(form.documento);
    if (doc.length !== 14) throw new Error('Informe um CNPJ com 14 dígitos.');
    const { dados } = await api(`/tomadores/consulta/${doc}`);
    setForm((f) => ({
      ...f,
      ...Object.fromEntries(Object.entries(dados).filter(([k, v]) => k in VAZIO && v != null)),
      documento: doc,
    }));
    setAviso({
      tipo: 'ok',
      texto: dados.municipio_nome
        ? `Dados de ${dados.razao_social}. Informe o código IBGE de ${dados.municipio_nome} — a consulta não traz esse campo.`
        : 'Dados carregados.',
    });
  });

  const salvar = (e) => {
    e.preventDefault();
    const { id, ...corpo } = form;
    tentar(async () => {
      if (id) await api(`/tomadores/${id}`, { method: 'PUT', body: corpo });
      else await api('/tomadores', { method: 'POST', body: corpo });
      setForm(null);
    }, id ? 'Cliente atualizado.' : 'Cliente cadastrado.');
  };

  const alternarAtivo = (c) => {
    if (c.ativo && !confirm(`Inativar ${c.razao_social}?\n\nAs notas já emitidas continuam válidas — ele só deixa de aparecer para novos contratos.`)) return;
    tentar(() => c.ativo
      ? api(`/tomadores/${c.id}`, { method: 'DELETE' })
      : api(`/tomadores/${c.id}`, { method: 'PUT', body: { ativo: 1 } }),
    c.ativo ? 'Cliente inativado.' : 'Cliente reativado.');
  };

  const editar = (c) => setForm({
    ...VAZIO,
    ...Object.fromEntries(Object.keys(VAZIO).map((k) => [k, c[k] ?? ''])),
    id: c.id,
  });

  const campo = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-xl font-black">Clientes</h1>
          <p className="muted text-xs font-semibold">
            Quem paga assinatura na Stripe entra sozinho. Cadastre aqui quem só tem contrato.
          </p>
        </div>
        <input
          className="field w-56"
          placeholder="Buscar por nome ou documento"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
        {podeEditar && (
          <button className="btn btn-primary" onClick={() => setForm(form ? null : { ...VAZIO })}>
            {form ? 'Cancelar' : 'Novo cliente'}
          </button>
        )}
      </header>

      {aviso && (
        <p className={`rounded-lg px-3 py-2 text-sm font-bold ${
          aviso.tipo === 'erro' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'
        }`}>{aviso.texto}</p>
      )}

      {form && (
        <form onSubmit={salvar} className="card grid gap-3 p-5 md:grid-cols-3">
          <label className="label">CNPJ ou CPF
            <div className="flex gap-2">
              <input className="field" required value={form.documento} onChange={campo('documento')}
                disabled={Boolean(form.id)} placeholder="Só números" />
              {!form.id && (
                <button type="button" className="btn btn-subtle whitespace-nowrap"
                  onClick={buscarCnpj} disabled={ocupado}>
                  Buscar
                </button>
              )}
            </div>
            <span className="text-[0.7rem] font-semibold normal-case">
              {form.id ? 'Não editável: identifica o cliente nas notas já emitidas.' : 'Busca preenche o resto pela Receita.'}
            </span>
          </label>
          <label className="label md:col-span-2">Razão social
            <input className="field" required value={form.razao_social} onChange={campo('razao_social')} />
          </label>
          <label className="label">Nome fantasia
            <input className="field" value={form.nome_fantasia} onChange={campo('nome_fantasia')} />
          </label>
          <label className="label">Inscrição municipal
            <input className="field" value={form.inscricao_municipal} onChange={campo('inscricao_municipal')} />
          </label>
          <label className="label">E-mail
            <input className="field" type="email" value={form.email} onChange={campo('email')} />
          </label>
          <label className="label">Telefone
            <input className="field" value={form.telefone} onChange={campo('telefone')} />
          </label>
          <label className="label md:col-span-2">Logradouro
            <input className="field" value={form.logradouro} onChange={campo('logradouro')} />
          </label>
          <label className="label">Número
            <input className="field" value={form.numero} onChange={campo('numero')} />
          </label>
          <label className="label">Complemento
            <input className="field" value={form.complemento} onChange={campo('complemento')} />
          </label>
          <label className="label">Bairro
            <input className="field" value={form.bairro} onChange={campo('bairro')} />
          </label>
          <label className="label">CEP
            <input className="field" value={form.cep} onChange={campo('cep')} />
          </label>
          <label className="label">Código do município (IBGE)
            <input className="field" value={form.codigo_municipio} onChange={campo('codigo_municipio')} />
            <span className="text-[0.7rem] font-semibold normal-case">
              7 dígitos. A busca por CNPJ não traz este campo — ela devolve o código SIAFI, e a
              SEFIN exige o do IBGE.
            </span>
          </label>
          <label className="label">UF
            <input className="field" maxLength={2} value={form.uf} onChange={campo('uf')} />
          </label>
          <button className="btn btn-success md:col-span-3 md:justify-self-start" disabled={ocupado}>
            {form.id ? 'Salvar' : 'Cadastrar'}
          </button>
        </form>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Cliente</th>
              <th className="px-3 py-2">Documento</th>
              <th className="px-3 py-2">Município</th>
              <th className="px-3 py-2">E-mail</th>
              <th className="px-3 py-2">Origem</th>
              <th className="px-3 py-2">Ações</th>
            </tr>
          </thead>
          <tbody>
            {clientes?.map((c) => (
              <tr key={c.id} className={`border-b last:border-0 ${c.ativo ? '' : 'opacity-55'}`}>
                <td className="px-3 py-2 font-semibold">
                  {c.razao_social}
                  {!c.ativo && <span className="badge ml-2 bg-slate-200 text-slate-600">inativo</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{documentoFormatado(c)}</td>
                <td className="px-3 py-2 text-xs">
                  {c.codigo_municipio
                    ? `${c.codigo_municipio}${c.uf ? ` / ${c.uf}` : ''}`
                    : <span className="text-amber-700">sem código IBGE</span>}
                </td>
                <td className="px-3 py-2 text-xs">{c.email ?? '—'}</td>
                <td className="px-3 py-2">
                  <span className={`badge ${c.origem === 'stripe' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-700'}`}>
                    {c.origem}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {podeEditar && (
                    <>
                      <button className="btn py-1 text-xs" onClick={() => editar(c)}>Editar</button>
                      <button className="btn ml-1 py-1 text-xs" onClick={() => alternarAtivo(c)}>
                        {c.ativo ? 'Inativar' : 'Reativar'}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {clientes && !clientes.length && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                {busca ? 'Nenhum cliente encontrado.' : 'Nenhum cliente cadastrado.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
