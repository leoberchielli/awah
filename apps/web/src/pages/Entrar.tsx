import { type FormEvent, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LanguagePicker } from '../components/LanguagePicker'
import { Marca } from '../components/Shell'
import { useQuery } from '../hooks/useQuery'
import { useT } from '../i18n'
import type { Bootstrap } from '../lib/api'
import { ApiError, post } from '../lib/api'
import { PrimeiroAcesso } from './PrimeiroAcesso'

/**
 * Entrada do dashboard.
 *
 * Só usuário e senha: chave de API nunca entra aqui. Uma chave colada no
 * navegador fica ao alcance de qualquer extensão instalada, e ela é a credencial
 * que envia mensagem em nome de todas as sessões da organização.
 */
export function Entrar() {
  const t = useT()
  const [params] = useSearchParams()
  // Quem abre /entrar numa instância vazia precisa da tela de setup, não do login.
  const bootstrap = useQuery<Bootstrap>('/v1/auth/bootstrap')
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)

  async function enviar(evento: FormEvent) {
    evento.preventDefault()
    setEnviando(true)
    setErro(null)

    try {
      await post('/v1/auth/login', { email, password: senha })
      const voltar = params.get('voltar')
      window.location.assign(voltar?.startsWith('/') ? voltar : '/operacao')
    } catch (falha) {
      setErro(falha instanceof ApiError ? falha.message : t('login.failed'))
      setEnviando(false)
    }
  }

  if (bootstrap.data?.needsSetup) return <PrimeiroAcesso />

  return (
    <div className="grid min-h-dvh place-items-center bg-ground px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col gap-2">
          {/* O seletor vem antes do formulário: quem não lê o idioma detectado
              precisa trocá-lo aqui, e não depois de conseguir entrar. */}
          <div className="flex items-start justify-between gap-3">
            <Marca />
            <LanguagePicker />
          </div>
          <p className="text-sm text-muted">{t('app.tagline')}</p>
        </div>

        <form onSubmit={enviar} className="card flex flex-col gap-4 p-5">
          <Campo
            id="email"
            rotulo={t('login.email')}
            type="email"
            autoComplete="username"
            value={email}
            onChange={setEmail}
          />
          <Campo
            id="senha"
            rotulo={t('login.password')}
            type="password"
            autoComplete="current-password"
            value={senha}
            onChange={setSenha}
          />

          {erro && (
            <p role="alert" className="rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
              {erro}
            </p>
          )}

          <button
            type="submit"
            disabled={enviando}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {enviando ? t('login.submitting') : t('login.submit')}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-muted">{t('login.noAccount')}</p>
      </div>
    </div>
  )
}

function Campo({
  id,
  rotulo,
  value,
  onChange,
  ...resto
}: {
  id: string
  rotulo: string
  value: string
  onChange: (valor: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'id'>) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5">
      <span className="eyebrow">{rotulo}</span>
      <input
        id={id}
        required
        value={value}
        onChange={(evento) => onChange(evento.target.value)}
        className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-muted"
        {...resto}
      />
    </label>
  )
}
