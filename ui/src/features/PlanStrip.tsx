import type { PlanEntry } from '../lib/types'

export function PlanStrip({ plan }: { plan: PlanEntry[] }) {
  if (plan.length === 0) return null
  const done = plan.filter((p) => p.status === 'completed').length
  const active = plan.find((p) => p.status === 'in_progress')

  return (
    <details className="plan">
      <summary>
        Plan: {done}/{plan.length} done{active ? ` — ${active.activeForm ?? active.content}` : ''}
      </summary>
      <ul>
        {plan.map((entry, i) => (
          <li key={`${i}-${entry.content}`} className={entry.status}>
            {entry.content}
          </li>
        ))}
      </ul>
    </details>
  )
}
