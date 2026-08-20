/**
 * English catalog — the source of truth.
 *
 * Every other locale is typed as a `Partial` of this one, so a half-finished
 * translation still compiles and still ships: a missing key falls back to the
 * English string instead of rendering a raw key at the user. That is the whole
 * reason someone can open a pull request with 20 lines translated and have it
 * be useful.
 *
 * Keys are dotted and grouped by screen. Placeholders are `{name}` and are
 * replaced verbatim — never build a sentence by concatenating fragments, since
 * word order changes between languages.
 */
export const en = {
  // ---- shared ----
  'app.tagline': 'WhatsApp gateway with a durable queue, a risk engine and clustered sessions.',
  'app.loading': 'Loading…',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.save': 'Save',
  'common.remove': 'Remove',
  'common.removing': 'Removing…',
  'common.none': '—',
  'common.session': 'Session',
  'common.allSessions': 'All sessions',
  'common.filterBySession': 'Filter by session',
  'common.apiDocs': 'API documentation',
  'common.signOut': 'Sign out',
  'common.sections': 'Sections',
  'common.timeWindow': 'Time window',
  'common.theme': 'Theme',
  'common.language': 'Language',
  'common.themeLight': 'Light',
  'common.themeSystem': 'System',
  'common.themeDark': 'Dark',
  'common.noDataInWindow': 'No data in the selected window.',
  // Unit is separate from the number because it is not "h" everywhere.
  'window.hours': '{n} h',
  'window.days': '{n} d',

  // ---- navigation ----
  'nav.operation': 'Operations',
  'nav.business': 'Business',
  'nav.sessions': 'Sessions',
  'nav.integrations': 'Integrations',
  'nav.keys': 'Keys',

  // ---- session status ----
  'status.connected': 'Connected',
  'status.connecting': 'Connecting',
  'status.pairing': 'Pairing',
  'status.created': 'Created',
  'status.disconnected': 'Disconnected',
  'status.logged_out': 'Logged out',
  'status.banned': 'Banned',

  // ---- sign in ----
  'login.email': 'Email',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.submitting': 'Signing in…',
  'login.noAccount': 'No account? Ask whoever administers this instance for an invite.',
  'login.failed': 'Email or password is incorrect.',

  // ---- first run ----
  'setup.title': 'Let’s get started',
  'setup.hint':
    'This instance is still empty. Create your organization and the first user — after that this screen never appears again, and new users join by invitation.',
  'setup.orgName': 'Organization name',
  'setup.yourName': 'Your name',
  'setup.passwordHint': 'At least 12 characters.',
  'setup.submit': 'Create and sign in',
  'setup.submitting': 'Creating…',
  'setup.orgPlaceholder': 'My Company',
  'setup.passwordShort': 'At least 12 characters — a few more to go.',
  'setup.ownerNote':
    'You sign in as <strong>owner</strong> — the only role that can promote another owner and delete the organization.',
  'setup.apiUnreachable': 'Could not reach the API server.',

  // ---- keys ----
  'keys.gate':
    'Issuing and revoking keys is identity administration, reserved for administrators. Ask whoever administers the organization.',
  'keys.issue.title': 'Issue key',
  'keys.issue.hint':
    'For your own server, n8n, Make, or anything that calls the API without a browser in the middle.',
  'keys.field.name': 'Name',
  'keys.field.namePlaceholder': 'CRM outreach',
  'keys.field.nameHint':
    'This is how you will know what to revoke later. Use the name of the system that will hold it, not "key 1".',
  'keys.field.role': 'Role',
  'keys.field.roleHint':
    'No role lets a key create another key or touch members. That takes a person signing in, so that a leaked key never becomes account takeover.',
  'keys.role.viewer': 'Read only',
  'keys.role.viewerSummary': 'reads messages and metrics; sends nothing',
  'keys.role.operator': 'Operator',
  'keys.role.operatorSummary': 'sends messages and starts or stops sessions',
  'keys.role.admin': 'Administrator',
  'keys.role.adminSummary': 'also creates sessions and webhooks',
  'keys.role.owner': 'Owner',
  'keys.role.ownerSummary': 'everything an administrator can do',
  'keys.field.scope': 'Reach',
  'keys.scope.whole': 'The whole organization',
  'keys.scope.wholeHint': 'Valid for any session, including the ones you create later.',
  'keys.scope.picked': 'Only the sessions I pick',
  'keys.scope.pickedHint':
    'Outside its scope the key gets a 404 — the same answer a session that does not exist would get.',
  'keys.scope.noSessions':
    'No sessions yet. Create one under Sessions, or let the key cover the whole organization.',
  'keys.scope.empty': 'Pick at least one session. A key with an empty scope would reach none.',
  'keys.field.expiry': 'Expiry',
  'keys.expiry.never': 'Never expires',
  'keys.expiry.days': '{n} days',
  'keys.expiry.year': '1 year',
  'keys.submit': 'Issue key',
  'keys.submitting': 'Issuing…',
  'keys.failed': 'The key could not be issued. Try again.',
  'keys.created.title': 'Key "{name}" created',
  'keys.created.warning':
    'Copy it now. This is the only time the key is shown — the server keeps only its hash.',
  'keys.created.copy': 'Copy',
  'keys.created.copied': 'Copied',
  'keys.created.done': 'I saved it',
  'keys.created.copyFailed':
    'The browser blocked the copy. Select the text above and copy it by hand.',
  'keys.created.storage':
    'Keep it in a secrets manager or an environment variable on your server. It travels as {header}.',
  'keys.list.title': 'Issued keys',
  'keys.list.hint':
    'An API key is a server credential: it sends messages on behalf of the organization. Never put one in code that runs in a browser.',
  'keys.list.empty': 'No keys issued yet.',
  'keys.state.active': 'Active',
  'keys.state.revoked': 'Revoked',
  'keys.state.expired': 'Expired',
  'keys.revoke': 'Revoke',
  'keys.revoking': 'Revoking…',
  'keys.usedAgo': 'used {when}',
  'keys.neverUsed': 'never used',
  'keys.expiresOn': 'expires {when}',
} as const

export type TranslationKey = keyof typeof en
export type Catalog = Partial<Record<TranslationKey, string>>
