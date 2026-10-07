import { element, escape, icon, toast as showToast, readLocal, writeLocal, formText } from './ui.js'
import {
  industries,
  isIndustry,
  isStage,
  stageNames,
  stages,
  createDemo,
  restoreDemo,
  approveFollowUp,
  addActivity,
  activeLeads,
  pipelineValue,
  today,
  nextDay,
  dateLabel,
  money,
  shortMoney,
  initials,
  id,
} from './data.js'
import type { Industry, Module, Lead, Stage } from './data.js'

type View =
  | 'overview'
  | 'pipeline'
  | 'contacts'
  | 'tasks'
  | 'conversations'
  | 'knowledge'
  | 'connections'
  | 'orders'
  | 'inventory'
  | 'invoices'
const titles: Record<View, string> = {
  overview: 'Overview',
  pipeline: 'Pipeline',
  contacts: 'Contacts',
  tasks: 'Follow-ups',
  conversations: 'Conversations',
  knowledge: 'Knowledge',
  connections: 'Connections',
  orders: 'Orders',
  inventory: 'Inventory',
  invoices: 'Invoices',
}
const crmViews: View[] = [
  'overview',
  'pipeline',
  'contacts',
  'tasks',
  'conversations',
  'knowledge',
  'connections',
]
const erpViews: View[] = ['orders', 'inventory', 'invoices', 'connections']
const params = new URLSearchParams(location.search)
const requestedIndustry = params.get('industry') ?? 'studio'
let industry: Industry = isIndustry(requestedIndustry) ? requestedIndustry : 'studio'
let module: Module = params.get('module') === 'erp' ? 'erp' : 'crm'
function validView(value: string, selectedModule: Module): View {
  return (
    (selectedModule === 'crm' ? crmViews : erpViews).find((view) => view === value) ??
    (selectedModule === 'crm' ? 'overview' : 'orders')
  )
}
let view = validView(params.get('view') ?? '', module)
let state = restoreDemo(readLocal(storageKey()), industry)
let storageAvailable = true
let darkTheme = readLocal('archava:workspace-theme') === 'dark'
let search = '',
  stageFilter = 'all',
  ownerFilter = 'all',
  taskFilter = 'open'
let boardMode: 'board' | 'list' = matchMedia('(max-width:800px)').matches ? 'list' : 'board'
let aiVisible = true,
  selectedConversation = 'lead-4'
let returnFocus: HTMLElement | null = null
const dialog = element<HTMLDialogElement>('#workspace-dialog')
const command = element<HTMLDialogElement>('#command-dialog')
const sidebarBreakpoint = matchMedia('(max-width:800px)')
function storageKey(): string {
  return `archava:workspace:v1:${industry}`
}
function persist(): void {
  storageAvailable = writeLocal(storageKey(), state)
  if (!storageAvailable)
    showToast(
      'Changes are in this preview. Browser storage is unavailable, so they will reset on reload.',
    )
}
function toast(message: string): void {
  showToast(
    storageAvailable
      ? message
      : `${message} Browser storage is unavailable; changes won't survive leaving this demo.`,
  )
}
function href(target: View, selectedModule: Module = module): string {
  return `/workspace?industry=${industry}&module=${selectedModule}&view=${target}`
}
function updateUrl(replace = false): void {
  history[replace ? 'replaceState' : 'pushState']({}, '', href(view))
  document.title = `${titles[view]} · ${industries[industry].name} — Archava`
}
function navigate(target: View, nextModule: Module = module): void {
  module = nextModule
  view = validView(target, module)
  search = ''
  stageFilter = 'all'
  ownerFilter = 'all'
  updateUrl()
  closeSidebar()
  render()
  window.scrollTo({ top: 0, behavior: 'instant' })
}
function changeIndustry(next: Industry): void {
  industry = next
  state = restoreDemo(readLocal(storageKey()), industry)
  search = ''
  stageFilter = 'all'
  ownerFilter = 'all'
  updateUrl()
  render()
  toast(`Switched to ${industries[industry].name}’s sample workspace.`)
}

function button(label: string, action: string, symbol = '', variant = ''): string {
  return `<button type="button" class="btn ${variant}" data-action="${action}">${symbol ? icon(symbol) : ''}${label}</button>`
}
function heading(title: string, description: string, action = '', ai = false): string {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="page-actions">${ai ? `<button class="btn" data-action="ai-toggle" aria-pressed="${aiVisible}">${icon('spark')}Archava AI</button>` : ''}${action}</div></div>`
}
function status(label: string, variant = ''): string {
  return `<span class="status-pill ${variant}">${escape(label)}</span>`
}
function empty(title: string, description: string, action = ''): string {
  return `<div class="empty-state">${icon('search')}<strong>${title}</strong><p>${description}</p>${action}</div>`
}
function metrics(operations = false): string {
  const followUps = state.tasks.filter((task) => !task.done && task.due <= today()).length
  const reviews = state.leads.filter(
    (lead) =>
      lead.stage === 'qualified' &&
      !state.tasks.some((task) => task.id === `ai-follow-up:${lead.id}`),
  ).length
  const entries = operations
    ? [
        [
          'Open orders',
          String(state.orders.length),
          `${state.orders.filter((order) => order.status === 'Ready').length} ready for fulfilment`,
        ],
        [
          'Order value',
          shortMoney(state.orders.reduce((total, order) => total + order.value, 0)),
          'Across sample sales orders',
        ],
        ['Stock alerts', '2', 'Items below reorder level'],
        [
          'Needs your review',
          String(state.orders.filter((order) => order.status === 'Awaiting approval').length),
          'Sample orders awaiting approval',
        ],
      ]
    : [
        [
          'Open opportunities',
          String(activeLeads(state).length),
          `${state.leads.filter((lead) => lead.source === 'Archava Chat').length} from website conversations`,
        ],
        ['Pipeline value', shortMoney(pipelineValue(state)), 'Across open opportunities'],
        ['Follow-ups today', String(followUps), 'Assigned to your team'],
        ['Needs your review', String(reviews), 'Sample AI proposals to review'],
      ]
  return `<div class="metrics">${entries.map(([label, value, note], index) => `<div class="metric"><div class="metric-label">${label}${index === 1 ? '<svg class="metric-chart" viewBox="0 0 50 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="m1 18 8-4 6 2 8-9 7 3 8-7 10-2"/></svg>' : ''}</div><div class="metric-value" data-metric="${index}">${escape(value ?? '')}</div><div class="metric-note">${note}</div></div>`).join('')}</div>`
}
function activity(): string {
  return `<section class="activity-section"><div class="section-bar"><h2>Recent activity</h2><span class="table-owner">Your team's latest steps</span></div>${state.activity
    .slice(0, 5)
    .map((item) => {
      const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(item.at)) / 60000))
      return `<div class="activity-item"><span class="activity-symbol">${icon('check')}</span><span>${escape(item.message)}</span><time datetime="${escape(item.at)}">${minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)}h ago`}</time></div>`
    })
    .join('')}</section>`
}
function aiPanel(operations = false): string {
  if (!aiVisible) return ''
  if (operations)
    return `<aside class="ai-panel" aria-label="Operations AI concept"><div class="ai-panel-top"><span><span class="signal-dot"></span>Archava AI</span><span class="mono">ORDER CONTEXT</span></div><div class="ai-panel-body"><span class="eyebrow">READ FROM YOUR SYSTEM</span><h2>What's ready<br />to deliver?</h2><p>Find the current status, the supporting record, and the next step for your team.</p><div class="ai-evidence"><strong>SAMPLE SNAPSHOT</strong>${state.orders.filter((order) => order.status === 'Ready').length} orders marked Ready.<br />Source: fictional local records.<br />Live ERP connection: not connected.</div><button class="btn lime" data-order="${escape(state.orders.find((order) => order.status === 'Ready')?.id ?? state.orders[0]?.id ?? '')}">Explore a sample order ${icon('arrow')}</button><div class="ai-footnote">Operations is a frontend concept for a later ERP integration phase.</div></div></aside>`
  const lead = state.leads.find(
    (lead) =>
      lead.stage === 'qualified' &&
      !state.tasks.some((task) => task.id === `ai-follow-up:${lead.id}`),
  )
  if (lead === undefined)
    return `<aside class="ai-panel"><div class="ai-panel-top"><span><span class="signal-dot"></span>Archava AI</span><span class="mono">CRM CONTEXT</span></div><div class="ai-panel-body"><span class="eyebrow">ALL CAUGHT UP</span><h2>A clear path<br />for your team.</h2><p>The current sample follow-up proposals have been reviewed. See your team's next steps in Follow-ups.</p><a class="btn lime" href="${href('tasks')}" data-view="tasks">View follow-ups ${icon('arrow')}</a><div class="ai-footnote">Suggestions in this preview come from sample records.</div></div></aside>`
  return `<aside class="ai-panel" aria-label="Archava AI suggested follow-up"><div class="ai-panel-top"><span><span class="signal-dot"></span>Archava AI</span><span class="mono">CRM CONTEXT</span></div><div class="ai-panel-body"><span class="eyebrow">SUGGESTED NEXT STEP</span><h2>${escape(lead.name.split(' ')[0] ?? lead.name)} is ready for<br />a follow-up.</h2><p>The enquiry includes a clear need for ${escape(lead.interest.toLowerCase())}. Prepare a conversation with your team.</p><div class="ai-evidence"><strong>BASED ON</strong>Conversation brief · sample record<br />${escape(lead.company)} / ${escape(lead.name)}<br />Stage: ${stageNames[lead.stage]}</div><button class="btn lime" data-proposal="${escape(lead.id)}">Review the next step ${icon('arrow')}</button><div class="ai-footnote">A suggestion for your team. Creating a sample task needs your approval.</div><div class="ai-person"><span class="avatar-avatar">${escape(initials(lead.owner))}</span><span>Assigned to ${escape(lead.owner)}<small>Tomorrow · After approval</small></span></div></div></aside>`
}
function taskCheckbox(taskId: string, checked: boolean, title: string): string {
  return `<input class="task-checkbox" type="checkbox" data-task="${escape(taskId)}" aria-label="Mark ${escape(title)} ${checked ? 'incomplete' : 'complete'}" ${checked ? 'checked' : ''} />`
}
function leadTable(leads: Lead[], contacts = false): string {
  if (!leads.length)
    return empty(
      'A little room for the next opportunity.',
      'Try a different filter, or add a sample lead.',
      button('Add a lead', 'new-lead', 'plus', 'dark'),
    )
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="${contacts ? 'Sample contacts' : 'Sample opportunities'}; scroll horizontally on small screens"><table class="data-table"><thead><tr><th>${contacts ? 'CONTACT' : 'OPPORTUNITY'}</th><th>COMPANY</th><th>${contacts ? 'EMAIL' : 'STAGE'}</th><th>${contacts ? 'SOURCE' : 'VALUE'}</th><th>OWNER</th></tr></thead><tbody>${leads.map((lead) => `<tr><td><button class="record-name" data-lead="${escape(lead.id)}"><span class="table-avatar">${escape(initials(lead.name))}</span>${escape(lead.name)}</button></td><td>${escape(lead.company)}</td><td>${contacts ? escape(lead.email) : status(stageNames[lead.stage], lead.stage === 'proposal' ? 'blue' : lead.stage === 'new' || lead.stage === 'lost' ? 'neutral' : '')}</td><td>${contacts ? `<span class="source-tag">${escape(lead.source)}</span>` : lead.value ? money(lead.value) : '<span class="table-owner">To qualify</span>'}</td><td class="table-owner">${escape(lead.owner)}</td></tr>`).join('')}</tbody></table></div>`
}
function overview(): string {
  const pending = state.tasks.filter((task) => !task.done).slice(0, 3)
  const maximum = Math.max(
    1,
    ...stages.map((stage) => state.leads.filter((lead) => lead.stage === stage).length),
  )
  return (
    heading(
      'Good work starts here.',
      `A clear view of what’s moving at ${escape(industries[industry].name)}.`,
      button('New lead', 'new-lead', 'plus', 'dark'),
      true,
    ) +
    metrics() +
    `<div class="work-layout ${aiVisible ? '' : 'no-ai'}"><div><div class="overview-grid"><section class="panel"><div class="panel-title"><h2>Your pipeline</h2><span>${activeLeads(state).length} open</span></div><div class="funnel">${(['new', 'qualified', 'proposal', 'won'] as Stage[]).map((stage) => `<div class="funnel-row"><span class="funnel-label">${stageNames[stage]}</span><div class="funnel-track"><div class="funnel-fill ${stage}" style="width:${(state.leads.filter((lead) => lead.stage === stage).length / maximum) * 100}%"></div></div><span class="funnel-count">${state.leads.filter((lead) => lead.stage === stage).length}</span></div>`).join('')}</div></section><section class="panel"><div class="panel-title"><h2>Your next steps</h2><a href="${href('tasks')}" class="table-owner" data-view="tasks">View all ↗</a></div>${pending.length ? pending.map((task) => `<div class="compact-task">${taskCheckbox(task.id, task.done, task.title)}<div><strong>${escape(task.title)}</strong><small>${escape(task.owner)}</small></div><span class="mini-date">${dateLabel(task.due)}</span></div>`).join('') : empty('All caught up.', 'Your open follow-ups will appear here.')}</section></div><div class="section-bar"><h2>Recent opportunities</h2><a href="${href('pipeline')}" data-view="pipeline">Open pipeline ↗</a></div>${leadTable(state.leads.slice(0, 4))}${activity()}</div>${aiPanel()}</div>`
  )
}
function filters(extra = ''): string {
  return `<div class="filters-bar"><div class="filter-group"><label class="search-field">${icon('search')}<span class="sr-only">Search ${titles[view].toLowerCase()}</span><input id="record-search" type="search" value="${escape(search)}" placeholder="Search ${view === 'contacts' ? 'contacts' : view === 'tasks' ? 'follow-ups' : view === 'orders' ? 'orders' : view === 'inventory' ? 'items' : view === 'invoices' ? 'invoices' : 'leads'}…" maxlength="120" /></label>${extra}</div>${view === 'pipeline' ? `<div class="view-switch" aria-label="Pipeline view"><button class="${boardMode === 'board' ? 'active' : ''}" data-board-mode="board" aria-pressed="${boardMode === 'board'}">${icon('pipeline')}Board</button><button class="${boardMode === 'list' ? 'active' : ''}" data-board-mode="list" aria-pressed="${boardMode === 'list'}">${icon('list')}List</button></div>` : ''}</div>`
}
function filteredLeads(): Lead[] {
  return state.leads.filter(
    (lead) =>
      `${lead.name} ${lead.company} ${lead.email} ${lead.interest}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (stageFilter === 'all' || lead.stage === stageFilter) &&
      (ownerFilter === 'all' || lead.owner === ownerFilter),
  )
}
function pipelineResults(): string {
  const leads = filteredLeads()
  if (!leads.length)
    return empty(
      'No opportunities match.',
      'Try another search or filter. Your sample records are still here.',
    )
  if (boardMode === 'list')
    return leadTable(leads) + `<p class="result-count">${leads.length} sample opportunities</p>`
  const visibleStages =
    stageFilter !== 'all' && isStage(stageFilter)
      ? [stageFilter]
      : stages.filter(
          (stage) =>
            ['new', 'qualified', 'proposal'].includes(stage) ||
            leads.some((lead) => lead.stage === stage),
        )
  return `<div class="board-region" tabindex="0" role="region" aria-label="Sample sales pipeline"><div class="pipeline-board" style="--columns:${visibleStages.length}">${visibleStages
    .map(
      (stage) =>
        `<section class="pipeline-column"><div class="pipeline-column-head"><span class="stage-dot ${stage}"></span>${stageNames[stage]}<span>${leads.filter((lead) => lead.stage === stage).length}</span></div>${
          leads
            .filter((lead) => lead.stage === stage)
            .map(
              (lead) =>
                `<button class="lead-card" data-lead="${escape(lead.id)}"><strong>${escape(lead.name)}</strong><small>${escape(lead.company)} · ${escape(lead.interest)}</small>${lead.value ? `<span class="lead-value">${money(lead.value)}</span>` : ''}<span class="lead-meta"><span class="source-tag">${escape(lead.source)}</span><span class="lead-owner" title="${escape(lead.owner)}">${escape(initials(lead.owner))}</span></span></button>`,
            )
            .join('') ||
          '<p class="empty-column">Opportunities at this stage<br />will appear here.</p>'
        }</section>`,
    )
    .join(
      '',
    )}</div></div><p class="result-count">${leads.length} sample opportunities · Open a card to change its stage</p>`
}
function pipeline(): string {
  const extras = `<label><span class="sr-only">Filter by stage</span><select class="filter-select" id="stage-filter"><option value="all">All stages</option>${stages.map((stage) => `<option value="${stage}" ${stageFilter === stage ? 'selected' : ''}>${stageNames[stage]}</option>`).join('')}</select></label><label><span class="sr-only">Filter by owner</span><select class="filter-select" id="owner-filter"><option value="all">All owners</option>${[...new Set(state.leads.map((lead) => lead.owner))].map((owner) => `<option ${ownerFilter === owner ? 'selected' : ''}>${escape(owner)}</option>`).join('')}</select></label>`
  return (
    heading(
      'Your next opportunity.',
      'Conversations, context, and a clear path forward.',
      button('New lead', 'new-lead', 'plus', 'dark'),
      true,
    ) +
    metrics() +
    `<div class="work-layout ${aiVisible ? '' : 'no-ai'}"><div>${filters(extras)}<div id="record-results">${pipelineResults()}</div>${activity()}</div>${aiPanel()}</div>`
  )
}
function contacts(): string {
  return (
    heading(
      'The people behind the possibilities.',
      'Relationships, with all the context in one place.',
      button('Add contact', 'new-lead', 'plus', 'dark'),
    ) +
    filters() +
    `<div id="record-results">${leadTable(filteredLeads(), true)}</div>`
  )
}
function tasksResults(): string {
  const tasks = state.tasks.filter(
    (task) =>
      `${task.title} ${task.owner}`.toLowerCase().includes(search.toLowerCase()) &&
      (taskFilter === 'all' || (taskFilter === 'done' ? task.done : !task.done)),
  )
  return tasks.length
    ? `<div class="task-list">${tasks.map((task) => `<div class="task-row ${task.done ? 'task-complete' : ''}">${taskCheckbox(task.id, task.done, task.title)}<div><strong>${escape(task.title)}</strong><small>${escape(state.leads.find((lead) => lead.id === task.leadId)?.company ?? 'Workspace task')}</small></div><span>${escape(task.owner)}</span><span class="mini-date">${dateLabel(task.due)}</span></div>`).join('')}</div><p class="tasks-summary">${tasks.length} ${taskFilter === 'done' ? 'completed' : 'matching'} tasks · Changes stay in this demo</p>`
    : empty(
        taskFilter === 'done' ? 'No completed tasks yet.' : 'A clear slate.',
        'Add a follow-up, or review a suggested next step.',
        button('Add follow-up', 'new-task', 'plus', 'dark'),
      )
}
function tasks(): string {
  return (
    heading(
      'Keep the next step moving.',
      'A little follow-up goes a long way.',
      button('Add follow-up', 'new-task', 'plus', 'dark'),
    ) +
    filters(
      `<label><span class="sr-only">Task status</span><select id="task-filter" class="filter-select"><option value="open" ${taskFilter === 'open' ? 'selected' : ''}>Open tasks</option><option value="done" ${taskFilter === 'done' ? 'selected' : ''}>Completed</option><option value="all" ${taskFilter === 'all' ? 'selected' : ''}>All tasks</option></select></label>`,
    ) +
    `<div id="record-results">${tasksResults()}</div>`
  )
}
function conversationContent(): string {
  const lead = state.leads.find((lead) => lead.id === selectedConversation) ?? state.leads[0]
  if (!lead)
    return empty(
      'Your conversations start here.',
      'Add a sample lead to explore its conversation context.',
    )
  const drafts = readLocal(`archava:reply-drafts:${industry}`)
  const savedDraft =
    typeof drafts === 'object' && drafts !== null && !Array.isArray(drafts)
      ? (drafts as Record<string, unknown>)[lead.id]
      : ''
  const draftValue = typeof savedDraft === 'string' ? savedDraft.slice(0, 600) : ''
  return `<div class="conversation-heading"><div><h2>${escape(lead.name)}</h2><p>${escape(lead.company)} · ${escape(lead.source)}</p></div><button class="btn" data-lead="${escape(lead.id)}">View record ${icon('arrow')}</button></div><div class="conversation-transcript" id="conversation-transcript"><span class="transcript-label">SAMPLE CONVERSATION / ${dateLabel(lead.created)}</span><div class="transcript-bubble">Hi! I’d like to learn more about ${escape(lead.interest.toLowerCase())}.</div><div class="transcript-bubble ava">Of course. Could you share a little about what your team needs?</div><div class="transcript-bubble">We want to make enquiries easier and give our team a clear next step.</div><div class="transcript-bubble ava">Thanks, ${escape(lead.name.split(' ')[0] ?? lead.name)}. I’ll keep that context together for the team.</div></div><form class="reply-form" id="reply-form"><label class="sr-only" for="reply-message">Sample reply draft</label><input id="reply-message" required maxlength="600" value="${escape(draftValue)}" placeholder="Prepare a reply for your team…" /><button class="btn dark" type="submit">Save draft ${icon('arrow')}</button></form><p class="reply-note">Illustrative conversation · Drafts stay in the preview and aren't sent to a customer.</p>`
}
function conversations(): string {
  return (
    heading(
      'A conversation worth continuing.',
      'The enquiry, the context, and the person behind it.',
    ) +
    `<div class="inbox-layout"><div class="inbox-list"><div class="inbox-list-title">SAMPLE CONVERSATIONS</div>${state.leads
      .slice(0, 5)
      .map(
        (lead) =>
          `<button class="conversation-item ${selectedConversation === lead.id ? 'active' : ''}" data-conversation="${escape(lead.id)}"><span class="table-avatar">${escape(initials(lead.name))}</span><div><strong>${escape(lead.name)}</strong><small>${escape(lead.interest)}</small></div></button>`,
      )
      .join(
        '',
      )}</div><div class="conversation-detail" id="conversation-detail">${conversationContent()}</div></div>`
  )
}
function knowledge(): string {
  return (
    heading(
      'What your assistant should know.',
      'A home for the information that makes your business yours.',
      button('Add a document', 'new-document', 'plus', 'dark'),
    ) +
    `<div class="knowledge-grid">${state.documents.map((doc) => `<button class="knowledge-card" data-document="${escape(doc.id)}"><span class="document-icon">${icon('knowledge')}</span><h2>${escape(doc.title)}</h2><p>${escape(doc.content.slice(0, 135))}${doc.content.length > 135 ? '…' : ''}</p><small>LOCAL SAMPLE · NOT INDEXED</small></button>`).join('')}</div><div class="ops-note"><strong>One place for your business context.</strong>Documents in this preview are saved in your browser. A live knowledge service and retrieval pipeline are later integration work.</div>`
  )
}
function connections(): string {
  const cards = [
    [
      'F',
      'Frappe CRM',
      'A CRM foundation for contacts, opportunities, and the next step for your team.',
    ],
    ['E', 'ERPNext', 'Orders, inventory, and invoices, introduced one module at a time.'],
    ['↗', 'Your website', 'Bring the customer experience into the tools your team already uses.'],
  ]
  return (
    heading(
      'Bring your tools into the loop.',
      'Connections that follow the way your business works.',
    ) +
    `<div class="connections-grid">${cards.map(([mark, name, description]) => `<article class="connection-card"><div class="connection-top"><span class="provider-mark">${mark}</span>${status('Not connected', 'neutral')}</div><h2>${name}</h2><p>${description}</p><button class="btn" data-connection="${name}">Explore the connection ${icon('arrow')}</button></article>`).join('')}</div><div class="ops-note"><strong>A frontend preview of the integration experience.</strong>These cards don't connect to providers or use API credentials. The live integration will follow the source system's roles, data, and approval rules.</div>`
  )
}
function ordersResults(): string {
  const orders = state.orders.filter((order) =>
    `${order.id} ${order.customer} ${order.status}`.toLowerCase().includes(search.toLowerCase()),
  )
  if (!orders.length) return empty('No orders match.', 'Try an order number, customer, or status.')
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="Sample sales orders; scroll horizontally on small screens"><table class="data-table"><thead><tr><th>ORDER</th><th>CUSTOMER</th><th>STATUS</th><th>VALUE</th><th>DELIVERY</th></tr></thead><tbody>${orders.map((order) => `<tr><td><button class="table-link" data-order="${escape(order.id)}">${escape(order.id)}</button></td><td>${escape(order.customer)}</td><td>${status(order.status, order.status === 'Awaiting approval' ? 'warning' : order.status === 'In progress' ? 'blue' : '')}</td><td>${money(order.value)}</td><td class="table-owner">${dateLabel(order.delivery)}</td></tr>`).join('')}</tbody></table></div>`
}
function orders(): string {
  return (
    heading(
      'Keep the whole journey moving.',
      'What’s ordered, what’s ready, and what needs a little attention.',
      '',
      true,
    ) +
    metrics(true) +
    `<div class="work-layout ${aiVisible ? '' : 'no-ai'}"><div>${filters()}<div id="record-results">${ordersResults()}</div><div class="ops-note"><strong>The workspace grows with the business.</strong>Orders, inventory, and invoices share a foundation. This module shows fictional records; a live ERP source isn't connected.</div></div>${aiPanel(true)}</div>`
  )
}
const inventoryItems = [
  ['SKU-001', 'Welcome package', 'Service kit', 24, 10],
  ['SKU-002', 'Studio notebook', 'Supplies', 8, 12],
  ['SKU-003', 'Branded tote', 'Merchandise', 48, 15],
  ['SKU-004', 'Desk essentials', 'Supplies', 6, 10],
  ['SKU-005', 'Gift set', 'Service kit', 18, 8],
] as const
function inventoryResults(): string {
  const items = inventoryItems.filter((item) =>
    `${item[0]} ${item[1]} ${item[2]}`.toLowerCase().includes(search.toLowerCase()),
  )
  return items.length
    ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Sample inventory"><table class="data-table"><thead><tr><th>ITEM</th><th>CATEGORY</th><th>AVAILABLE</th><th>REORDER LEVEL</th><th>STATUS</th></tr></thead><tbody>${items.map(([sku, name, category, quantity, reorder]) => `<tr><td><button class="record-name" data-inventory="${sku}">${name}</button><small>${sku}</small></td><td>${category}</td><td>${quantity}<div class="inventory-meter ${quantity < reorder ? 'low' : ''}"><span style="width:${Math.min(100, (quantity / 50) * 100)}%"></span></div></td><td>${reorder}</td><td>${status(quantity < reorder ? 'Below reorder level' : 'In stock', quantity < reorder ? 'warning' : '')}</td></tr>`).join('')}</tbody></table></div>`
    : empty('No items match.', 'Try a different item name or SKU.')
}
function inventory(): string {
  return (
    heading(
      'A little foresight. A smoother day.',
      'See what’s available and what may need replenishing.',
    ) +
    metrics(true) +
    filters() +
    `<div id="record-results">${inventoryResults()}</div><div class="ops-note"><strong>Sample inventory, for the operations concept.</strong>Stock counts are illustrative. This screen does not book stock movements or connect to a warehouse system.</div>`
  )
}
function invoicesResults(): string {
  const invoices = state.orders
    .map((order, index) => ({
      order,
      invoiceId: order.id.replace('SO-', 'INV-DEMO-'),
      paid: index % 3 === 0,
    }))
    .filter(({ order, invoiceId }) =>
      `${invoiceId} ${order.id} ${order.customer}`.toLowerCase().includes(search.toLowerCase()),
    )
  return invoices.length
    ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Sample invoices"><table class="data-table"><thead><tr><th>INVOICE</th><th>CUSTOMER</th><th>STATUS</th><th>AMOUNT</th><th>DUE</th></tr></thead><tbody>${invoices.map(({ order, invoiceId, paid }) => `<tr><td><button class="table-link" data-invoice="${escape(order.id)}">${escape(invoiceId)}</button></td><td>${escape(order.customer)}</td><td>${status(paid ? 'Paid · sample' : 'Outstanding · sample', paid ? '' : 'warning')}</td><td>${money(order.value)}</td><td class="table-owner">${dateLabel(order.delivery)}</td></tr>`).join('')}</tbody></table></div>`
    : empty('No invoices match.', 'Try an invoice number, customer, or order number.')
}
function invoices(): string {
  return (
    heading(
      'Clarity for the commercial side.',
      'A sample view of invoices, amounts, and due dates.',
    ) +
    filters() +
    `<div id="record-results">${invoicesResults()}</div><div class="ops-note"><strong>An illustration of the invoice experience.</strong>No invoice is issued, payment processed, or ledger posted here. Financial records will follow the connected ERP's permissions and lifecycle.</div>`
  )
}

function renderNav(): void {
  const menu =
    module === 'crm'
      ? ([
          ['overview', 'overview'],
          ['pipeline', 'pipeline'],
          ['contacts', 'contacts'],
          ['tasks', 'tasks'],
          ['conversations', 'conversations'],
          ['knowledge', 'knowledge'],
          ['connections', 'connections'],
        ] as const)
      : ([
          ['orders', 'orders'],
          ['inventory', 'inventory'],
          ['invoices', 'invoices'],
          ['connections', 'connections'],
        ] as const)
  element('#workspace-nav').innerHTML =
    `<p class="nav-heading">${module === 'crm' ? 'WORKSPACE' : 'OPERATIONS'}</p>${menu.map(([target, symbol], index) => `${module === 'crm' && index === 4 ? '<p class="nav-heading">ARCHAVA</p>' : ''}<a class="nav-item ${view === target ? 'active' : ''}" href="${href(target)}" data-view="${target}" ${view === target ? 'aria-current="page"' : ''}>${icon(symbol)}${titles[target]}${target === 'pipeline' ? `<span class="nav-count">${activeLeads(state).length}</span>` : target === 'tasks' ? `<span class="nav-count">${state.tasks.filter((task) => !task.done).length}</span>` : ''}</a>`).join('')}`
  element<HTMLSelectElement>('#industry-select').value = industry
  element('#industry-caption').textContent = `${industries[industry].label} · Demo`
  element('#company-badge').textContent = industries[industry].initials
  document.querySelectorAll<HTMLButtonElement>('[data-module]').forEach((button) => {
    const selected = button.dataset.module === module
    button.classList.toggle('active', selected)
    button.setAttribute('aria-pressed', String(selected))
  })
  element('#breadcrumb').innerHTML =
    `${module === 'crm' ? 'Workspace' : 'Operations'} <i>/</i> <b>${titles[view]}</b>`
}
function render(): void {
  renderNav()
  const renderers: Record<View, () => string> = {
    overview,
    pipeline,
    contacts,
    tasks,
    conversations,
    knowledge,
    connections,
    orders,
    inventory,
    invoices,
  }
  const host = element('#workspace-view')
  host.innerHTML = `<div class="view-enter">${renderers[view]()}</div>`
  document.title = `${titles[view]} · ${industries[industry].name} — Archava`
}
function renderResults(): void {
  const host = document.querySelector('#record-results')
  if (!host) return
  const renders: Partial<Record<View, () => string>> = {
    pipeline: pipelineResults,
    contacts: () => leadTable(filteredLeads(), true),
    tasks: tasksResults,
    orders: ordersResults,
    inventory: inventoryResults,
    invoices: invoicesResults,
  }
  const renderer = renders[view]
  if (renderer) host.innerHTML = renderer()
}

function closeSidebar(): void {
  element('#workspace-sidebar').classList.remove('is-open')
  element('#sidebar-backdrop').hidden = true
  element('#sidebar-open').setAttribute('aria-expanded', 'false')
  document.body.style.overflow = ''
  element('#workspace-sidebar').removeAttribute('role')
  element('#workspace-sidebar').removeAttribute('aria-modal')
  element('.workspace-main').inert = false
  element('#workspace-sidebar').inert = sidebarBreakpoint.matches
}
function openDialog(content: string, record = false): void {
  if (dialog.open) dialog.close()
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  element('#dialog-content').innerHTML = content
  dialog.classList.toggle('record-dialog', record)
  dialog.showModal()
  const input = dialog.querySelector<HTMLInputElement>('input:not([type="hidden"])')
  if (input) input.focus()
  else dialog.querySelector<HTMLButtonElement>('[data-action="close-dialog"]')?.focus()
}
function dialogTop(kicker: string): string {
  return `<div class="dialog-top"><span class="eyebrow">${kicker}</span><button class="icon-button" data-action="close-dialog" aria-label="Close dialog">${icon('close')}</button></div>`
}
function detailRow(label: string, value: string): string {
  return `<div class="detail-row"><span>${label}</span><span>${value}</span></div>`
}
function openLead(leadId: string): void {
  const lead = state.leads.find((item) => item.id === leadId)
  if (!lead) return
  const tasks = state.tasks.filter((task) => task.leadId === leadId)
  const proposalAdded = state.tasks.some((task) => task.id === `ai-follow-up:${leadId}`)
  openDialog(
    `${dialogTop('CRM / OPPORTUNITY')}<div class="record-person"><span class="table-avatar">${escape(initials(lead.name))}</span><div><h2 id="dialog-title">${escape(lead.name)}</h2><p>${escape(lead.company)}</p></div></div><div class="detail-grid">${detailRow('Email', escape(lead.email))}${detailRow('Owner', escape(lead.owner))}${detailRow('Source', escape(lead.source))}${detailRow('Value', lead.value ? money(lead.value) : 'To qualify')}${detailRow('Created', dateLabel(lead.created))}</div><div class="form-grid"><label class="form-field">Stage<select id="record-stage">${stages.map((stage) => `<option value="${stage}" ${lead.stage === stage ? 'selected' : ''}>${stageNames[stage]}</option>`).join('')}</select></label><div class="form-field"><span>Update sample record</span><button class="btn dark" style="margin-top:8px;width:100%;min-height:42px" data-save-stage="${escape(leadId)}">Save stage ${icon('check')}</button></div></div><section class="detail-section"><h3>Conversation brief</h3><p>${escape(lead.name)} is interested in ${escape(lead.interest.toLowerCase())}. The next step is a conversation with the team to confirm the scope and needs.</p></section><section class="detail-section"><h3>Follow-ups</h3>${tasks.length ? tasks.map((task) => `<div class="compact-task ${task.done ? 'task-complete' : ''}">${taskCheckbox(task.id, task.done, task.title)}<div><strong>${escape(task.title)}</strong><small>${dateLabel(task.due)} · ${escape(task.owner)}</small></div></div>`).join('') : '<p>No sample follow-ups assigned yet.</p>'}</section><div class="record-ai"><span class="eyebrow">ARCHAVA AI / SAMPLE SUGGESTION</span><p>${proposalAdded ? 'A sample follow-up task has already been approved for this record.' : 'Prepare a follow-up with the record context, an owner, and a clear due date.'}</p><button class="btn lime" data-proposal="${escape(leadId)}">${proposalAdded ? 'View the approved next step' : 'Review a suggested follow-up'} ${icon('arrow')}</button></div><div class="dialog-actions"><button class="btn" data-edit-lead="${escape(leadId)}">Edit details ${icon('settings')}</button><button class="btn" data-action="close-dialog">Close</button></div><p class="form-note">Fictional CRM record · Changes are local to this demo.</p>`,
    true,
  )
}
function leadForm(leadId = ''): void {
  const lead = state.leads.find((item) => item.id === leadId)
  openDialog(
    `${dialogTop(lead ? 'EDIT SAMPLE RECORD' : 'A NEW POSSIBILITY')}<h2 id="dialog-title">${lead ? 'A little more context.' : 'Start with a person.'}</h2><p class="dialog-description">${lead ? 'Update the details of this sample opportunity.' : 'Add a sample enquiry to your workspace.'}</p><form id="lead-form"><input type="hidden" name="id" value="${escape(leadId)}" /><label class="form-field">Full name<input name="name" required maxlength="100" autocomplete="name" placeholder="Maya Putri" value="${escape(lead?.name ?? '')}" /></label><div class="form-grid"><label class="form-field">Company<input name="company" required maxlength="160" placeholder="Company or organisation" value="${escape(lead?.company ?? '')}" /></label><label class="form-field">Email<input name="email" type="email" required maxlength="160" autocomplete="email" placeholder="name@example.com" value="${escape(lead?.email ?? '')}" /></label></div><label class="form-field">What are they interested in?<input name="interest" required maxlength="200" placeholder="A website, an assistant, a better workflow…" value="${escape(lead?.interest ?? '')}" /></label><div class="form-grid"><label class="form-field">Opportunity value (IDR)<input type="number" name="value" min="0" max="1000000000000000" step="1" value="${lead?.value ?? 0}" required /></label><label class="form-field">Owner<select name="owner"><option ${lead?.owner === 'Alex Kim' ? 'selected' : ''}>Alex Kim</option><option ${lead?.owner === 'Sales team' || !lead ? 'selected' : ''}>Sales team</option></select></label></div><p class="form-note">Demo record · Saved on this device. Use fictional contact information.</p><div class="dialog-actions">${button('Cancel', 'close-dialog')}<button class="btn dark" type="submit">${lead ? 'Save changes' : 'Create sample lead'} ${icon('plus')}</button></div></form>`,
  )
}
function proposal(leadId: string): void {
  const lead = state.leads.find((item) => item.id === leadId)
  if (!lead) return
  const added = state.tasks.some((task) => task.id === `ai-follow-up:${leadId}`)
  openDialog(
    `${dialogTop('AI PROPOSAL / YOUR APPROVAL')}<h2 id="dialog-title">${added ? 'A next step, already in motion.' : 'Review the next step.'}</h2><p class="dialog-description">${added ? 'This sample follow-up is already in your workspace.' : 'Archava proposes a task. Review the details before adding it to this demo.'}</p><div class="proposal-summary">${detailRow('Task', `Follow up with ${escape(lead.name)}`)}${detailRow('Record', escape(lead.company))}${detailRow('Owner', escape(lead.owner))}${detailRow('Due', dateLabel(nextDay()))}${detailRow('Change', 'Add one local follow-up task')}</div><div class="approval-source"><strong>BASED ON THE SAMPLE RECORD</strong>Interest: ${escape(lead.interest)}.<br />Source: ${escape(lead.source)} · ${stageNames[lead.stage]}.</div><p class="form-note">This approval changes fictional browser data only. It doesn't contact a customer or write to a CRM service.</p><div class="dialog-actions">${button('Close', 'close-dialog')}${added ? `<a class="btn dark" href="${href('tasks')}" data-view="tasks">View follow-ups ${icon('arrow')}</a>` : `<button class="btn lime" data-approve="${escape(leadId)}">Approve sample task ${icon('check')}</button>`}</div>`,
  )
}
function taskForm(): void {
  openDialog(
    `${dialogTop('THE NEXT STEP')}<h2 id="dialog-title">Keep the conversation moving.</h2><p class="dialog-description">A simple follow-up for your team.</p><form id="task-form"><label class="form-field">Task<input name="title" required maxlength="200" placeholder="Prepare a discovery call…" /></label><label class="form-field">Related record<select name="lead"><option value="">Workspace task</option>${state.leads.map((lead) => `<option value="${escape(lead.id)}">${escape(lead.name)} · ${escape(lead.company)}</option>`).join('')}</select></label><div class="form-grid"><label class="form-field">Due date<input name="due" type="date" required value="${nextDay()}" /></label><label class="form-field">Owner<select name="owner"><option>Sales team</option><option>Alex Kim</option></select></label></div><p class="form-note">Saved in this frontend demo.</p><div class="dialog-actions">${button('Cancel', 'close-dialog')}<button class="btn dark" type="submit">Add follow-up ${icon('plus')}</button></div></form>`,
  )
}
function openOrder(orderId: string, invoice = false): void {
  const order = state.orders.find((item) => item.id === orderId)
  if (!order) return
  openDialog(
    `${dialogTop(invoice ? 'OPERATIONS / SAMPLE INVOICE' : 'OPERATIONS / SALES ORDER')}<h2 id="dialog-title">${invoice ? 'A sample invoice.' : escape(order.id)}</h2><p class="dialog-description">${escape(order.customer)} · Fictional operations record</p><div class="detail-grid">${detailRow('Related order', escape(order.id))}${detailRow('Order status', status(order.status, order.status === 'Awaiting approval' ? 'warning' : ''))}${detailRow('Value', money(order.value))}${detailRow('Items', String(order.items))}${detailRow('Target delivery', dateLabel(order.delivery))}${detailRow('Live source', 'Not connected')}</div><p class="form-note">This is a frontend illustration. No invoice is issued, payment made, or stock modified.</p><div class="dialog-actions">${button('Close', 'close-dialog')}${!invoice && order.status !== 'Ready' ? `<button class="btn dark" data-ready-order="${escape(order.id)}">Set demo status to Ready ${icon('check')}</button>` : ''}</div>`,
    true,
  )
}
function documentForm(documentId = ''): void {
  const doc = state.documents.find((item) => item.id === documentId)
  openDialog(
    `${dialogTop('BUSINESS KNOWLEDGE / LOCAL DRAFT')}<h2 id="dialog-title">${doc ? 'Keep the context clear.' : 'A little business knowledge.'}</h2><p class="dialog-description">${doc ? 'Review or edit this sample document.' : 'Add a local sample document for the knowledge screen.'}</p><form id="document-form"><input name="id" type="hidden" value="${escape(documentId)}" /><label class="form-field">Title<input name="title" required maxlength="200" placeholder="About our services" value="${escape(doc?.title ?? '')}" /></label><label class="form-field">Content<textarea name="content" rows="7" required maxlength="10000" placeholder="The information your team wants to keep together…">${escape(doc?.content ?? '')}</textarea></label><p class="form-note">Saved in browser storage only. This doesn't train a model or index content for live retrieval.</p><div class="dialog-actions">${button('Cancel', 'close-dialog')}<button class="btn dark" type="submit">Save sample document ${icon('check')}</button></div></form>`,
  )
}
function settings(): void {
  openDialog(
    `${dialogTop('YOUR DEMO WORKSPACE')}<h2 id="dialog-title">Make yourself at home.</h2><p class="dialog-description">Explore the foundation with a different industry or theme.</p><label class="form-field">Industry preset<select id="settings-industry">${Object.entries(
      industries,
    )
      .map(
        ([key, profile]) =>
          `<option value="${key}" ${key === industry ? 'selected' : ''}>${profile.name} · ${profile.label}</option>`,
      )
      .join(
        '',
      )}</select></label><div class="detail-grid">${detailRow('Storage', 'This browser, on this device')}${detailRow('Live CRM / ERP', 'Not connected')}${detailRow('AI proposals', 'Scripted demo examples')}</div><div class="dialog-actions">${button('Change theme', 'theme', 'sun')}${button('Done', 'close-dialog', 'check', 'dark')}</div>`,
  )
}

function commandResults(): void {
  const term = element<HTMLInputElement>('#command-input').value.trim().toLowerCase()
  const pages = (module === 'crm' ? crmViews : erpViews).filter((target) =>
    titles[target].toLowerCase().includes(term),
  )
  const leads = state.leads
    .filter((lead) => `${lead.name} ${lead.company}`.toLowerCase().includes(term))
    .slice(0, 5)
  const orders =
    module === 'erp'
      ? state.orders
          .filter((order) => `${order.id} ${order.customer}`.toLowerCase().includes(term))
          .slice(0, 3)
      : []
  element('#command-results').innerHTML =
    `${pages.length ? `<p class="command-group">PAGES</p>${pages.map((target) => `<button class="command-result" data-command-view="${target}">${icon(target === 'tasks' ? 'tasks' : target)}<span>${titles[target]}</span><i>↵</i></button>`).join('')}` : ''}${leads.length ? `<p class="command-group">SAMPLE CONTACTS</p>${leads.map((lead) => `<button class="command-result" data-command-lead="${escape(lead.id)}">${icon('contacts')}<span>${escape(lead.name)}<small>${escape(lead.company)}</small></span><i>↗</i></button>`).join('')}` : ''}${orders.length ? `<p class="command-group">SAMPLE ORDERS</p>${orders.map((order) => `<button class="command-result" data-command-order="${escape(order.id)}">${icon('orders')}<span>${escape(order.id)}<small>${escape(order.customer)}</small></span><i>↗</i></button>`).join('')}` : ''}${!pages.length && !leads.length && !orders.length ? empty('Nothing matches yet.', 'Try a person, company, or page name.') : ''}`
}
function openCommand(): void {
  if (dialog.open || command.open) return
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  command.showModal()
  element<HTMLInputElement>('#command-input').value = ''
  commandResults()
  element<HTMLInputElement>('#command-input').focus()
}
function applyTheme(): void {
  const dark = darkTheme
  document.body.dataset.theme = dark ? 'dark' : 'light'
  element('#theme-toggle').innerHTML = icon(dark ? 'sun' : 'moon')
  element('#theme-toggle').setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`)
}
function toggleTheme(): void {
  darkTheme = !darkTheme
  writeLocal('archava:workspace-theme', darkTheme ? 'dark' : 'light')
  applyTheme()
}

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return
  const target = event.target.closest<HTMLElement>('button,a')
  if (!target) return
  const data = target.dataset
  if (data.view) {
    event.preventDefault()
    if (dialog.open) dialog.close()
    navigate(validView(data.view, module))
    return
  }
  if (data.module === 'crm' || data.module === 'erp') {
    navigate(data.module === 'crm' ? 'overview' : 'orders', data.module)
    return
  }
  if (data.lead) {
    openLead(data.lead)
    return
  }
  if (data.editLead) {
    leadForm(data.editLead)
    return
  }
  if (data.proposal) {
    proposal(data.proposal)
    return
  }
  if (data.order) {
    openOrder(data.order)
    return
  }
  if (data.invoice) {
    openOrder(data.invoice, true)
    return
  }
  if (data.document) {
    documentForm(data.document)
    return
  }
  if (data.conversation) {
    selectedConversation = data.conversation
    render()
    return
  }
  if (data.boardMode === 'board' || data.boardMode === 'list') {
    boardMode = data.boardMode
    render()
    return
  }
  if (data.approve) {
    const created = approveFollowUp(state, data.approve)
    if (created) persist()
    dialog.close()
    render()
    toast(
      created
        ? 'Sample follow-up created. The next step is in your team’s task list.'
        : 'This sample follow-up has already been created.',
    )
    return
  }
  if (data.saveStage) {
    const lead = state.leads.find((lead) => lead.id === data.saveStage),
      next = element<HTMLSelectElement>('#record-stage').value
    if (lead && isStage(next)) {
      if (lead.stage !== next) {
        lead.stage = next
        addActivity(state, `${lead.name}’s opportunity moved to ${stageNames[next]}.`)
        persist()
        render()
      }
      dialog.close()
      toast('Sample stage saved.')
    }
    return
  }
  if (data.readyOrder) {
    const order = state.orders.find((order) => order.id === data.readyOrder)
    if (order) {
      order.status = 'Ready'
      persist()
      dialog.close()
      render()
      toast('Sample order marked Ready in this browser.')
    }
    return
  }
  if (data.commandView) {
    command.close()
    navigate(validView(data.commandView, module))
    return
  }
  if (data.commandLead) {
    command.close()
    openLead(data.commandLead)
    return
  }
  if (data.commandOrder) {
    command.close()
    openOrder(data.commandOrder)
    return
  }
  if (data.inventory) {
    const item = inventoryItems.find((item) => item[0] === data.inventory)
    if (item)
      openDialog(
        `${dialogTop('OPERATIONS / SAMPLE ITEM')}<h2 id="dialog-title">${item[1]}</h2><div class="detail-grid">${detailRow('SKU', item[0])}${detailRow('Category', item[2])}${detailRow('Available', String(item[3]))}${detailRow('Reorder level', String(item[4]))}</div><p class="form-note">Illustrative inventory snapshot. No stock movements are made here.</p><div class="dialog-actions">${button('Close', 'close-dialog')}</div>`,
      )
    return
  }
  if (data.connection) {
    openDialog(
      `${dialogTop('INTEGRATION / PLANNED')}<h2 id="dialog-title">${escape(data.connection)}</h2><p class="dialog-description">A connection that will follow your source system.</p><div class="detail-grid">${detailRow('Status', status('Not connected', 'neutral'))}${detailRow('Data in this demo', 'Fictional browser records')}${detailRow('Setup', 'Later integration phase')}</div><p class="form-note">The live implementation needs an adapter, scoped server credentials, role mapping, and tests against the actual client system.</p><div class="dialog-actions">${button('Close', 'close-dialog')}</div>`,
    )
    return
  }
  if (data.action === 'new-lead') leadForm()
  if (data.action === 'new-task') taskForm()
  if (data.action === 'new-document') documentForm()
  if (data.action === 'close-dialog') dialog.close()
  if (data.action === 'ai-toggle') {
    aiVisible = !aiVisible
    render()
  }
  if (data.action === 'theme') toggleTheme()
  if (data.action === 'reset-confirm') {
    state = createDemo(industry)
    persist()
    dialog.close()
    render()
    toast('This industry’s demo has been reset to its sample records.')
  }
})
document.addEventListener('input', (event) => {
  if (!(event.target instanceof HTMLInputElement)) return
  if (event.target.id === 'record-search') {
    search = event.target.value
    renderResults()
  }
  if (event.target.id === 'command-input') commandResults()
})
document.addEventListener('change', (event) => {
  const target = event.target
  if (target instanceof HTMLSelectElement) {
    if (target.id === 'industry-select' || target.id === 'settings-industry') {
      if (isIndustry(target.value)) {
        if (dialog.open) dialog.close()
        changeIndustry(target.value)
      }
    }
    if (target.id === 'stage-filter') {
      stageFilter = target.value
      renderResults()
    }
    if (target.id === 'owner-filter') {
      ownerFilter = target.value
      renderResults()
    }
    if (target.id === 'task-filter') {
      taskFilter = target.value
      renderResults()
    }
  }
  if (target instanceof HTMLInputElement && target.dataset.task) {
    const task = state.tasks.find((task) => task.id === target.dataset.task)
    if (!task) return
    task.done = target.checked
    addActivity(state, `${task.done ? 'Completed' : 'Reopened'}: ${task.title}.`)
    persist()
    if (dialog.open) {
      target.closest('.compact-task')?.classList.toggle('task-complete', task.done)
      target.setAttribute(
        'aria-label',
        `Mark ${task.title} ${task.done ? 'incomplete' : 'complete'}`,
      )
    }
    render()
  }
})
document.addEventListener('submit', (event) => {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  event.preventDefault()
  const values = new FormData(form)
  // Named form controls can shadow DOM properties such as `form.id`.
  const formId = form.getAttribute('id')
  const field = (name: string): string => formText(values, name)
  if (formId === 'lead-form') {
    const existing = state.leads.find((lead) => lead.id === field('id'))
    const value = Number(field('value'))
    if (
      !field('name') ||
      !field('company') ||
      !field('interest') ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1e15
    ) {
      toast('Please add a name, company, interest, and valid opportunity value.')
      return
    }
    if (!existing && state.leads.length >= 500) {
      toast('This demo supports up to 500 sample contacts.')
      return
    }
    const lead: Lead = {
      id: existing?.id ?? id('lead'),
      name: field('name').slice(0, 100),
      company: field('company').slice(0, 160),
      email: field('email').slice(0, 160),
      interest: field('interest').slice(0, 200),
      value,
      stage: existing?.stage ?? 'new',
      owner: field('owner') === 'Alex Kim' ? 'Alex Kim' : 'Sales team',
      source: existing?.source ?? 'Manual entry',
      created: existing?.created ?? today(),
    }
    if (existing) state.leads = state.leads.map((item) => (item.id === lead.id ? lead : item))
    else state.leads.unshift(lead)
    addActivity(
      state,
      `${lead.name}’s sample ${existing ? 'record was updated' : 'enquiry was added'}.`,
    )
    persist()
    dialog.close()
    render()
    toast(existing ? 'Sample contact updated.' : 'Sample lead added to New enquiry.')
  }
  if (formId === 'task-form') {
    if (
      !field('title') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(field('due')) ||
      !Number.isFinite(Date.parse(field('due'))) ||
      (field('lead') && !state.leads.some((lead) => lead.id === field('lead')))
    ) {
      toast('Please add a task and a valid due date.')
      return
    }
    if (state.tasks.length >= 1000) {
      toast('This demo supports up to 1,000 sample tasks.')
      return
    }
    state.tasks.unshift({
      id: id('task'),
      title: field('title').slice(0, 200),
      leadId: field('lead'),
      due: field('due'),
      done: false,
      owner: field('owner') === 'Alex Kim' ? 'Alex Kim' : 'Sales team',
    })
    addActivity(state, `Added a sample follow-up: ${field('title').slice(0, 200)}.`)
    persist()
    dialog.close()
    render()
    toast('Sample follow-up added.')
  }
  if (formId === 'document-form') {
    if (!field('title') || !field('content')) {
      toast('Please add a title and document content.')
      return
    }
    const existing = state.documents.find((doc) => doc.id === field('id'))
    if (!existing && state.documents.length >= 200) {
      toast('This demo supports up to 200 sample documents.')
      return
    }
    const doc = {
      id: existing?.id ?? id('doc'),
      title: field('title').slice(0, 200),
      content: field('content').slice(0, 10000),
    }
    if (existing) state.documents = state.documents.map((item) => (item.id === doc.id ? doc : item))
    else state.documents.unshift(doc)
    persist()
    dialog.close()
    render()
    toast('Sample document saved locally.')
  }
  if (formId === 'reply-form') {
    const input = element<HTMLInputElement>('#reply-message'),
      text = input.value.trim()
    if (!text) return
    const lead = state.leads.find((lead) => lead.id === selectedConversation) ?? state.leads[0]
    if (!lead) return
    const drafts = readLocal(`archava:reply-drafts:${industry}`)
    const previous =
      typeof drafts === 'object' && drafts !== null && !Array.isArray(drafts)
        ? (drafts as Record<string, unknown>)
        : {}
    const saved = writeLocal(`archava:reply-drafts:${industry}`, {
      ...previous,
      [lead.id]: text.slice(0, 600),
    })
    if (!saved) {
      toast('Browser storage is unavailable. Your draft is still in the field.')
      return
    }
    const bubble = document.createElement('div')
    bubble.className = 'transcript-bubble ava'
    bubble.textContent = `Your local draft: ${text}`
    element('#conversation-transcript').append(bubble)
    input.value = ''
    toast('Reply draft saved on this device. No message was sent.')
  }
})
element('#sidebar-open').addEventListener('click', () => {
  element('#workspace-sidebar').inert = false
  element('#workspace-sidebar').classList.add('is-open')
  element('#sidebar-backdrop').hidden = false
  element('#sidebar-open').setAttribute('aria-expanded', 'true')
  document.body.style.overflow = 'hidden'
  element('#workspace-sidebar').setAttribute('role', 'dialog')
  element('#workspace-sidebar').setAttribute('aria-modal', 'true')
  element('.workspace-main').inert = true
  element<HTMLButtonElement>('#sidebar-close').focus()
})
element('#sidebar-close').addEventListener('click', () => {
  closeSidebar()
  element('#sidebar-open').focus()
})
element('#sidebar-backdrop').addEventListener('click', closeSidebar)
element('#industry-select').addEventListener('keydown', (event) => event.stopPropagation())
element('#workspace-settings').addEventListener('click', settings)
element('#theme-toggle').addEventListener('click', toggleTheme)
element('#command-trigger').addEventListener('click', openCommand)
element('#command-close').addEventListener('click', () => command.close())
element('#reset-demo').addEventListener('click', () =>
  openDialog(
    `${dialogTop('RESET THIS DEMO')}<h2 id="dialog-title">A fresh start?</h2><p class="dialog-description">This resets ${escape(industries[industry].name)}’s local leads, tasks, documents, and orders to the original sample data. Other industry demos stay as they are.</p><div class="dialog-actions">${button('Keep my changes', 'close-dialog')}${button('Reset sample data', 'reset-confirm', 'back', 'dark')}</div>`,
  ),
)
function restoreFocus(): void {
  if (dialog.open || command.open) return
  if (returnFocus?.isConnected) returnFocus.focus()
  else element('#workspace-view').focus()
}
dialog.addEventListener('close', restoreFocus)
command.addEventListener('close', restoreFocus)
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    openCommand()
  }
  if (event.key === 'Escape' && !dialog.open && !command.open) {
    const open = element('#workspace-sidebar').classList.contains('is-open')
    closeSidebar()
    if (open) element('#sidebar-open').focus()
  }
  if (event.key === 'Tab' && element('#workspace-sidebar').classList.contains('is-open')) {
    const controls = [
      ...element('#workspace-sidebar').querySelectorAll<HTMLElement>('a,button,select'),
    ].filter((control) => control.getClientRects().length > 0)
    const first = controls[0],
      last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }
  if (command.open && event.key === 'Enter' && event.target === element('#command-input')) {
    event.preventDefault()
    element('#command-results').querySelector<HTMLButtonElement>('button')?.click()
  }
})
addEventListener('popstate', () => {
  const query = new URLSearchParams(location.search),
    selected = query.get('industry') ?? 'studio'
  if (isIndustry(selected) && selected !== industry) {
    industry = selected
    state = restoreDemo(readLocal(storageKey()), industry)
  }
  module = query.get('module') === 'erp' ? 'erp' : 'crm'
  view = validView(query.get('view') ?? '', module)
  search = ''
  stageFilter = 'all'
  ownerFilter = 'all'
  closeSidebar()
  render()
})
const preference = matchMedia('(prefers-reduced-motion: reduce)')
function applyMotion(): void {
  document.documentElement.classList.toggle(
    'motion-off',
    preference.matches || readLocal('archava:motion') === false,
  )
}
preference.addEventListener('change', applyMotion)
sidebarBreakpoint.addEventListener('change', closeSidebar)
applyMotion()
applyTheme()
updateUrl(true)
render()
closeSidebar()
