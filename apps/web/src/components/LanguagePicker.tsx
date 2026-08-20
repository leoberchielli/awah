import { LOCALES, useI18n, useT } from '../i18n'
import { cx } from './ui'

/**
 * Language picker.
 *
 * Every option is written in its own language: the person who cannot read the
 * current interface is exactly the one who has to find themselves in here.
 *
 * A native `select` rather than a custom menu, because on a phone it becomes
 * the system wheel — already accessible, already in the device's own language,
 * and already able to render scripts the page may not have a font for.
 */
export function LanguagePicker({ className }: { className?: string }) {
  const { locale, setLocale } = useI18n()
  const t = useT()

  return (
    <label className="flex items-center">
      <span className="sr-only">{t('common.language')}</span>
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value)}
        className={cx(
          'rounded-lg border border-line/70 bg-surface/60 px-2 py-[7px] text-xs text-ink backdrop-blur-sm',
          className,
        )}
      >
        {LOCALES.map((language) => (
          <option key={language.code} value={language.code}>
            {language.name}
          </option>
        ))}
      </select>
    </label>
  )
}
