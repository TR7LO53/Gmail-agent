<script lang="ts">
  import { onMount } from 'svelte'
  import { Capacitor } from '@capacitor/core'
  import { addOnePiece, macrosForGrams, rescaleFoodLogEntry } from './core/macros'
  import { orderPresetTiles } from './core/tile-order'
  import type { Preset } from './core/types'
  import { FoodRepository, type StoredEntry, type StoredPreset } from './data/food-repository'
  import { openFoodDatabase } from './data/sqlite'
  import { backspace, appendDecimal, appendDigit, parseGrams } from './lib/grams-input'
  import { GOALS, PantryState } from './lib/pantry-state'

  let state: PantryState | undefined
  let loading = true
  let error = ''
  let dbStatus = ''
  let screen: 'pantry' | 'pad' | 'entries' = 'pantry'
  let search = ''
  let chosen: StoredPreset | undefined
  let editing: StoredEntry | undefined
  let gramsText = ''
  let saving = false
  let deleting = 0
  let devBuild = import.meta.env.MODE === 'development'
  $: grams = parseGrams(gramsText)
  $: preview = (chosen || editing) && gramsText ? editing ? (() => { try { return rescaleFoodLogEntry(editing, Number(gramsText.replace(',', '.'))) } catch { return undefined } })() : (chosen && Number.isFinite(Number(gramsText.replace(',', '.'))) && Number(gramsText.replace(',', '.')) >= 0 ? macrosForGrams(chosen, Number(gramsText.replace(',', '.'))) : undefined) : undefined
  $: ordered = state ? orderPresetTiles(state.presets, state.slot, search) : []
  $: remaining = state ? GOALS.kcal - state.totals.kcal : GOALS.kcal

  async function start() {
    loading = true; error = ''
    try {
      const db = await openFoodDatabase()
      const nextState = new PantryState(new FoodRepository(db))
      await nextState.refresh()
      state = nextState
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Nie udało się uruchomić bazy danych.' }
    finally { loading = false }
  }
  onMount(() => {
    void start()
    const refresh = () => { if (document.visibilityState === 'visible' && state) void state.refresh().catch(() => { error = state?.error ?? 'Błąd odświeżania.' }) }
    document.addEventListener('visibilitychange', refresh)
    const timer = window.setInterval(refresh, 60_000)
    return () => { document.removeEventListener('visibilitychange', refresh); window.clearInterval(timer) }
  })
  function openPreset(preset: Preset) { chosen = state?.presets.find((item) => item.id === Number(preset.id)); editing = undefined; gramsText = ''; screen = 'pad' }
  function openEdit(entry: StoredEntry) {
    editing = entry; chosen = state?.presets.find((p) => p.id === entry.preset_id)
    gramsText = String(entry.qty).replace('.', ','); screen = 'pad'
  }
  function cancelPad() { const wasEditing = Boolean(editing); chosen = undefined; editing = undefined; gramsText = ''; screen = wasEditing ? 'entries' : 'pantry' }
  async function save() {
    if (!state || !grams || saving || (editing && !editing.id) || (!editing && !chosen)) return
    saving = true; error = ''
    try {
      if (editing) await state.update(editing.id, grams)
      else await state.add(chosen!.id, grams)
      const wasEditing = Boolean(editing)
      chosen = undefined; editing = undefined; gramsText = ''; screen = wasEditing ? 'entries' : 'pantry'
    } catch { error = 'Nie udało się zapisać. Sprawdź dane i spróbuj ponownie.' }
    finally { saving = false }
  }
  async function removeEntry(entry: StoredEntry) {
    if (!state || deleting) return
    deleting = entry.id; error = ''
    try { await state.remove(entry.id) } catch { error = 'Nie udało się usunąć wpisu. Spróbuj ponownie.' }
    finally { deleting = 0 }
  }
  async function seed() {
    if (!state) return
    dbStatus = ''
    try { const { seedPresets } = await import('./dev/seed-presets'); await seedPresets(new FoodRepository(await openFoodDatabase())); await state.refresh(); dbStatus = 'Produkty testowe są gotowe.' }
    catch { dbStatus = 'Nie udało się wczytać produktów testowych.' }
  }
  function plusPiece() {
    if (!chosen) return
    try { const result = addOnePiece(chosen, Number(gramsText.replace(',', '.')) || 0); gramsText = String(result.qty).replace('.', ',') } catch { /* no valid piece weight */ }
  }
  function timeLabel(ts: string) { return new Date(ts).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) }
</script>

{#if loading}
  <main class="center-state" aria-live="polite">Otwieranie Pantry…</main>
{:else if error && !state}
  <main class="center-state"><p>{Capacitor.isNativePlatform() ? error : 'Trwała baza SQLite Pantry działa w aplikacji Android. Otwórz aplikację na telefonie.'}</p>{#if Capacitor.isNativePlatform()}<button class="primary" onclick={start}>Spróbuj ponownie</button>{/if}</main>
{:else if !Capacitor.isNativePlatform() && !state}
  <main class="center-state">Trwała baza SQLite Pantry działa w aplikacji Android. Otwórz aplikację na telefonie.</main>
{:else if screen === 'pad' && (chosen || editing)}
  <main class="pad-screen">
    <header class="pad-header"><button class="text-button" onclick={cancelPad} aria-label="Anuluj i wróć">‹ Wróć</button><div><span>{editing ? 'Edycja wpisu' : 'Dodawanie produktu'}</span><h1>{editing?.name ?? chosen?.name}</h1></div></header>
    {#if error}<p class="alert" role="alert">{error}</p>{/if}
    <section class="amount" aria-live="polite"><strong>{gramsText || '0'} <small>g</small></strong><p>{Math.round(preview?.kcal ?? 0)} kcal</p><div class="macro-preview">B {preview?.protein_g ?? 0} g <span>W {preview?.carbs_g ?? 0} g</span><span>T {preview?.fat_g ?? 0} g</span></div></section>
    <section class="keypad" aria-label="Klawiatura gramów">
      {#each ['1','2','3','4','5','6','7','8','9',',','0','⌫'] as key}
        <button aria-label={key === '⌫' ? 'Usuń ostatnią cyfrę' : key} onclick={() => gramsText = key === '⌫' ? backspace(gramsText) : key === ',' ? appendDecimal(gramsText) : appendDigit(gramsText, key)}>{key}</button>
      {/each}
    </section>
    {#if chosen?.piece_weight_g && chosen.piece_weight_g > 0}<button class="piece-button" onclick={plusPiece}>+1 szt. ({chosen.piece_weight_g} g)</button>{/if}
    <button class="primary add-button" disabled={!grams || saving} onclick={save}>{saving ? 'Zapisywanie…' : editing ? 'Zapisz' : `Dodaj ${Math.round(preview?.kcal ?? 0)} kcal`}</button>
  </main>
{:else if screen === 'entries'}
  <main class="app-screen">
    <header class="sub-header"><button class="text-button" onclick={() => screen = 'pantry'}>‹ Pantry</button><h1>Dziś zjedzone</h1></header>
    {#if error}<p class="alert" role="alert">{error}</p>{/if}
    {#if state?.entries.length}
      <ul class="entry-list">{#each state.entries as entry (entry.id)}<li><div class="entry-time">{timeLabel(entry.ts)}</div><div class="entry-info"><strong>{entry.name}</strong><span>{entry.qty} g · {entry.kcal} kcal</span></div><button class="small-button" aria-label={`Edytuj ${entry.name}`} onclick={() => openEdit(entry)}>Edytuj</button><button class="icon-button danger" aria-label={`Usuń ${entry.name}`} disabled={deleting === entry.id} onclick={() => removeEntry(entry)}>×</button></li>{/each}</ul>
    {:else}<p class="empty">Brak wpisów na dziś.</p>{/if}
  </main>
{:else}
  <main class="app-screen">
    <button class="summary" onclick={() => screen = 'entries'} aria-label="Otwórz dzisiejsze wpisy">
      <div class="summary-top"><span>{remaining >= 0 ? 'Zostało na dziś' : 'Ponad cel o'}</span><strong>{Math.abs(remaining)} kcal</strong></div>
      <div class="progress"><i style={`width:${Math.min(100, state ? state.totals.kcal / GOALS.kcal * 100 : 0)}%`}></i></div>
      <div class="summary-bottom"><span>B <b>{(GOALS.protein_g - (state?.totals.protein_g ?? 0)).toFixed(1)} g</b></span><span>W <b>{(GOALS.carbs_g - (state?.totals.carbs_g ?? 0)).toFixed(1)} g</b></span><span>T <b>{(GOALS.fat_g - (state?.totals.fat_g ?? 0)).toFixed(1)} g</b></span><span>Dziś zjedzone ›</span></div>
    </button>
    <section class="pantry-body"><label class="search"><span aria-hidden="true">⌕</span><input bind:value={search} placeholder="Szukaj produktu" aria-label="Szukaj produktu" /></label>
      {#if error}<p class="alert" role="alert">{error}</p><button class="small-button" onclick={() => state?.refresh().catch(() => {})}>Odśwież</button>
      {:else if !state?.presets.length}<p class="empty">Brak produktów. Dodaj je później w formularzu.</p>
      {:else if !ordered.length}<p class="empty">Brak produktów pasujących do wyszukiwania.</p>{/if}
      <div class="tile-grid">{#each ordered as preset (preset.id)}<button class="tile" onclick={() => openPreset(preset)}><strong>{preset.name}</strong><span>{preset.kcal} kcal / 100 g</span></button>{/each}<button class="tile new-tile" onclick={() => {}}><strong>＋ Nowy produkt</strong><span>Wkrótce</span></button></div>
      {#if devBuild}<button class="seed-button" onclick={seed}>Wczytaj produkty testowe</button>{#if dbStatus}<p class="seed-status">{dbStatus}</p>{/if}{/if}
    </section>
  </main>
{/if}
