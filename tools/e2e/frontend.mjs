/**
 * Local frontend regressions through the served DOM, including named form
 * controls, cancellation, saved edits, and idempotent demo approval.
 * Run against `pnpm dev` / `pnpm start`; BASE, E2E_BROWSER, CDP_PORT, and
 * E2E_PROFILE have the same meaning as in home.mjs. No provider calls are made.
 */
/* global process, console */
process.env.CDP_PORT ??= '9337'
process.env.E2E_PROFILE ??= '/tmp/archava-frontend-e2e/profile'
const { launchDebugBrowser, Session } = await import('./cdp.mjs')
const base = process.env.BASE ?? 'http://127.0.0.1:4173'
const results = []
function check(name, ok) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
}
await launchDebugBrowser()
const page = await Session.open(`${base}/workspace?view=pipeline`)
const evaluate = (expression) => page.evaluate(expression)
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
const fill = (selector, value) =>
  evaluate(`{
  const control = document.querySelector(${JSON.stringify(selector)});
  control.value = ${JSON.stringify(value)};
  control.dispatchEvent(new Event('input', { bubbles: true }));
}`)
const stored = () => evaluate(`JSON.parse(localStorage.getItem('archava:workspace:v1:studio'))`)
try {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  // This harness's dedicated profile isolates its sample writes from the user.
  await evaluate(`localStorage.removeItem('archava:workspace:v1:studio')`)
  await page.navigate(`${base}/workspace?view=pipeline`)
  check(
    'pipeline boots with eight sample records',
    (await evaluate(`document.querySelectorAll('.lead-card').length`)) === 8,
  )

  await click('[data-action="new-lead"]')
  for (const [name, value] of [
    ['name', 'Cancelled Example'],
    ['company', 'Demo'],
    ['email', 'cancel@example.com'],
    ['interest', 'A website'],
  ]) {
    await fill(`#lead-form [name="${name}"]`, value)
  }
  await click('#lead-form [data-action="close-dialog"]')
  check(
    'cancel does not submit a valid form',
    (await evaluate(`document.querySelectorAll('.lead-card').length`)) === 8,
  )

  await click('[data-action="new-lead"]')
  for (const [name, value] of [
    ['name', 'Frontend Example'],
    ['company', 'Demo Company'],
    ['email', 'demo@example.com'],
    ['interest', 'Customer enquiries'],
  ]) {
    await fill(`#lead-form [name="${name}"]`, value)
  }
  await click('#lead-form [type="submit"]')
  const created = (await stored())?.leads.find((lead) => lead.name === 'Frontend Example')
  check('named id control does not prevent form submission', created !== undefined)
  if (created === undefined) throw new Error('Frontend lead creation failed')
  await page.navigate(`${base}/workspace?view=pipeline`)
  check(
    'the new lead survives reload',
    (await evaluate(`document.querySelectorAll('.lead-card').length`)) === 9,
  )

  await fill('#record-search', 'Frontend Example')
  check(
    'search filters the actual rendered records',
    (await evaluate(`document.querySelectorAll('.lead-card').length`)) === 1,
  )
  await fill('#record-search', '')
  await click(`[data-lead="${created.id}"]`)
  await evaluate(`document.querySelector('#record-stage').value = 'won'`)
  await click(`[data-save-stage="${created.id}"]`)
  check(
    'stage changes reach the saved record',
    (await stored()).leads.find((lead) => lead.id === created.id)?.stage === 'won',
  )

  await click('[data-proposal="lead-4"]')
  await click('#workspace-dialog [data-action="close-dialog"]')
  check('cancelling an AI proposal creates no task', (await stored()).tasks.length === 4)
  await click('[data-proposal="lead-4"]')
  await click('[data-approve="lead-4"]')
  check(
    'approval creates one sample follow-up',
    (await stored()).tasks.filter((task) => task.id === 'ai-follow-up:lead-4').length === 1,
  )
  await page.navigate(`${base}/workspace?view=pipeline`)
  await click('[data-lead="lead-4"]')
  await click('#workspace-dialog [data-proposal="lead-4"]')
  check(
    'a saved proposal cannot be approved twice',
    (await evaluate(`document.querySelector('#workspace-dialog [data-approve]') === null`)) ===
      true,
  )

  await page.navigate(`${base}/workspace?view=knowledge`)
  await click('[data-action="new-document"]')
  await fill('#document-form [name="title"]', 'Frontend sample knowledge')
  await fill('#document-form [name="content"]', '<script>window.unsafeDraft = true</script>')
  await click('#document-form [type="submit"]')
  check('document form saves despite its named id field', (await stored()).documents.length === 4)
  check(
    'document markup is rendered as text',
    (await evaluate(`window.unsafeDraft === undefined`)) === true,
  )

  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await page.navigate(`${base}/workspace?view=pipeline`)
  check(
    'mobile pipeline defaults to a list',
    (await evaluate(
      `document.querySelector('[data-board-mode="list"]').getAttribute('aria-pressed')`,
    )) === 'true',
  )
  await click('#sidebar-open')
  check(
    'mobile navigation keeps the main content inert',
    (await evaluate(`document.querySelector('.workspace-main').inert`)) === true,
  )
  await click('#sidebar-close')
  check(
    'closing navigation restores the main content',
    (await evaluate(`document.querySelector('.workspace-main').inert`)) === false,
  )
  check(
    'mobile page has no horizontal overflow',
    (await evaluate(`document.documentElement.scrollWidth <= innerWidth`)) === true,
  )
  check(
    'no browser exceptions or failed resources',
    page.console_.length === 0 &&
      page.network_.every(
        (event) => event.phase !== 'failed' && !(event.phase === 'response' && event.status >= 400),
      ),
  )
} catch (error) {
  check(error instanceof Error ? error.message : String(error), false)
} finally {
  await page.close()
}
const failures = results.filter((result) => !result.ok)
console.log(`\n${results.length - failures.length}/${results.length} frontend checks passed`)
if (failures.length) process.exitCode = 1
