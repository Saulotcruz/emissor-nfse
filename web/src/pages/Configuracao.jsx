import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import Mfa from '../components/Mfa.jsx';

const REGIMES = [
  ['lucro_presumido', 'Lucro Presumido'],
  ['lucro_real', 'Lucro Real'],
  ['simples_nacional', 'Simples Nacional'],
];

const TRIBUTACAO_ISSQN = [
  ['operacao_tributavel', 'Operação tributável'],
  ['imunidade', 'Imunidade'],
  ['exportacao', 'Exportação de serviço'],
  ['nao_incidencia', 'Não incidência'],
];

// CST do PIS/COFINS aceito pelo schema; 01 é o caso do Lucro Presumido.
const SITUACAO_PIS_COFINS = [
  ['STANDARD_TAXABLE_OPERATION', '01 — Operação tributável com alíquota básica'],
  ['NENHUM', '00 — Nenhum'],
];

export default function Configuracao() {
  const { user } = useAuth();
  const admin = user?.papel === 'admin';

  const [emitente, setEmitente] = useState(null);
  const [servicos, setServicos] = useState([]);
  const [certificado, setCertificado] = useState(null);
  const [aviso, setAviso] = useState(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    Promise.all([api('/config/emitente'), api('/config/servicos'), api('/config/certificado')])
      .then(([e, s, c]) => {
        setEmitente(e.emitente);
        setServicos(s.servicos);
        setCertificado(c);
      })
      .catch((err) => setAviso({ tipo: 'erro', texto: err.message }));
  }, []);

  async function salvarEmitente(ev) {
    ev.preventDefault();
    setSalvando(true);
    setAviso(null);
    try {
      const d = await api('/config/emitente', { method: 'PUT', body: emitente });
      setEmitente(d.emitente);
      setAviso({ tipo: 'ok', texto: 'Dados da empresa salvos.' });
    } catch (e) {
      setAviso({ tipo: 'erro', texto: e.message });
    } finally {
      setSalvando(false);
    }
  }

  async function salvarServico(ev, servico) {
    ev.preventDefault();
    setSalvando(true);
    setAviso(null);
    try {
      const d = await api(`/config/servicos/${servico.id}`, { method: 'PUT', body: servico });
      setServicos((atual) => atual.map((s) => (s.id === d.servico.id ? d.servico : s)));
      setAviso({ tipo: 'ok', texto: 'Tributação salva. Vale para as próximas notas emitidas.' });
    } catch (e) {
      setAviso({ tipo: 'erro', texto: e.message });
    } finally {
      setSalvando(false);
    }
  }

  function alterarServico(id, campo, valor) {
    setServicos((atual) => atual.map((s) => (s.id === id ? { ...s, [campo]: valor } : s)));
  }

  if (!emitente) {
    return <p className="muted font-semibold">{aviso?.texto ?? 'Carregando…'}</p>;
  }

  const ehProducao = emitente.ambiente === 'producao';

  return (
    <div className="grid gap-4">
      {/* Segurança da conta vem antes dos dados fiscais: é o que protege todo
          o resto. */}
      <Mfa />
      <div>
        <h1 className="text-xl font-black">Configuração</h1>
        <p className="muted text-sm font-semibold">
          Dados fiscais da empresa, tributação e certificado
        </p>
      </div>

      {aviso && (
        <p className={`rounded-lg px-3 py-2 text-sm font-bold ${aviso.tipo === 'erro' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>
          {aviso.texto}
        </p>
      )}
      {!admin && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900">
          Somente administradores alteram a configuração fiscal. Você pode consultar.
        </p>
      )}

      {/* Empresa */}
      <form onSubmit={salvarEmitente} className="card grid gap-3 p-5">
        <h2 className="text-base font-black">Empresa</h2>

        <div className="grid gap-3 sm:grid-cols-3">
          {/* CNPJ, série e ambiente não se editam aqui: trocar CNPJ é outra
              empresa, e mexer na série no meio da operação quebra a numeração
              da DPS. O ambiente muda por comando, com confirmação. */}
          <Leitura t="CNPJ" v={emitente.cnpj} />
          <Leitura t="Série da DPS" v={`${emitente.serie_dps} · próxima nº ${emitente.proximo_numero_dps}`} />
          <Leitura
            t="Ambiente"
            v={ehProducao ? 'Produção' : 'Produção Restrita'}
            alerta={!ehProducao}
          />
        </div>
        <p className="muted text-xs font-semibold">
          CNPJ, série e ambiente não são editáveis aqui. Trocar o CNPJ é outra empresa; mexer na
          série no meio da operação quebra a numeração da DPS. O ambiente muda por
          <code className="mx-1">npm run ambiente</code>, que pede confirmação.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Campo t="Razão social" v={emitente.razao_social} onChange={(v) => setEmitente({ ...emitente, razao_social: v })} disabled={!admin} />
          <Campo t="Nome fantasia" v={emitente.nome_fantasia} onChange={(v) => setEmitente({ ...emitente, nome_fantasia: v })} disabled={!admin} />
          <Campo t="Inscrição municipal" v={emitente.inscricao_municipal} onChange={(v) => setEmitente({ ...emitente, inscricao_municipal: v })} disabled={!admin} dica="Opcional no Portal Nacional" />
          <Campo t="Código do município (IBGE)" v={emitente.codigo_municipio} onChange={(v) => setEmitente({ ...emitente, codigo_municipio: v })} disabled={!admin} dica="7 dígitos" />
          <Campo t="CNAE" v={emitente.cnae} onChange={(v) => setEmitente({ ...emitente, cnae: v })} disabled={!admin} dica="7 dígitos, sem pontuação" />
          <label className="label">
            Regime tributário
            <select className="field" value={emitente.regime_tributario} disabled={!admin}
              onChange={(e) => setEmitente({ ...emitente, regime_tributario: e.target.value })}>
              {REGIMES.map(([v, r]) => <option key={v} value={v}>{r}</option>)}
            </select>
          </label>
          <label className="label">
            Optante pelo Simples Nacional
            <select className="field" value={emitente.optante_simples_nacional ? '1' : '0'} disabled={!admin}
              onChange={(e) => setEmitente({ ...emitente, optante_simples_nacional: Number(e.target.value) })}>
              <option value="0">Não</option>
              <option value="1">Sim</option>
            </select>
          </label>
          <Campo t="Regime especial" v={emitente.regime_especial} onChange={(v) => setEmitente({ ...emitente, regime_especial: v })} disabled={!admin} dica="0 = nenhum" />
        </div>

        <h3 className="mt-2 text-sm font-black uppercase text-[var(--glink-muted)]">Endereço</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Campo t="Logradouro" v={emitente.logradouro} onChange={(v) => setEmitente({ ...emitente, logradouro: v })} disabled={!admin} />
          <Campo t="Número" v={emitente.numero} onChange={(v) => setEmitente({ ...emitente, numero: v })} disabled={!admin} />
          <Campo t="Complemento" v={emitente.complemento} onChange={(v) => setEmitente({ ...emitente, complemento: v })} disabled={!admin} />
          <Campo t="Bairro" v={emitente.bairro} onChange={(v) => setEmitente({ ...emitente, bairro: v })} disabled={!admin} />
          <Campo t="CEP" v={emitente.cep} onChange={(v) => setEmitente({ ...emitente, cep: v })} disabled={!admin} />
          <Campo t="UF" v={emitente.uf} onChange={(v) => setEmitente({ ...emitente, uf: v })} disabled={!admin} />
          <Campo t="E-mail" v={emitente.email} onChange={(v) => setEmitente({ ...emitente, email: v })} disabled={!admin} />
          <Campo t="Telefone" v={emitente.telefone} onChange={(v) => setEmitente({ ...emitente, telefone: v })} disabled={!admin} />
        </div>

        <p className="muted text-xs font-semibold">
          Com o emitente sendo o próprio prestador, a SEFIN preenche nome e endereço a partir do
          cadastro dela e recusa esses dados no XML. O que você informa aqui vale para a
          operação interna e para os avisos.
        </p>

        {admin && (
          <div className="flex justify-end">
            <button className="btn btn-primary" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar empresa'}</button>
          </div>
        )}
      </form>

      {/* Serviços e tributação */}
      {servicos.map((s) => (
        <form key={s.id} onSubmit={(e) => salvarServico(e, s)} className="card grid gap-3 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-black">Serviço {s.codigo_tributacao_nacional}</h2>
            {Boolean(s.padrao) && <span className="status-badge">padrão</span>}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Campo t="Código de tributação nacional" v={s.codigo_tributacao_nacional} onChange={(v) => alterarServico(s.id, 'codigo_tributacao_nacional', v)} disabled={!admin} dica="6 dígitos, ex.: 010501" />
            <Campo t="Descrição" v={s.descricao} onChange={(v) => alterarServico(s.id, 'descricao', v)} disabled={!admin} />
            <Campo t="Código NBS" v={s.codigo_nbs} onChange={(v) => alterarServico(s.id, 'codigo_nbs', v)} disabled={!admin} dica="Opcional" />
            <label className="label">
              Tipo de tributação do ISSQN
              <select className="field" value={s.tipo_tributacao_issqn} disabled={!admin}
                onChange={(e) => alterarServico(s.id, 'tipo_tributacao_issqn', e.target.value)}>
                {TRIBUTACAO_ISSQN.map(([v, r]) => <option key={v} value={v}>{r}</option>)}
              </select>
            </label>
          </div>

          <h3 className="mt-2 text-sm font-black uppercase text-[var(--glink-muted)]">ISSQN</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Campo t="Alíquota ISS (%)" v={s.aliquota_iss} onChange={(v) => alterarServico(s.id, 'aliquota_iss', v)} disabled={!admin} tipo="number" />
            <label className="label">
              ISS retido pelo tomador
              <select className="field" value={s.iss_retido ? '1' : '0'} disabled={!admin}
                onChange={(e) => alterarServico(s.id, 'iss_retido', Number(e.target.value))}>
                <option value="0">Não retido</option>
                <option value="1">Retido</option>
              </select>
            </label>
          </div>

          <h3 className="mt-2 text-sm font-black uppercase text-[var(--glink-muted)]">
            PIS e COFINS da operação
          </h3>
          {/* A distinção mais fácil de errar do sistema inteiro: estas alíquotas
              são informadas na nota; as de retenção, abaixo, saem do valor a
              receber. Trocar uma pela outra emite nota com retenção indevida. */}
          <p className="muted text-xs font-semibold">
            Alíquotas da operação própria. Aparecem na nota como “Débito Apuração Própria” e
            <strong> não</strong> reduzem o valor a receber.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="label">
              Situação tributária
              <select className="field" value={s.situacao_pis_cofins} disabled={!admin}
                onChange={(e) => alterarServico(s.id, 'situacao_pis_cofins', e.target.value)}>
                {SITUACAO_PIS_COFINS.map(([v, r]) => <option key={v} value={v}>{r}</option>)}
              </select>
            </label>
            <Campo t="Alíquota PIS (%)" v={s.aliquota_pis} onChange={(v) => alterarServico(s.id, 'aliquota_pis', v)} disabled={!admin} tipo="number" />
            <Campo t="Alíquota COFINS (%)" v={s.aliquota_cofins} onChange={(v) => alterarServico(s.id, 'aliquota_cofins', v)} disabled={!admin} tipo="number" />
          </div>

          <h3 className="mt-2 text-sm font-black uppercase text-[var(--glink-muted)]">
            Retenção na fonte
          </h3>
          <p className="muted text-xs font-semibold">
            Preencha apenas o que o tomador retém. Estes valores <strong>são descontados</strong>
            {' '}do valor a receber. Deixe zerado se não há retenção.
          </p>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Campo t="PIS retido (%)" v={s.ret_pis} onChange={(v) => alterarServico(s.id, 'ret_pis', v)} disabled={!admin} tipo="number" />
            <Campo t="COFINS retido (%)" v={s.ret_cofins} onChange={(v) => alterarServico(s.id, 'ret_cofins', v)} disabled={!admin} tipo="number" />
            <Campo t="CSLL retido (%)" v={s.ret_csll} onChange={(v) => alterarServico(s.id, 'ret_csll', v)} disabled={!admin} tipo="number" />
            <Campo t="INSS retido (%)" v={s.ret_inss} onChange={(v) => alterarServico(s.id, 'ret_inss', v)} disabled={!admin} tipo="number" />
            <Campo t="IR retido (%)" v={s.ret_ir} onChange={(v) => alterarServico(s.id, 'ret_ir', v)} disabled={!admin} tipo="number" />
          </div>

          {admin && (
            <div className="flex justify-end">
              <button className="btn btn-primary" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar tributação'}</button>
            </div>
          )}
        </form>
      ))}

      {/* Certificado */}
      <div className="card grid gap-3 p-5">
        <h2 className="text-base font-black">Certificado digital</h2>
        {certificado?.certificado ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Leitura t="Titular" v={certificado.certificado.titular} />
            <Leitura t="Válido até" v={String(certificado.certificado.valido_ate ?? '').slice(0, 10)} />
            <Leitura
              t="Dias restantes"
              v={certificado.dias_para_vencer ?? '—'}
              alerta={certificado.dias_para_vencer !== null && certificado.dias_para_vencer <= 30}
            />
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Leitura t="Arquivo configurado" v={certificado?.caminho_configurado ?? '—'} />
            <Leitura t="Senha configurada" v={certificado?.senha_configurada ? 'sim' : 'não'} alerta={!certificado?.senha_configurada} />
          </div>
        )}
        <p className="muted text-xs font-semibold">
          Hoje o certificado é instalado no servidor e a senha vive no <code>.env</code>. O envio
          pela interface, com a senha cifrada no banco, está previsto e virá com autenticação de
          dois fatores — é a operação que mais amplia o risco do sistema.
        </p>
      </div>
    </div>
  );
}

function Campo({ t, v, onChange, disabled, dica, tipo = 'text' }) {
  return (
    <label className="label">
      {t}
      <input
        className="field"
        type={tipo}
        step={tipo === 'number' ? '0.00001' : undefined}
        value={v ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {dica && <span className="text-[0.7rem] font-semibold normal-case">{dica}</span>}
    </label>
  );
}

function Leitura({ t, v, alerta }) {
  return (
    <div>
      <p className="label">{t}</p>
      <p className={`font-bold ${alerta ? 'text-amber-700' : ''}`}>{v ?? '—'}</p>
    </div>
  );
}
