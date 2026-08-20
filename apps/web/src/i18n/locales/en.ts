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
  'common.group': 'Group {id}',
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

  // ---- integrations ----
  'integrations.list.title': 'Connected tools',
  'integrations.list.hint':
    'AWAH is the transport. Chatwoot and Typebot have dedicated connectors; any other platform comes in through the HTTP connector. In every case the durable queue, per-chat ordering and the risk engine sit underneath.',
  'integrations.list.empty': 'No tool connected yet. Set one up below.',
  'integrations.kind.chatwoot': 'Chatwoot',
  'integrations.kind.typebot': 'Typebot',
  'integrations.kind.http': 'External platform',
  'integrations.since': 'since {when}',
  'integrations.state.error': 'Failing',
  'integrations.state.active': 'Active',
  'integrations.state.paused': 'Paused',
  'integrations.disconnect': 'Disconnect',

  // ---- business ----
  'business.activeChats': 'Active conversations',
  'business.activeChatsHint': 'With at least one message in the window',
  'business.responseRate': 'Response rate',
  'business.responseRateHint': 'Inbound conversations that got a reply',
  'business.firstReplyMedian': 'First reply · median',
  'business.firstReplyMedianHint': 'How long the customer waited before anyone spoke',
  'business.firstReplyP95': 'First reply · p95',
  'business.firstReplyP95Hint': 'The worst case that is still common',
  'business.volume': 'Conversation volume',
  'business.volumeHint':
    'Inbound and outbound side by side — a lasting imbalance is either mass outreach or a stalled queue.',
  'business.inbound': 'Received',
  'business.outbound': 'Sent',
  'business.messageTypes': 'Message types',
  'business.messageTypesHint': 'What actually travels.',
  'business.busiestChats': 'Busiest conversations',
  'business.busiestChatsHint': 'Volume per contact in the selected window.',
  'business.noChats': 'No conversation recorded in this window.',
  'type.text': 'Text',
  'type.image': 'Image',
  'type.video': 'Video',
  'type.audio': 'Audio',
  'type.document': 'Document',
  'type.sticker': 'Sticker',
  'type.location': 'Location',
  'type.contact': 'Contact',
  'type.reaction': 'Reaction',
  'type.system': 'System',

  // ---- operations ----
  'ops.connectedSessions': 'Connected sessions',
  'ops.noneRunning': 'No session running',
  'ops.ofWhatShouldRun': 'Of what should be running',
  'ops.deliveryRate': 'Delivery rate',
  'ops.ofTotal': '{delivered} of {sent}',
  'ops.latencyP95': 'p95 latency',
  'ops.latencyHint': 'From send to delivery ACK',
  'ops.inQueue': 'In queue',
  'ops.sendingNow': '{n} sending',
  'ops.heldByRisk': 'Held by risk',
  'ops.newContacts': '{n} new contacts',
  'ops.funnel': 'Delivery funnel',
  'ops.funnelHint': 'Where the message stops moving forward.',
  'ops.funnel.sent': 'Sent',
  'ops.funnel.delivered': 'Delivered',
  'ops.funnel.read': 'Read',
  'ops.funnel.failed': 'Failed',
  'ops.throughput': 'Throughput',
  'ops.throughputHint': 'Sent and received per hour.',
  'ops.throughput.outbound': 'Sent',
  'ops.throughput.inbound': 'Received',
  'ops.riskScore.avg': 'Average score',
  'ops.queue': 'Queue and retries',
  'ops.queueHint': 'State right now, not over the period.',
  'ops.queued': 'Waiting',
  'ops.sending': 'Sending',
  'ops.dead': 'Dropped',
  'ops.deadHint': 'Ran out of attempts.',
  'ops.deadWebhooks': 'Dead webhooks',
  'ops.webhooksDelivered': '{n} delivered',
  'ops.riskDecisions': 'Risk engine decisions',
  'ops.riskDecisionsHint': 'Nothing is discarded; what does not pass, waits.',
  'ops.decision.allowed': 'Allowed',
  'ops.decision.delayed': 'Delayed',
  'ops.decision.throttled': 'Throttled',
  'ops.decision.held': 'Held',
  'ops.riskScore': 'Risk score',
  'ops.riskScoreHint': '0 is calm, 100 is the edge of a ban.',
  'ops.sessionHealth': 'Session health',
  'ops.sessionHealthHint': 'MTBF comes from recorded connection events, not from a heartbeat.',
  'ops.noSessions': 'No session in this organization yet.',
  'ops.col.session': 'Session',
  'ops.col.state': 'State',
  'ops.col.drops': 'Drops',
  'ops.col.reconnects': 'Reconnects',
  'ops.col.mtbf': 'MTBF',
  'ops.col.lastCause': 'Last cause',

  // ---- sessions ----
  'sessions.title': 'Sessions',
  'sessions.hint':
    'Desired state and actual state, side by side. A gap between the two is what deserves attention.',
  'sessions.empty':
    'No session yet. Create the first one under <strong>New session</strong>, up top — then press Start and the QR shows up on its own.',
  'sessions.detail': 'Detail',
  'sessions.detailEmpty': 'Tap a session to see risk, budget and drop history.',
  'sessions.new': 'New session',
  'sessions.onNode': 'node {id}',
  'sessions.namePlaceholder': 'session name',
  'sessions.create': 'Create',
  'sessions.createFailed': 'Could not create the session.',
  'sessions.commandFailed': 'Could not send the command.',
  'sessions.shouldBeRunning': 'Should be running',
  'sessions.start': 'Start',
  'sessions.stop': 'Stop',
  'sessions.logout': 'Disconnect device',
  'engine.baileys': 'Baileys (unofficial)',
  'engine.cloudApi': 'Cloud API (official)',

  // ---- pairing ----
  'pairing.title': 'Pair "{name}"',
  'pairing.hint':
    'The code refreshes itself every few seconds. Keep this screen open until the session shows as connected.',
  'pairing.qrAlt': 'Pairing QR code',
  'pairing.step1':
    'Open WhatsApp on the phone that will answer for this session. Use a dedicated number — never your personal one.',
  'pairing.step2':
    'Tap the three dots (Android) or <strong>Settings</strong> (iPhone) and choose <strong>Linked devices</strong>.',
  'pairing.step3':
    'Tap <strong>Link a device</strong> and point the camera at the code beside this.',
  'pairing.step4':
    'As soon as the phone accepts, this panel disappears on its own and the session turns <strong>Connected</strong>.',
  'pairing.cancel': 'Cancel pairing',

  // ---- risk panel ----
  'risk.title': 'Risk and budget',
  'risk.hint': 'Nothing is discarded: what does not pass now, waits.',
  'risk.none': 'No risk reading for this session.',
  'risk.score': 'Score',
  'risk.warmup': 'Warm-up',
  'risk.ageDays': '{n} days old',
  'risk.throttled': 'Brake on: the session is sending at {rate} of its normal pace.',
  'risk.windows': 'Window usage',
  'risk.perMinute': 'Per minute',
  'risk.perHour': 'Per hour',
  'risk.perDay': 'Per day',
  'risk.newContactsToday': 'New contacts today',
  'risk.factors': 'Where the score comes from',
  'risk.factor.one_sided_conversation': '{sent} sent for {received} received in 24 h',
  'risk.factor.new_contacts': '{used} of {limit} allowed today',
  'risk.factor.delivery_failure': '{percent}% of sends did not arrive',
  'risk.factor.speed': '{used} of {limit} in the last minute',

  // ---- connection history ----
  'events.title': 'Connection history',
  'events.hint':
    'The raw protocol code next to the translated cause — that is what lets you understand a drop without reading logs.',
  'events.empty': 'No event recorded for this session.',

  // ---- connect wizards, shared ----
  'wizard.pickSession': 'WhatsApp session',
  'wizard.pickSessionPlaceholder': 'Choose the session',
  'wizard.noSessions': 'No session yet. Create one under Sessions first.',
  'wizard.optional': '(optional)',
  'wizard.apiUnreachable': 'Could not reach the API server.',
  'wizard.connectAnother': 'Connect another session',

  // ---- typebot wizard ----
  'typebot.connected': 'Typebot connected',
  'typebot.connectedHint':
    'There is nothing to configure on the other side: the gateway is what calls Typebot. Send a message to the number and the flow answers.',
  'typebot.title': 'Connect Typebot',
  'typebot.hint':
    'Automated flow. What the customer writes goes into the flow, and the answer leaves through the gateway queue — with ordering, pacing and redelivery.',
  'typebot.flowLink': 'Flow link',
  'typebot.flowLinkHint':
    'In Typebot: publish the flow and copy the link under <strong>Share</strong>. It is not the editor address — that one uses the internal id and will not work here.',
  'typebot.apiToken': 'API token',
  'typebot.apiTokenHint': 'Only needed if the flow is not public.',
  'typebot.escapeWord': 'Escape word',
  'typebot.escapeWordHint':
    'Whoever types this leaves the flow and moves to a human. Leave it empty only if there is another path to a person.',
  'typebot.handoffReply': 'Reply when someone escapes',
  'typebot.handoffReplyHint':
    'Sent the moment a customer asks for a person. Write it in the language your customers speak — this one leaves the gateway before any human sees the conversation.',
  'typebot.submit': 'Test and connect',
  'typebot.submitting': 'Testing the flow…',

  // ---- http wizard ----
  'http.connected': 'Platform connected',
  'http.connectAnother': 'Connect another',
  'http.title': 'Connect any platform',
  'http.hint':
    'The gateway posts every received message to your URL and sends back whatever the response carries. Works for n8n, Make, a serverless function or your own system.',
  'http.url': 'URL that receives the messages',
  'http.urlHint':
    'Answer with {example} for the gateway to send it, or with an empty body to only record.',
  'http.name': 'Name',
  'http.namePlaceholder': 'n8n flow',
  'http.secret': 'Signing secret',
  'http.secretHint': 'Signs the body with HMAC, same as webhooks. If the URL is public, use it.',
  'http.test': 'Test',
  'http.testing': 'Testing…',
  'http.connect': 'Connect',
  'http.connecting': 'Connecting…',
  'http.showPayload': 'Show what the gateway sends',
  'http.hidePayload': 'Hide what the gateway sends',
  'http.apiUnreachable': 'Could not reach the API.',

  // ---- chatwoot wizard ----
  'chatwoot.connected': 'Chatwoot connected',
  'chatwoot.oneStepLeft':
    'One step left: paste this URL into the <strong>Webhook URL</strong> field of your API inbox, in Chatwoot.',
  'chatwoot.webhookDone':
    'The webhook already points at the gateway — there is nothing to do in Chatwoot. Send a message to the number and it shows up in the inbox.',
  'chatwoot.title': 'Connect Chatwoot',
  'chatwoot.hint':
    'Human support. The conversation shows up in the inbox and the agent reply comes back through the gateway.',
  'chatwoot.address': 'Chatwoot address',
  'chatwoot.token': 'Access token',
  'chatwoot.tokenHint':
    'In Chatwoot: your avatar → Profile → Access token. Use an administrator token so the gateway can create the inbox on its own.',
  'chatwoot.continue': 'Continue',
  'chatwoot.talking': 'Talking to Chatwoot…',
  'chatwoot.noAccount': 'This token does not reach any Chatwoot account.',
  'chatwoot.newInbox': 'Create a new inbox',
  'chatwoot.newInboxHint':
    'The gateway creates the API inbox and points the webhook at itself. Recommended.',
  'chatwoot.existingInbox': 'Existing API inbox. Its webhook will be pointed at the gateway.',
  'chatwoot.noInbox': 'No inbox in this account yet. The new one will be the first.',
  'chatwoot.connect': 'Connect',
  'chatwoot.preparing': 'Preparing the inbox…',
  'chatwoot.inboxName': 'Inbox name',
  'chatwoot.whichAccount': 'This token reaches more than one account. Which one?',
  'chatwoot.inbox': 'Inbox',
  'http.responseBody': 'Response body',
  'wizard.stepOf': 'Step {n} of {total}',

  // ---- users ----
  'nav.users': 'Users',
  'users.list.title': 'People with access',
  'users.list.hint':
    'Everyone who can sign in to this organization. A role here decides what the person can do; API keys are separate and live under Keys.',
  'users.list.empty': 'No member yet.',
  'users.add.title': 'Add someone',
  'users.add.hint': 'They sign in with their own email and password, not with an API key.',
  'users.add.credentialsHint':
    'Name and password are only needed when the email has no account on this instance yet. If it already does, the person keeps the password they have.',
  'users.add.submit': 'Add',
  'users.adding': 'Adding…',
  'users.addFailed': 'Could not add this person. Try again.',
  'users.changeFailed': 'Could not apply the change.',
  'users.remove': 'Remove',
  'users.removing': 'Removing…',
  'users.leave': 'Leave',
  'users.you': '(you)',
  'users.joined': 'joined {when}',
  'users.lastOwner': 'Last owner',
} as const

export type TranslationKey = keyof typeof en
export type Catalog = Partial<Record<TranslationKey, string>>
