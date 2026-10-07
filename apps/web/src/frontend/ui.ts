export function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector)
  if (found === null) throw new Error(`Missing frontend element: ${selector}`)
  return found
}

export function escape(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char
  })
}

export function formText(data: FormData, name: string): string {
  const value = data.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

const paths: Record<string, string> = {
  arrow: '<path d="M5 19 19 5M5 5h14v14"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  pipeline:
    '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="14" rx="1"/>',
  contacts:
    '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2"/>',
  tasks: '<rect x="4" y="4" width="16" height="17" rx="3"/><path d="M9 3h6v4H9zM8 13l2 2 5-5"/>',
  conversations:
    '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3v-9a8 8 0 0 1 8-8h2a8 8 0 0 1 8 6Z"/><path d="M8 11h8m-8 4h5"/>',
  knowledge: '<path d="M12 6c-3-3-7-3-10-2v15c4-1 7 0 10 2 3-2 6-3 10-2V4c-3-1-7-1-10 2Zm0 0v15"/>',
  connections:
    '<path d="m10 13 4-4m-6 7-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 0)"/>',
  spark: '<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z"/>',
  orders: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8m-8 4h8m-8 4h5"/>',
  inventory: '<path d="m12 3 9 5v8l-9 5-9-5V8l9-5Zm0 9v9M3 8l9 4 9-4M7 5.8l9 5"/>',
  invoices: '<path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3Zm4 5h6m-6 4h6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  moon: '<path d="M20 14a8 8 0 1 1-10-10 7 7 0 0 0 10 10Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18Z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="15" cy="17" r="3" fill="currentColor"/>',
  back: '<path d="m12 5-7 7 7 7M5 12h15"/>',
}

export function icon(name: string, className = ''): string {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths['spark']}</svg>`
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(message: string): void {
  const host = element('#toast')
  host.textContent = message
  host.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    host.hidden = true
  }, 4200)
}

export function readLocal(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as unknown
  } catch {
    return null
  }
}

export function writeLocal(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}
