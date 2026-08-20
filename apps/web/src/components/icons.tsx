/**
 * Icons drawn by hand, not a library.
 *
 * There are ten; an icon dependency would bring thousands and a tree-shaking
 * step to deliver exactly these ten.
 */
import type { SVGProps } from 'react'

const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

type Props = SVGProps<SVGSVGElement>

export const IconePulso = (p: Props) => (
  <svg {...base} {...p} aria-hidden>
    <path d="M3 12h4l2.5-7 4 14 2.5-7H21" />
  </svg>
)

export const IconeNegocio = (p: Props) => (
  <svg {...base} {...p} aria-hidden>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </svg>
)

export const IconeSessao = (p: Props) => (
  <svg {...base} {...p} aria-hidden>
    <rect x="4" y="2.5" width="16" height="19" rx="3" />
    <path d="M10 18.5h4" />
  </svg>
)

export const IconeSol = (p: Props) => (
  <svg {...base} {...p} aria-hidden>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
)

export const IconeLua = (p: Props) => (
  <svg {...base} {...p} aria-hidden>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </svg>
)

export const IconeMonitor = (p: Props) => (
  <svg {...base} {...p} aria-hidden>
    <rect x="2.5" y="4" width="19" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
)

export const IconeSair = (p: Props) => (
  <svg {...base} {...p} aria-hidden>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
  </svg>
)

export const IconeLigacao = (p: Props) => (
  <svg {...base} {...p} aria-hidden>
    <path d="M10 13.5a4.5 4.5 0 0 0 6.6.6l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5" />
    <path d="M14 10.5a4.5 4.5 0 0 0-6.6-.6l-2.6 2.6a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5" />
  </svg>
)

export const IconeChave = (p: Props) => (
  <svg {...base} {...p} aria-hidden>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="M10.8 12.2 20.5 2.5M16 7l3 3 2.5-2.5-3-3" />
  </svg>
)

export const IconePessoas = (p: Props) => (
  <svg {...base} {...p} aria-hidden>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 5.2a3.5 3.5 0 0 1 0 5.6M18 14.3a6.5 6.5 0 0 1 3.5 5.7" />
  </svg>
)
