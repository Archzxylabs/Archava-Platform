export const stages = ['new', 'qualified', 'proposal', 'won', 'lost'] as const
export type Stage = (typeof stages)[number]
export type Industry = 'studio' | 'healthcare' | 'hospitality' | 'retail'
export type Module = 'crm' | 'erp'
export const stageNames: Record<Stage, string> = {
  new: 'New enquiry',
  qualified: 'Qualified',
  proposal: 'Proposal',
  won: 'Won',
  lost: 'Lost',
}
export const industries: Record<
  Industry,
  { name: string; label: string; initials: string; interest: string }
> = {
  studio: {
    name: 'North Studio',
    label: 'Studio & services',
    initials: 'N',
    interest: 'Website & AI reception',
  },
  healthcare: {
    name: 'Care Clinic',
    label: 'Healthcare services',
    initials: 'C',
    interest: 'Service enquiry & appointment information',
  },
  hospitality: {
    name: 'Palm House',
    label: 'Hospitality',
    initials: 'P',
    interest: 'Guest enquiry & stay information',
  },
  retail: {
    name: 'Lokal Goods',
    label: 'Retail & commerce',
    initials: 'L',
    interest: 'Product enquiry & order assistance',
  },
}
export interface Lead {
  id: string
  name: string
  company: string
  email: string
  stage: Stage
  value: number
  source: string
  interest: string
  owner: string
  created: string
}
export interface Task {
  id: string
  title: string
  leadId: string
  due: string
  done: boolean
  owner: string
}
export interface Order {
  id: string
  customer: string
  status: 'Ready' | 'Awaiting approval' | 'In progress'
  value: number
  delivery: string
  items: number
}
export interface KnowledgeDocument {
  id: string
  title: string
  content: string
}
export interface WorkspaceState {
  version: 1
  leads: Lead[]
  tasks: Task[]
  orders: Order[]
  documents: KnowledgeDocument[]
  activity: { id: string; message: string; at: string }[]
}

export function isIndustry(value: string): value is Industry {
  return Object.hasOwn(industries, value)
}
export function isStage(value: string): value is Stage {
  return stages.some((stage) => stage === value)
}
export function today(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function nextDay(days = 1): string {
  const date = new Date(`${today()}T12:00:00`)
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function dateLabel(value: string): string {
  if (value === today()) return 'Today'
  if (value === nextDay()) return 'Tomorrow'
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(
    new Date(`${value}T12:00:00`),
  )
}
export function money(value: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(value)
}
export function shortMoney(value: number): string {
  return value >= 1000000
    ? `Rp ${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 }).format(value / 1000000)} jt`
    : money(value)
}
export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase()
}
export function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

export function createDemo(industry: Industry): WorkspaceState {
  const profile = industries[industry]
  const seed = [
    ['Maya Putri', 'Atelier Maya', 'new', 12000000, 'Archava Chat', 'Website redesign'],
    ['Rafi Santoso', 'Ruang Coffee', 'new', 0, 'Website', 'Customer support'],
    ['Rani Prameswari', 'Ruang Creative', 'new', 18000000, 'Archava Chat', 'Customer experience'],
    ['Nadia Kusuma', 'Studio Forma', 'qualified', 24000000, 'Voice enquiry', 'AI receptionist'],
    ['Dimas Pratama', 'Lokal Goods', 'qualified', 18000000, 'Referral', 'Store integration'],
    ['Sinta Dewi', 'Rona Atelier', 'qualified', 16000000, 'Website', 'Team workspace'],
    ['Aditya Wijaya', 'Warna Agency', 'proposal', 32000000, 'Email', 'Business workspace'],
    ['Bima Nugraha', 'Sisi Studio', 'proposal', 28000000, 'Referral', 'Customer experience'],
  ] as const
  const leads: Lead[] = seed.map(([name, company, stage, value, source, interest], index) => ({
    id: `lead-${index + 1}`,
    name,
    company: industry === 'studio' ? company : `${profile.name} · Enquiry ${index + 1}`,
    email: `${name.toLowerCase().split(' ')[0]}@example.com`,
    stage,
    value,
    source,
    interest: industry === 'studio' ? interest : profile.interest,
    owner: index % 3 === 0 ? 'Alex Kim' : 'Sales team',
    created: today(),
  }))
  return {
    version: 1,
    leads,
    tasks: [
      {
        id: 'task-1',
        title: 'Send Maya the website overview',
        leadId: 'lead-1',
        due: today(),
        owner: 'Alex Kim',
        done: false,
      },
      {
        id: 'task-2',
        title: 'Review Aditya’s proposal',
        leadId: 'lead-7',
        due: today(),
        owner: 'Sales team',
        done: false,
      },
      {
        id: 'task-3',
        title: 'Check in with Dimas',
        leadId: 'lead-5',
        due: today(),
        owner: 'Sales team',
        done: false,
      },
      {
        id: 'task-4',
        title: 'Prepare the discovery call',
        leadId: 'lead-6',
        due: nextDay(),
        owner: 'Alex Kim',
        done: false,
      },
    ],
    orders: [
      {
        id: 'SO-2026-0012',
        customer: 'Lokal Goods',
        status: 'Ready',
        value: 18000000,
        delivery: nextDay(3),
        items: 3,
      },
      {
        id: 'SO-2026-0011',
        customer: 'Warna Agency',
        status: 'Awaiting approval',
        value: 32000000,
        delivery: nextDay(7),
        items: 2,
      },
      {
        id: 'SO-2026-0010',
        customer: 'Atelier Maya',
        status: 'In progress',
        value: 12000000,
        delivery: nextDay(10),
        items: 4,
      },
      {
        id: 'SO-2026-0009',
        customer: 'Studio Forma',
        status: 'Ready',
        value: 24000000,
        delivery: nextDay(2),
        items: 2,
      },
      {
        id: 'SO-2026-0008',
        customer: 'Rona Atelier',
        status: 'In progress',
        value: 16000000,
        delivery: nextDay(12),
        items: 1,
      },
    ],
    documents: [
      {
        id: 'doc-1',
        title: 'About our business',
        content: `${profile.name} helps customers get the right information and connects enquiries with the team. This is sample knowledge for the frontend preview.`,
      },
      {
        id: 'doc-2',
        title: 'Services & frequently asked questions',
        content:
          'Every customer starts with a conversation. The team reviews the brief, confirms the scope, and proposes the next step. A sample document; no live retrieval is connected.',
      },
      {
        id: 'doc-3',
        title: 'Team handoff guide',
        content:
          'Keep the customer’s name, enquiry, relevant source, and preferred next step together. Assign an owner and review proposed actions before making changes.',
      },
    ],
    activity: [
      {
        id: 'activity-1',
        message: 'Archava captured Maya’s enquiry with a conversation brief.',
        at: new Date(Date.now() - 12 * 60000).toISOString(),
      },
      {
        id: 'activity-2',
        message: 'The team reviewed Nadia’s requirements.',
        at: new Date(Date.now() - 38 * 60000).toISOString(),
      },
      {
        id: 'activity-3',
        message: 'Aditya’s opportunity moved to Proposal.',
        at: new Date(Date.now() - 67 * 60000).toISOString(),
      },
    ],
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function text(value: unknown, maximum = 1000): value is string {
  return typeof value === 'string' && value.length <= maximum
}
function amount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15
}
function date(value: unknown): value is string {
  return text(value, 10) && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
}
function validLead(value: unknown): value is Lead {
  return (
    record(value) &&
    text(value['id'], 100) &&
    text(value['name'], 100) &&
    text(value['company'], 160) &&
    text(value['email'], 160) &&
    text(value['stage']) &&
    isStage(value['stage']) &&
    amount(value['value']) &&
    text(value['source'], 80) &&
    text(value['interest']) &&
    text(value['owner'], 100) &&
    date(value['created'])
  )
}
function validTask(value: unknown): value is Task {
  return (
    record(value) &&
    text(value['id'], 100) &&
    text(value['title'], 200) &&
    text(value['leadId'], 100) &&
    date(value['due']) &&
    typeof value['done'] === 'boolean' &&
    text(value['owner'], 100)
  )
}
function validOrder(value: unknown): value is Order {
  return (
    record(value) &&
    text(value['id'], 100) &&
    text(value['customer'], 160) &&
    text(value['status']) &&
    ['Ready', 'Awaiting approval', 'In progress'].includes(value['status']) &&
    amount(value['value']) &&
    date(value['delivery']) &&
    amount(value['items'])
  )
}

/** Browser storage is untrusted; an old or damaged demo resets to a valid seed. */
export function restoreDemo(value: unknown, industry: Industry): WorkspaceState {
  if (!record(value) || value['version'] !== 1) return createDemo(industry)
  const leads = value['leads'],
    tasks = value['tasks'],
    orders = value['orders'],
    documents = value['documents'],
    activity = value['activity']
  if (
    !Array.isArray(leads) ||
    leads.length > 500 ||
    !leads.every(validLead) ||
    new Set(leads.map((lead) => lead.id)).size !== leads.length
  )
    return createDemo(industry)
  if (
    !Array.isArray(tasks) ||
    tasks.length > 1000 ||
    !tasks.every(validTask) ||
    tasks.some((task) => task.leadId !== '' && !leads.some((lead) => lead.id === task.leadId))
  )
    return createDemo(industry)
  if (!Array.isArray(orders) || orders.length > 500 || !orders.every(validOrder))
    return createDemo(industry)
  if (
    !Array.isArray(documents) ||
    documents.length > 200 ||
    !documents.every(
      (doc) =>
        record(doc) &&
        text(doc['id'], 100) &&
        text(doc['title'], 200) &&
        text(doc['content'], 10000),
    )
  )
    return createDemo(industry)
  if (
    !Array.isArray(activity) ||
    activity.length > 100 ||
    !activity.every(
      (item) =>
        record(item) &&
        text(item['id'], 100) &&
        text(item['message'], 1000) &&
        text(item['at'], 40) &&
        Number.isFinite(Date.parse(item['at'])),
    )
  )
    return createDemo(industry)
  return value as unknown as WorkspaceState
}

export function addActivity(state: WorkspaceState, message: string): void {
  state.activity.unshift({ id: id('activity'), message, at: new Date().toISOString() })
  state.activity = state.activity.slice(0, 100)
}

/** A single local proposal produces at most one task, including after reload. */
export function approveFollowUp(state: WorkspaceState, leadId: string): boolean {
  const lead = state.leads.find((item) => item.id === leadId)
  if (lead === undefined || state.tasks.some((task) => task.id === `ai-follow-up:${leadId}`))
    return false
  state.tasks.unshift({
    id: `ai-follow-up:${leadId}`,
    title: `Follow up with ${lead.name}`,
    leadId,
    due: nextDay(),
    done: false,
    owner: lead.owner,
  })
  addActivity(state, `You approved ${lead.name}’s sample follow-up task.`)
  return true
}

export function activeLeads(state: WorkspaceState): Lead[] {
  return state.leads.filter((lead) => lead.stage !== 'won' && lead.stage !== 'lost')
}
export function pipelineValue(state: WorkspaceState): number {
  return activeLeads(state).reduce((total, lead) => total + lead.value, 0)
}
