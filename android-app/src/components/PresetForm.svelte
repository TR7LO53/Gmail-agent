<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import type { PresetDraft } from '../lib/preset-form'
  import type { Slot } from '../core/types'

  export let draft: PresetDraft
  export let isEditing = false
  export let busy = false
  const dispatch = createEventDispatcher<{ save: void; cancel: void; delete: void }>()
  const slots: { id: Slot; label: string }[] = [
    { id: 'breakfast', label: '\u015aniadanie' },
    { id: 'lunch', label: 'Obiad' },
    { id: 'dinner', label: 'Kolacja' },
  ]
</script>

<main class="preset-screen">
  <header class="sub-header"><button class="text-button" type="button" disabled={busy} onclick={() => dispatch('cancel')}>Wróć</button><h1>{isEditing ? 'Edytuj produkt' : 'Nowy produkt'}</h1></header>
  <form class="preset-form" onsubmit={(event) => { event.preventDefault(); dispatch('save') }}>
    <fieldset>
      <legend>Produkt</legend>
      <label class="preset-name">Nazwa<input type="text" autocomplete="off" disabled={busy} bind:value={draft.name} /></label>
      <p class="preset-unit-note">Wartości odżywcze na 100 g</p>
      <label>Energia <span>kcal</span><input type="text" inputmode="decimal" disabled={busy} bind:value={draft.kcal} /></label>
      <label>Białko <span>g</span><input type="text" inputmode="decimal" disabled={busy} bind:value={draft.protein_g} /></label>
      <label>Węglowodany <span>g</span><input type="text" inputmode="decimal" disabled={busy} bind:value={draft.carbs_g} /></label>
      <label>Tłuszcz <span>g</span><input type="text" inputmode="decimal" disabled={busy} bind:value={draft.fat_g} /></label>
      <label>Waga jednej sztuki <span>g · opcjonalnie</span><input type="text" inputmode="decimal" disabled={busy} bind:value={draft.piece_weight_g} /></label>
    </fieldset>
    <fieldset class="slot-tags">
      <legend>Pory dnia</legend>
      {#each slots as slot (slot.id)}
        <label><input type="checkbox" value={slot.id} disabled={busy} bind:group={draft.slot_tags} />{slot.label}</label>
      {/each}
    </fieldset>
    <button class="primary preset-save" type="submit" disabled={busy}>{busy ? 'Zapisywanie…' : 'Zapisz produkt'}</button>
    {#if isEditing}<button class="preset-delete" type="button" disabled={busy} onclick={() => dispatch('delete')}>{busy ? 'Zapisywanie…' : 'Usuń produkt'}</button>{/if}
  </form>
</main>
