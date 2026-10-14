<script lang="ts">
  import { onMount } from 'svelte'
  import { Capacitor } from '@capacitor/core'
  import { addOnePiece, macrosForGrams, rescaleFoodLogEntry } from './core/macros'
  import { copySettings, type AppSettings } from './core/settings'
  import { orderPresetTiles } from './core/tile-order'
  import type { Preset } from './core/types'
  import { FoodRepository, type StoredEntry, type StoredPreset } from './data/food-repository'
  import { SettingsRepository } from './data/settings-repository'
  import { openFoodDatabase } from './data/sqlite'
  import { backspace, appendDecimal, appendDigit, parseGrams } from './lib/grams-input'
  import { PantryState } from './lib/pantry-state'

  let state: PantryState | undefined
  let loading = true
  let error = ''
  let dbStatus = ''
  let screen: 'pantry' | 'pad' | 'entries' | 'settings' = 'pantry'
  let search = ''
  let chosen: StoredPreset | undefined
  let editing: StoredEntry | undefined
  let gramsText = ''
  let saving = false
  let deleting = 0
  let devBuild = import.meta.env.MODE === 'development'
  let settingsDraft = { kcal: '', protein_g: '', carbs_g: '', fat_g: '', lunchStart: '11:00', dinnerStart: '17:00' }
  $: grams = parseGrams(gramsText)
  $: preview = (chosen || editing) && gramsText ? editing ? (() => { try { return rescaleFoodLogEntry(editing, Number(gramsText.replace(',', '.'))) } catch { return undefined } })() : (chosen && Number.isFinite(Number(gramsText.replace(',', '.'))) && Number(gramsText.replace(',', '.')) >= 0 ? macrosForGrams(chosen, Number(gramsText.replace(',', '.'))) : undefined) : undefined
  $: ordered = state ? orderPresetTiles(state.presets, state.slot, search) : []
  $: goals = state?.goals ?? { kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 70 }
  $: remaining = goals.kcal - (state?.totals.kcal ?? 0)

  async function start() {
    loading = true; error = ''
    try {
      const db = await openFoodDatabase()
      const nextState = new PantryState(new FoodRepository(db), () => new Date(), new SettingsRepository(db))
      await nextState.loadSettings()
      await nextState.refresh()
      state = nextState
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Nie udało się uruchomić bazy danych.' }
    finally { loading = false }
  }
  onMount(() => {
    void start()
    const refresh = () => { if (document.visibilityState === 'visible' && state) void state.refresh().then(() => { state = state }).catch(() => { error = state?.error ?? 'Błąd odświeżania.' }) }
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
      state = state
      const wasEditing = Boolean(editing)
      chosen = undefined; editing = undefined; gramsText = ''; screen = wasEditing ? 'entries' : 'pantry'
    } catch { error = 'Nie udało się zapisać. Sprawdź dane i spróbuj ponownie.' }
    finally { saving = false }
  }
  async function removeEntry(entry: StoredEntry) {
    if (!state || deleting) return
    deleting = entry.id; error = ''
    try { await state.remove(entry.id); state = state } catch { error = 'Nie udało się usunąć wpisu. Spróbuj ponownie.' }
    finally { deleting = 0 }
  }
  async function seed() {
    if (!state) return
    dbStatus = ''
    try { const { seedPresets } = await import('./dev/seed-presets'); await seedPresets(new FoodRepository(await openFoodDatabase())); await state.refresh(); state = state; dbStatus = 'Produkty testowe są gotowe.' }
    catch { dbStatus = 'Nie udało się wczytać produktów testowych.' }
  }
  function plusPiece() {
    if (!chosen) return
    try { const result = addOnePiece(chosen, Number(gramsText.replace(',', '.')) || 0); gramsText = String(result.qty).replace('.', ',') } catch { /* no valid piece weight */ }
  }
  function timeLabel(ts: string) { return new Date(ts).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) }
  function clockText(minute: number) { return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}` }
  function openSettings() {
    if (!state) return
    const value = copySettings(state.settings)
    settingsDraft = { kcal: String(value.goals.kcal), protein_g: String(value.goals.protein_g), carbs_g: String(value.goals.carbs_g), fat_g: String(value.goals.fat_g), lunchStart: clockText(value.boundaries.lunchStart), dinnerStart: clockText(value.boundaries.dinnerStart) }
    error = ''; screen = 'settings'
  }
  function parseClock(value: string): number {
    const match = /^(\d{2}):(\d{2})$/.exec(value)
    if (!match) throw new Error('Podaj godzinę w formacie HH:mm.')
    const hour = Number(match[1]), minute = Number(match[2])
    if (hour > 23 || minute > 59) throw new Error('Godzina musi mieścić się w zakresie 00:00–23:59.')
    return hour * 60 + minute
  }
  async function saveSettings() {
    if (!state || saving) return
    saving = true; error = ''
    try {
      const number = (text: string) => { const trimmed = text.trim(); if (!trimmed) throw new Error('Uzupełnij wszystkie cele.'); const parsed = Number(trimmed.replace(',', '.')); if (!Number.isFinite(parsed)) throw new Error('Podaj poprawne wartości liczbowe.'); return parsed }
      const value: AppSettings = { goals: { kcal: number(settingsDraft.kcal), protein_g: number(settingsDraft.protein_g), carbs_g: number(settingsDraft.carbs_g), fat_g: number(settingsDraft.fat_g) }, boundaries: { lunchStart: parseClock(settingsDraft.lunchStart), dinnerStart: parseClock(settingsDraft.dinnerStart) } }
      await state.saveSettings(value); state = state; screen = 'pantry'
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Nie udało się zapisać ustawień.' }
    finally { saving = false }
  }
  function cancelSettings() { error = ''; screen = 'pantry' }
  async function refreshData() {
    if (!state) return
    try { await state.refresh(); state = state }
    catch { error = state.error || 'Błąd odświeżania.' }
  }
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
{:else if screen === 'settings'}
  <main class="settings-screen">
    <header class="sub-header"><button class="text-button" onclick={cancelSettings}>‹ Pantry</button><h1>Ustawienia</h1></header>
    {#if error}<p class="alert" role="alert">{error}</p>{/if}
    <form class="settings-form" onsubmit={(event) => { event.preventDefault(); void saveSettings() }}>
      <fieldset><legend>Cele dzienne</legend>
        <label>Energia <span>kcal</span><input type="text" inputmode="decimal" bind:value={settingsDraft.kcal} /></label>
        <label>Białko <span>g</span><input type="text" inputmode="decimal" bind:value={settingsDraft.protein_g} /></label>
        <label>Węglowodany <span>g</span><input type="text" inputmode="decimal" bind:value={settingsDraft.carbs_g} /></label>
        <label>Tłuszcz <span>g</span><input type="text" inputmode="decimal" bind:value={settingsDraft.fat_g} /></label>
      </fieldset>
      <fieldset><legend>Granice Slot</legend><p>Godziny zmieniają kolejność kafelków z odpowiednimi tagami.</p>
        <label>Początek obiadu<input type="time" bind:value={settingsDraft.lunchStart} /></label>
        <label>Początek kolacji<input type="time" bind:value={settingsDraft.dinnerStart} /></label>
      </fieldset>
      <button class="primary settings-save" type="submit" disabled={saving}>{saving ? 'Zapisywanie…' : 'Zapisz'}</button>
    </form>
  </main>
{:else}
  <main class="app-screen">
    <nav class="pantry-nav"><button class="small-button" onclick={openSettings} aria-label="Ustawienia">⚙ Ustawienia</button></nav>
    <button class="summary" onclick={() => screen = 'entries'} aria-label="Otwórz dzisiejsze wpisy">
      <div class="summary-top"><span>{remaining >= 0 ? 'Zostało na dziś' : 'Ponad cel o'}</span><strong>{Math.abs(remaining)} kcal</strong></div>
      <div class="progress"><i style={`width:${Math.min(100, state ? state.totals.kcal / goals.kcal * 100 : 0)}%`}></i></div>
      <div class="summary-bottom"><span>B <b>{(goals.protein_g - (state?.totals.protein_g ?? 0)).toFixed(1)} g</b></span><span>W <b>{(goals.carbs_g - (state?.totals.carbs_g ?? 0)).toFixed(1)} g</b></span><span>T <b>{(goals.fat_g - (state?.totals.fat_g ?? 0)).toFixed(1)} g</b></span><span>Dziś zjedzone ›</span></div>
    </button>
    <section class="pantry-body"><label class="search"><span aria-hidden="true">⌕</span><input bind:value={search} placeholder="Szukaj produktu" aria-label="Szukaj produktu" /></label>
      {#if error}<p class="alert" role="alert">{error}</p><button class="small-button" onclick={refreshData}>Odśwież</button>
      {:else if !state?.presets.length}<p class="empty">Brak produktów. Dodaj je później w formularzu.</p>
      {:else if !ordered.length}<p class="empty">Brak produktów pasujących do wyszukiwania.</p>{/if}
      <div class="tile-grid">{#each ordered as preset (preset.id)}<button class="tile" onclick={() => openPreset(preset)}><strong>{preset.name}</strong><span>{preset.kcal} kcal / 100 g</span></button>{/each}<button class="tile new-tile" onclick={() => {}}><strong>＋ Nowy produkt</strong><span>Wkrótce</span></button></div>
      {#if devBuild}<button class="seed-button" onclick={seed}>Wczytaj produkty testowe</button>{#if dbStatus}<p class="seed-status">{dbStatus}</p>{/if}{/if}
    </section>
  </main>
{/if}
