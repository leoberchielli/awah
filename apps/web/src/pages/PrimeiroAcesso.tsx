import { type FormEvent, useState } from 'react'
import { Marca } from '../components/Shell'
import { ApiError, post } from '../lib/api'

/**
 * Primeira execução da instância.
 *
 * Sem esta tela, a única forma de criar a primeira organização era montar um
 * `curl` a partir do README — e essa é a trava mais cara que um projeto
 * self-hosted pode ter, porque acontece antes de a pessoa ver qualquer valor.
 *
 * A rota fecha sozinha assim que existir uma organização, então esta tela só
 * aparece uma vez na vida da instância.
 */
export function PrimeiroAcesso() {
  const [organizationName, setOrganizationName] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)

  const curta = password.length > 0 && password.length < 12

  async function criar(evento: FormEvent) {
    evento.preventDefault()
    setEnviando(true)
    setErro(null)

    try {
      await post('/v1/auth/register', { organizationName, name, email, password })
      // O registro já devolve a sessão pronta: entra direto, sem pedir login.
      window.location.assign('/sessoes')
    } catch (falha) {
      setErro(
        falha instanceof ApiError ? falha.message : 'Não consegui falar com o servidor da API.',
      )
      setEnviando(false)
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-ground px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col gap-2">
          <Marca />
          <h1 className="text-lg font-semibold text-ink">Vamos começar</h1>
          <p className="text-sm text-muted">
            Esta instância ainda está vazia. Crie a sua organização e o primeiro usuário — depois
            disso, esta tela não aparece mais e novos usuários entram por convite.
          </p>
        </div>

        <form onSubmit={criar} className="card flex flex-col gap-4 p-5">
          <Campo
            id="organizationName"
            rotulo="Nome da organização"
            placeholder="Minha Empresa"
            value={organizationName}
            onChange={setOrganizationName}
          />
          <Campo id="name" rotulo="Seu nome" autoComplete="name" value={name} onChange={setName} />
          <Campo
            id="email"
            rotulo="E-mail"
            type="email"
            autoComplete="username"
            value={email}
            onChange={setEmail}
          />
          <Campo
            id="password"
            rotulo="Senha"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            dica={curta ? 'Faltam pelo menos 12 caracteres.' : 'Pelo menos 12 caracteres.'}
            problema={curta}
          />

          {erro && (
            <p role="alert" className="rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
              {erro}
            </p>
          )}

          <button
            type="submit"
            disabled={enviando || curta}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {enviando ? 'Criando…' : 'Criar e entrar'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-muted">
          Você entra como <strong className="text-ink">owner</strong> — o único papel que pode
          promover outro owner e excluir a organização.
        </p>
      </div>
    </div>
  )
}

function Campo({
  id,
  rotulo,
  value,
  onChange,
  dica,
  problema,
  ...resto
}: {
  id: string
  rotulo: string
  value: string
  onChange: (valor: string) => void
  dica?: string
  problema?: boolean
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
      {dica && (
        <span className={problema ? 'text-xs text-crit' : 'text-xs text-muted'}>{dica}</span>
      )}
    </label>
  )
}
