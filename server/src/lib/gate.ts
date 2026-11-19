// Step 4: the deterministic gate (validator). The real test is Run in XPLAN on a test client.
import { catalog } from './catalog.js'
import { check, type CheckResult } from './validator.js'
import { notHeld } from './flow.js'
import { ensureSiteFlags, groupsInTemplate } from './siteflags.js'

export interface GateResult {
  check: CheckResult
  problems: string[] // what a repair must fix: the blocking issues
  review: string[] // fields a person must approve
  notHeld: string[] // data points the design wanted but XPLAN does not hold
}

export async function gate(template: string): Promise<GateResult> {
  await ensureSiteFlags(groupsInTemplate(template)) // no-op unless signed in to a site; cached per group
  const chk = check(template, catalog)
  return {
    check: chk,
    problems: chk.issues.filter((i) => i.severity === 'block').map((i) => (i.line ? `line ${i.line}: ${i.message}` : i.message)),
    review: chk.issues.filter((i) => i.severity === 'review').map((i) => i.message),
    notHeld: notHeld(template),
  }
}
