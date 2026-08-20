import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Marca } from './components/Shell'
import { useQuery } from './hooks/useQuery'
import { useT } from './i18n'
import type { Bootstrap, Me } from './lib/api'
import { ProvedorDeSessao } from './lib/sessao'
import { Chaves } from './pages/Chaves'
import { Entrar } from './pages/Entrar'
import { Integracoes } from './pages/Integracoes'
import { Negocio } from './pages/Negocio'
import { Operacao } from './pages/Operacao'
import { PrimeiroAcesso } from './pages/PrimeiroAcesso'
import { Sessoes } from './pages/Sessoes'
import { Users } from './pages/Users'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/entrar" element={<Entrar />} />
        <Route
          path="/*"
          element={
            <Autenticado>
              <Routes>
                <Route path="/operations" element={<Operacao />} />
                <Route path="/business" element={<Negocio />} />
                <Route path="/sessions" element={<Sessoes />} />
                <Route path="/integrations" element={<Integracoes />} />
                <Route path="/keys" element={<Chaves />} />
                <Route path="/users" element={<Users />} />
                <Route path="*" element={<Navigate to="/operations" replace />} />
              </Routes>
            </Autenticado>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}

/**
 * Porteiro do dashboard.
 *
 * A verdadeira autorização é do servidor — toda rota já exige a permissão certa.
 * Isto aqui só evita mostrar um esqueleto de painel para quem vai levar 401 em
 * cada chamada, e o retorno é para `/entrar` levando a URL de origem junto.
 */
function Autenticado({ children }: { children: React.ReactNode }) {
  const { data, error, settled } = useQuery<Me>('/v1/auth/me')
  /**
   * Instância vazia não tem para onde mandar quem chega.
   *
   * Sem esta pergunta, o primeiro acesso caía num formulário de login que
   * ninguém conseguia usar, com a saída escondida num `curl` do README.
   */
  const bootstrap = useQuery<Bootstrap>('/v1/auth/bootstrap')

  if (!settled || !bootstrap.settled) return <Carregando />

  if (bootstrap.data?.needsSetup) return <PrimeiroAcesso />

  if (error || !data) {
    const destino = `${window.location.pathname}${window.location.search}`
    return <Navigate to={`/entrar?voltar=${encodeURIComponent(destino)}`} replace />
  }

  return <ProvedorDeSessao value={data}>{children}</ProvedorDeSessao>
}

function Carregando() {
  const t = useT()

  return (
    <div className="grid min-h-dvh place-items-center bg-ground">
      <div className="flex flex-col items-center gap-3">
        <Marca />
        <span className="text-xs text-muted">{t('app.loading')}</span>
      </div>
    </div>
  )
}
