<script lang="ts">
  import { appTitle } from './lib/app-title'
</script>

<main>
  <section class="welcome" aria-labelledby="app-title">
    <div class="mark" aria-hidden="true">G</div>
    <p class="eyebrow">Twoja codzienna przestrzeń</p>
    <h1 id="app-title">{appTitle}</h1>
    <p class="message">Aplikacja jest gotowa na kolejny krok.</p>
  </section>
</main>
