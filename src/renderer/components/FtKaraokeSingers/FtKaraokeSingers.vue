<template>
  <div class="karaokeSingers">
    <div class="karaokeSingersHeader">
      <h3 class="karaokeSingersTitle">
        {{ t('Karaoke.Singers') }}
      </h3>
      <label class="karaokeRotationLabel">
        {{ t('Karaoke.Rotation') }}
        <select
          class="karaokeRotation"
          :value="rotation"
          @change="setRotation($event.target.value)"
        >
          <option
            class="karaokeRotationFifo"
            value="fifo"
          >
            {{ t('Karaoke.Rotation Fifo') }}
          </option>
          <option
            class="karaokeRotationRoundRobin"
            value="round_robin"
          >
            {{ t('Karaoke.Rotation Round Robin') }}
          </option>
        </select>
      </label>
    </div>

    <p
      v-if="singers.length === 0"
      class="karaokeSingersEmpty"
    >
      {{ t('Karaoke.No Singers') }}
    </p>

    <ul
      v-else
      class="karaokeSingersList"
    >
      <li
        v-for="singer in singers"
        :key="singer.id"
        class="karaokeSinger"
        :class="{ isHost: singer.host, isActiveTurn: singer.id === nextSingerId }"
      >
        <span
          class="karaokeSingerColor"
          :style="{ backgroundColor: singer.color }"
        />
        <span class="karaokeSingerName">{{ singer.name }}</span>
        <span
          v-if="singer.host"
          class="karaokeSingerHost"
        >
          {{ t('Karaoke.Host') }}
        </span>
        <span
          v-if="singer.id === nextSingerId"
          class="karaokeSingerTurn"
        >
          {{ t('Karaoke.Your Turn') }}
        </span>
        <span class="karaokeSingerPending">{{ pendingFor(singer.id) }}</span>
        <input
          class="karaokeSingerToggle"
          type="checkbox"
          :checked="singer.active"
          :aria-label="singer.name"
          @change="toggleActive(singer)"
        >
        <button
          class="karaokeSingerRename"
          type="button"
          @click="rename(singer)"
        >
          {{ t('Karaoke.Rename') }}
        </button>
        <button
          class="karaokeSingerRelease"
          type="button"
          @click="release(singer)"
        >
          {{ t('Karaoke.Release Name') }}
        </button>
        <button
          class="karaokeSingerHost"
          type="button"
          @click="makeHost(singer)"
        >
          {{ t('Karaoke.Make Host') }}
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useStore } from 'vuex'
import { useI18n } from 'vue-i18n'

const store = useStore()
const { t } = useI18n()

const singers = computed(() => store.getters.getSingers)
const rotation = computed(() => store.getters.getKaraokeRotation)
const upcoming = computed(() => store.getters.getKaraokeUpcoming)

// Whose song plays next drives the "your turn" highlight. getKaraokeNext is the same
// rotation-aware pick the queue itself plays by (priority first, then the roster helper's
// nextSingerId under round_robin), so the highlight agrees with the queue in both modes; a
// queue-head proxy would name a different singer than rotation under round_robin.
const nextSingerId = computed(() => store.getters.getKaraokeNext?.singerId ?? null)

/**
 * @param {string} singerId
 * @returns {number}
 */
function pendingFor(singerId) {
  return upcoming.value.filter(item => item.singerId === singerId).length
}

// The reducer refuses any rotation string other than 'fifo' / 'round_robin', and the two options
// above are the only values this control can send.
/**
 * @param {string} mode
 */
function setRotation(mode) {
  store.dispatch('karaokeSetRotation', mode)
}

/**
 * @param {object} singer
 */
async function toggleActive(singer) {
  await store.dispatch('singerSetActive', { singerId: singer.id, active: !singer.active })
}

/**
 * @param {object} singer
 */
async function rename(singer) {
  const name = window.prompt(t('Karaoke.Rename'), singer.name)

  if (name !== null) {
    await store.dispatch('singerRename', { singerId: singer.id, name })
  }
}

/**
 * @param {object} singer
 */
async function release(singer) {
  await store.dispatch('singerRelease', { singerId: singer.id })
}

/**
 * @param {object} singer
 */
async function makeHost(singer) {
  await store.dispatch('singerSetHost', { singerId: singer.id })
}
</script>

<style scoped src="./FtKaraokeSingers.css" />
