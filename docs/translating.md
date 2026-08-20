# Translating the dashboard

The interface ships in ten languages. Three of them — Hindi, Arabic and Russian
— are **empty on purpose** and fall back to English until a native speaker fills
them in. If you speak one of those, or a language that is not on the list at
all, this page is the whole process.

## The rule that makes this cheap

**A partial translation is a useful translation.** Every catalog is typed as a
`Partial` of the English one, so a file with twenty lines in it compiles and
ships. Keys you have not translated fall back to English rather than showing a
raw `keys.issue.title` to the user.

So there is no "finish it or don't bother". Translate the screen you care about,
open the pull request, and someone else — or you, later — takes the next one.

## Completing a language that already exists

Open `apps/web/src/i18n/locales/<code>.ts` and fill it in against
`en.ts`, which is the source of truth. Then:

```bash
pnpm i18n:check
```

```
source: en.ts — 279 keys

ar     ████████············  40%  112/279
de     ████████████████████ 100%  279/279
```

## Adding a language that is not listed

Two steps, and nothing else in the codebase needs to know.

**1.** Copy `en.ts` to `apps/web/src/i18n/locales/<code>.ts`, rename the export,
and translate what you can:

```ts
import type { Catalog } from './en'

export const sw: Catalog = {
  'nav.sessions': 'Vipindi',
  // …
}
```

**2.** Add one entry to `LOCALES` in `apps/web/src/i18n/registry.ts`:

```ts
{ code: 'sw', name: 'Kiswahili', dir: 'ltr', load: async () => (await import('./locales/sw')).sw },
```

Write `name` **in that language**, not in English — someone who cannot read the
current interface is exactly the person who has to find their own language in
the menu. Set `dir: 'rtl'` for right-to-left scripts; the layout flips on its
own.

Catalogs load on demand, one chunk each, so an eleventh language costs nothing
to anyone who does not pick it.

## What the check refuses

Missing keys are fine. Two things are not, and `pnpm i18n:check` fails the build
on both:

**Unknown keys** — a typo or a key that was removed from `en.ts`. TypeScript
catches these too.

**Lost placeholders.** If English says `'{n} days'` and your translation says
`'days'`, the number silently disappears at runtime. Nothing else catches this:
the value is still a valid string. Keep every `{name}` from the original — you
can move it anywhere in the sentence, which is the point of using placeholders
instead of gluing fragments together.

## Notes on wording

The dashboard is read by someone with an incident in their hands, so plain and
short beats formal. A few terms worth deciding once and keeping consistent
within your language:

| English | What it means here |
| --- | --- |
| session | one paired WhatsApp number, not a login session |
| held | the risk engine is delaying a message; it was not dropped |
| warm-up | the ramp that limits volume on a freshly paired number |
| outbox | the durable queue of messages waiting to be sent |
| MTBF | mean time between failures — leave the acronym if it is used in your field |

`<strong>` is the only markup a catalog may contain, and it renders as real
emphasis. Anything else appears as literal text, so a translation can never
inject markup into the page.
