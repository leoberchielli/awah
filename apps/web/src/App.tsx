import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Brand } from './components/Shell'
import { useQuery } from './hooks/useQuery'
import { useT } from './i18n'
import type { Bootstrap, Me } from './lib/api'
import { SessionProvider } from './lib/session'
import { Business } from './pages/Business'
import { FirstRun } from './pages/FirstRun'
import { Integrations } from './pages/Integrations'
import { Keys } from './pages/Keys'
import { Operations } from './pages/Operations'
import { Sessions } from './pages/Sessions'
import { SignIn } from './pages/SignIn'
import { Users } from './pages/Users'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/entrar" element={<SignIn />} />
        <Route
          path="/*"
          element={
            <Authenticated>
              <Routes>
                <Route path="/operations" element={<Operations />} />
                <Route path="/business" element={<Business />} />
                <Route path="/sessions" element={<Sessions />} />
                <Route path="/integrations" element={<Integrations />} />
                <Route path="/keys" element={<Keys />} />
                <Route path="/users" element={<Users />} />
                <Route path="*" element={<Navigate to="/operations" replace />} />
              </Routes>
            </Authenticated>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}

/**
 * The dashboard's doorman.
 *
 * The real authorization is the server's — every route already demands the
 * right permission. This only avoids showing a panel skeleton to someone who
 * will take a 401 on every call, and it sends them back to `/entrar` carrying
 * the URL they came from.
 */
function Authenticated({ children }: { children: React.ReactNode }) {
  const { data, error, settled } = useQuery<Me>('/v1/auth/me')
  /**
   * An empty instance has nowhere to send whoever arrives.
   *
   * Without this question, first access landed on a login form nobody could
   * use, with the way out hidden in a `curl` in the README.
   */
  const bootstrap = useQuery<Bootstrap>('/v1/auth/bootstrap')

  if (!settled || !bootstrap.settled) return <Loading />

  if (bootstrap.data?.needsSetup) return <FirstRun />

  if (error || !data) {
    const returnTo = `${window.location.pathname}${window.location.search}`
    return <Navigate to={`/entrar?voltar=${encodeURIComponent(returnTo)}`} replace />
  }

  return <SessionProvider value={data}>{children}</SessionProvider>
}

function Loading() {
  const t = useT()

  return (
    <div className="grid min-h-dvh place-items-center bg-ground">
      <div className="flex flex-col items-center gap-3">
        <Brand />
        <span className="text-xs text-muted">{t('app.loading')}</span>
      </div>
    </div>
  )
}
