<script lang="ts">
  import type { DayTotals } from '../core/types'
  import type { StoredEntry } from '../data/food-repository'
  import { chartScale, localDateLabel } from '../lib/history'

  export let days: DayTotals[] = []
  export let entries: StoredEntry[] = []
  export let selectedDate = ''
  export let goal = 2000
  export let error = ''
  export let onBack: () => void
  export let onSelect: (date: string) => void
  export let onRetry: () => void

  $: scale = chartScale(days, goal)
  $: goalPosition = Math.min(100, Math.max(0, goal / scale * 100))
  $: goalBottom = 47 + 173 * goalPosition / 100
  $: selectedLabel = selectedDate ? localDateLabel(selectedDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : ''
  function timeLabel(ts: string) { return new Date(ts).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) }
</script>

<main class="history-screen">
  <header class="sub-header">
    <button class="text-button" onclick={onBack}>← Pantry</button>
    <h1>Historia</h1>
  </header>
  {#if error}
    <div class="history-error"><p class="alert" role="alert">{error}</p><button class="small-button" onclick={onRetry}>Odśwież</button></div>
  {/if}
  <section class="history-chart" aria-label="Spożycie kalorii w ostatnich siedmiu dniach">
    <div class="history-goal-label">Cel {goal} kcal</div>
    <div class="chart-plot" style={`--goal-bottom:${goalBottom}px`}>
      <div class="goal-line" aria-hidden="true"></div>
      {#each days as day (day.date)}
        <button class:chosen={day.date === selectedDate} class="chart-day" aria-pressed={day.date === selectedDate}
          aria-label={`${localDateLabel(day.date, { weekday: 'long', day: 'numeric', month: 'long' })}: ${day.kcal} kcal`}
          onclick={() => onSelect(day.date)}>
          <span class="bar-track"><span class="bar-fill" style={`height:${day.kcal ? day.kcal / scale * 100 : 0}%`}></span></span>
          <strong class="bar-value">{day.kcal}</strong>
          <span class="bar-date">{localDateLabel(day.date, { day: 'numeric', month: 'numeric' })}</span>
        </button>
      {/each}
    </div>
    <p class="history-unit">kcal · przerywana linia oznacza cel</p>
  </section>
  <section class="history-day" aria-live="polite">
    <h2>{selectedLabel}</h2>
    {#if entries.length}
      <ul class="history-entry-list">
        {#each entries as entry (entry.id)}
          <li><time>{timeLabel(entry.ts)}</time><div class="history-entry-info"><strong>{entry.name}</strong><span>{entry.qty} {entry.unit} · {entry.kcal} kcal</span></div></li>
        {/each}
      </ul>
    {:else}
      <p class="empty">Brak wpisów tego dnia.</p>
    {/if}
  </section>
</main>
