const icons = {
  brand: <><path d="m4 8 8-4 8 4v8l-8 4-8-4Z"/><path d="m4 8 8 4 8-4M12 12v8"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  search: <><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>,
  history: <><path d="M3 12a9 9 0 1 1 2.7 6.4M3 7v5h5M12 7v5l3 2"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2M6 18l2-2m8-8 2-2"/><circle cx="12" cy="12" r="7"/></>,
  help: <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4.2 1.8c-1.3 1-1.7 1.3-1.7 2.7m0 3h.01"/></>,
  chevron: <path d="m6 9 6 6 6-6"/>,
  terminal: <path d="m5 7 5 5-5 5m8 0h6"/>,
  clip: <path d="m9 12 5.5-5.5a2 2 0 0 1 3 3l-7 7a3.5 3.5 0 0 1-5-5l7-7a5 5 0 0 1 7 7l-7 7"/>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m3 17 5-4 3 3 4-5 6 6"/></>,
  send: <path d="M12 19V5m-6 6 6-6 6 6"/>,
  arrow: <path d="M4 12h15m-6-6 6 6-6 6"/>,
  tool: <path d="M15 6a4 4 0 0 0-5 5L4 17a2 2 0 0 0 3 3l6-6a4 4 0 0 0 5-5l-3 3-3-3Z"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  shield: <><path d="M12 22s7-3 7-9V6l-7-3-7 3v7c0 6 7 9 7 9Z"/><path d="M12 8v5m0 3h.01"/></>,
};

export function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {icons[name]}
    </svg>
  );
}
