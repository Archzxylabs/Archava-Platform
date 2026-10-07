import { element, toast, writeLocal, readLocal, formText } from './ui.js'

const motionPreference = matchMedia('(prefers-reduced-motion: reduce)')
let motionEnabled = !motionPreference.matches && readLocal('archava:motion') !== false
const motionButton = element<HTMLButtonElement>('#motion-toggle')
function setMotion(): void {
  document.documentElement.classList.toggle('motion-off', !motionEnabled)
  motionButton.setAttribute('aria-pressed', String(motionEnabled))
  motionButton.textContent = motionEnabled
    ? 'Motion on'
    : motionPreference.matches
      ? 'Motion off · system'
      : 'Motion off'
}
setMotion()
motionButton.addEventListener('click', () => {
  motionEnabled = !motionPreference.matches && !motionEnabled
  writeLocal('archava:motion', motionEnabled)
  setMotion()
  updateStory()
})
motionPreference.addEventListener('change', () => {
  motionEnabled = !motionPreference.matches && readLocal('archava:motion') !== false
  setMotion()
  updateStory()
})

const menuButton = element<HTMLButtonElement>('#menu-toggle')
function closeMenu(): void {
  element('#site-links').classList.remove('is-open')
  menuButton.setAttribute('aria-expanded', 'false')
  menuButton.setAttribute('aria-label', 'Open navigation')
}
menuButton.addEventListener('click', () => {
  const open = element('#site-links').classList.toggle('is-open')
  menuButton.setAttribute('aria-expanded', String(open))
  menuButton.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation')
})
element('#site-links').addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('a')) closeMenu()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu()
})

document.documentElement.classList.add('motion-ready')
const reveals = new IntersectionObserver(
  (entries, observer) => {
    for (const entry of entries)
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible')
        observer.unobserve(entry.target)
      }
  },
  { threshold: 0.08 },
)
document.querySelectorAll('.reveal').forEach((node) => reveals.observe(node))
const art = element('#hero-art')
const artVisibility = new IntersectionObserver((entries) => {
  art.classList.toggle('motion-paused', !entries.some((entry) => entry.isIntersecting))
})
artVisibility.observe(art)
art.addEventListener('pointermove', (event) => {
  if (!motionEnabled || event.pointerType !== 'mouse') return
  const bounds = art.getBoundingClientRect()
  art.style.setProperty(
    '--tilt-x',
    `${((event.clientX - bounds.left) / bounds.width - 0.5) * 8}deg`,
  )
  art.style.setProperty(
    '--tilt-y',
    `${((event.clientY - bounds.top) / bounds.height - 0.5) * -8}deg`,
  )
})
art.addEventListener('pointerleave', () => {
  art.style.setProperty('--tilt-x', '0deg')
  art.style.setProperty('--tilt-y', '0deg')
})

const chapters = [
  {
    title: 'One question.<br /><em>A whole new possibility.</em>',
    description:
      'Every opportunity starts with someone reaching out. Archava helps you meet them there.',
  },
  {
    title: 'A little context.<br /><em>A clearer next step.</em>',
    description:
      'The conversation becomes a brief. Your team gets the need, the source, and the person behind it.',
  },
  {
    title: 'The right handoff.<br /><em>Good work begins.</em>',
    description:
      'Review the next step, assign an owner, and keep the opportunity moving in your workspace.',
  },
] as const
let chapter = -1,
  scrollQueued = false
const mobile = matchMedia('(max-width: 800px)')
function updateStory(): void {
  const story = element('#story'),
    bounds = story.getBoundingClientRect()
  const progress = Math.max(0, Math.min(1, -bounds.top / Math.max(1, bounds.height - innerHeight)))
  const next = !motionEnabled || mobile.matches ? 0 : Math.min(2, Math.floor(progress * 3))
  if (next === chapter) return
  chapter = next
  const content = chapters[next]
  if (content === undefined) return
  element('.story-sticky').dataset.chapter = String(next)
  element('#story-title').innerHTML = content.title
  element('#story-description').textContent = content.description
  document.querySelectorAll('.story-progress li').forEach((li, index) => {
    li.classList.toggle('active', index === next)
    if (index === next) li.setAttribute('aria-current', 'step')
    else li.removeAttribute('aria-current')
  })
}
addEventListener(
  'scroll',
  () => {
    if (scrollQueued) return
    scrollQueued = true
    requestAnimationFrame(() => {
      updateStory()
      scrollQueued = false
    })
  },
  { passive: true },
)
addEventListener('resize', updateStory, { passive: true })
updateStory()

const presenceContent = {
  chat: {
    title: 'A good answer.<br />A better next step.',
    description:
      'A conversation that feels at home on your website. Help customers find what they need, capture their interest, and bring your team into the loop.',
    benefits: [
      'Fits into your existing website',
      'Answers grounded in your business',
      'A clear handoff to your team',
    ],
  },
  voice: {
    title: 'Less typing.<br />More connection.',
    description:
      'Let customers ask in their own words. A spoken conversation can make a first enquiry feel easy, while the team receives the context to continue.',
    benefits: [
      'Natural spoken conversations',
      'Chat included in the experience',
      'The same context for your team',
    ],
  },
  human: {
    title: 'A face for<br />your first hello.',
    description:
      'Give your business a visible digital presence. An assistant your customers can see and speak to, shaped around your services and your brand.',
    benefits: [
      'A visible digital human',
      'Voice and chat included',
      'A presence that follows your brand',
    ],
  },
} as const
const presenceTabs = [...document.querySelectorAll<HTMLButtonElement>('[data-presence]')]
function selectPresence(index: number, focus = false): void {
  const selected = presenceTabs[index]?.dataset.presence
  if (selected !== 'chat' && selected !== 'voice' && selected !== 'human') return
  presenceTabs.forEach((tab, at) => {
    tab.setAttribute('aria-selected', String(at === index))
    tab.tabIndex = at === index ? 0 : -1
    element(`#presence-${tab.dataset.presence ?? 'chat'}`).hidden = at !== index
  })
  const content = presenceContent[selected]
  element('#presence-title').innerHTML = content.title
  element('#presence-description').textContent = content.description
  const benefits = element('#presence-benefits')
  benefits.replaceChildren(
    ...content.benefits.map((text) => {
      const li = document.createElement('li')
      li.textContent = text
      return li
    }),
  )
  if (focus) presenceTabs[index]?.focus()
}
presenceTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectPresence(index))
  tab.addEventListener('keydown', (event) => {
    const at =
      event.key === 'ArrowRight'
        ? (index + 1) % 3
        : event.key === 'ArrowLeft'
          ? (index + 2) % 3
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? 2
              : -1
    if (at >= 0) {
      event.preventDefault()
      selectPresence(at, true)
    }
  })
})

const answers = {
  customer:
    'A great starting point is an assistant on your website. It can help customers understand your services and pass a clear enquiry to your team. Which questions do customers ask most often?',
  team: 'A shared workspace brings leads, conversation briefs, and follow-ups together. You can try the sample CRM now using “Explore the workspace”.',
  tools:
    'Keep the tools that already work for you. The integration scope follows your website and business systems. The workspace shows where those connections will live.',
  default:
    'Thanks for sharing. Archava starts with your services, your customers, and how your team works. This conversation is a scripted preview; explore the workspace to see the next step.',
}
function sampleMessage(message: string, topic: keyof typeof answers = 'default'): void {
  const host = element('#chat-messages')
  const customer = document.createElement('div')
  customer.className = 'chat-bubble customer'
  customer.textContent = message
  const assistant = document.createElement('div')
  assistant.className = 'chat-bubble assistant'
  assistant.textContent = answers[topic]
  host.append(customer, assistant)
  while (host.children.length > 15) host.firstElementChild?.remove()
  host.scrollTop = host.scrollHeight
}
document.querySelectorAll<HTMLButtonElement>('[data-chat]').forEach((button) =>
  button.addEventListener('click', () => {
    const topic = button.dataset.chat
    if (topic === 'customer' || topic === 'team' || topic === 'tools')
      sampleMessage(button.textContent ?? '', topic)
  }),
)
element<HTMLFormElement>('#chat-demo-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const input = element<HTMLInputElement>('#chat-message'),
    value = input.value.trim()
  if (!value) return
  sampleMessage(value)
  input.value = ''
  input.focus()
})
let voiceTimer: ReturnType<typeof setTimeout> | undefined
element<HTMLButtonElement>('#voice-preview').addEventListener('click', () => {
  const pane = element('#presence-voice'),
    button = element<HTMLButtonElement>('#voice-preview')
  if (pane.classList.contains('is-playing')) {
    clearTimeout(voiceTimer)
    pane.classList.remove('is-playing')
    element('#voice-status').textContent = 'READY FOR A CONVERSATION'
    button.textContent = 'Preview the interaction ↗'
    return
  }
  pane.classList.add('is-playing')
  element('#voice-status').textContent = 'VISUAL SIMULATION · LISTENING'
  button.textContent = 'Stop preview ×'
  voiceTimer = setTimeout(() => {
    pane.classList.remove('is-playing')
    element('#voice-status').textContent = 'NEXT STEP: A BRIEF FOR YOUR TEAM'
    button.textContent = 'Preview again ↗'
  }, 5500)
})

const contact = element<HTMLDialogElement>('#contact-dialog')
let returnFocus: HTMLElement | null = null
document.querySelectorAll<HTMLButtonElement>('[data-open-contact]').forEach((button) =>
  button.addEventListener('click', () => {
    returnFocus = button
    element<HTMLTextAreaElement>('#contact-interest').value = button.dataset.interest ?? ''
    contact.showModal()
    contact.querySelector<HTMLInputElement>('input')?.focus()
  }),
)
element('[data-close-dialog]').addEventListener('click', () => contact.close())
contact.addEventListener('close', () => returnFocus?.focus())
element<HTMLFormElement>('#contact-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const form = element<HTMLFormElement>('#contact-form'),
    values = new FormData(form)
  const saved = writeLocal('archava:demo-brief', {
    name: formText(values, 'name'),
    email: formText(values, 'email'),
    interest: formText(values, 'interest'),
    created: new Date().toISOString(),
  })
  if (!saved) {
    toast('This browser could not save the demo brief. Your input is still in the form.')
    return
  }
  contact.close()
  form.reset()
  toast('Demo brief saved on this device. It hasn’t been sent to the team.')
})
