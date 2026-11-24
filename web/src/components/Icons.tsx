import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  className: `icon ${p.className ?? ''}`,
  ...p,
});

export const Back = (p: P) => (
  <svg {...base(p)}>
    <path d="M15 18l-6-6 6-6" />
  </svg>
);
export const Close = (p: P) => (
  <svg {...base(p)}>
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);
export const PlayIcon = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z" />
  </svg>
);
export const PauseIcon = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <rect x="6" y="5" width="4" height="14" rx="1.2" />
    <rect x="14" y="5" width="4" height="14" rx="1.2" />
  </svg>
);
export const SkipIcon = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M5 6.2v11.6a.8.8 0 0 0 1.25.66L14 13v4.8a.8.8 0 0 0 1.25.66l7.6-5.8a.8.8 0 0 0 0-1.32l-7.6-5.8A.8.8 0 0 0 14 6.2V11L6.25 5.54A.8.8 0 0 0 5 6.2z" />
  </svg>
);
export const SearchIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
);
export const ShareIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3v12M7 8l5-5 5 5" />
    <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
  </svg>
);
export const PodiumIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 21V9h6v12M3 21v-7h6M15 21v-5h6v5M2 21h20" />
  </svg>
);
export const Diamond = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden className={`icon diamond ${p.className ?? ''}`} {...p} fill="currentColor">
    <path d="M12 1.5c.5 3.9 1.4 6.4 3 8s4.1 2.5 7.5 2.5c-3.4 0-5.9.9-7.5 2.5s-2.5 4.1-3 8c-.5-3.9-1.4-6.4-3-8S4.9 12 1.5 12C4.9 12 7.4 11.1 9 9.5s2.5-4.1 3-8z" />
  </svg>
);
export const Check = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
export const XIcon = (p: P) => (
  <svg {...base(p)} strokeWidth={2.8}>
    <path d="M17 7L7 17M7 7l10 10" />
  </svg>
);
export const Note = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M19 3.5v11.2a3.3 3.3 0 1 1-2-3V7.1l-8 1.8v7.8a3.3 3.3 0 1 1-2-3V5.6a1 1 0 0 1 .78-.98l10-2.2A1 1 0 0 1 19 3.4z" />
  </svg>
);
export const ExternalIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);
export const Trophy = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" />
  </svg>
);
export const PlusIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const Speaker = (p: P) => (
  <svg {...base(p)}>
    <path d="M11 5L6 9H3v6h3l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
);
export const Refresh = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
  </svg>
);
