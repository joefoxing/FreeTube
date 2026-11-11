<template>
  <div class="karaoke">
    <h2>
      <FontAwesomeIcon :icon="['fas', 'music']" />
      {{ t('Karaoke.Karaoke Mode') }}
    </h2>

    <div class="karaokeSearchRow">
      <input
        v-model="query"
        class="karaokeSearchInput"
        type="text"
        :aria-label="t('Karaoke.Search Karaoke')"
        :placeholder="t('Karaoke.Search Karaoke')"
        @keydown.enter="search"
      >
      <button
        class="karaokeSearchButton"
        type="button"
        @click="search"
      >
        {{ t('Karaoke.Search Karaoke') }}
      </button>
    </div>

    <div class="karaokeOptions">
      <label>
        <input
          v-model="unfiltered"
          class="karaokeUnfiltered"
          type="checkbox"
        >
        {{ t('Karaoke.Show Unfiltered Results') }}
      </label>
      <label>
        {{ t('Karaoke.Min Duration') }}
        <input
          v-model.number="minSeconds"
          class="karaokeMinSeconds"
          type="number"
          min="1"
        >
      </label>
      <label>
        {{ t('Karaoke.Max Duration') }}
        <input
          v-model.number="maxSeconds"
          class="karaokeMaxSeconds"
          type="number"
          min="1"
        >
      </label>
      <button
        class="karaokeLeave"
        type="button"
        @click="leave"
      >
        {{ t('Karaoke.Leave Karaoke Mode') }}
      </button>
    </div>

    <FtKaraokeSingers />

    <FtLoader v-if="isLoading" />

    <p
      v-else-if="results.length === 0 && searched"
      class="karaokeNoResults"
    >
      {{ t('Karaoke.No Karaoke Results') }}
    </p>

    <div
      v-else
      class="karaokeResults"
    >
      <div
        v-for="video in results"
        :key="video.videoId"
        class="karaokeResult"
      >
        <img
          class="karaokeResultThumbnail"
          :src="thumbnailOf(video)"
          alt=""
        >
        <div class="karaokeResultMeta">
          <p class="karaokeResultTitle">
            {{ video.title }}
          </p>
          <p class="karaokeResultChannel">
            {{ video.author ?? video.channelName }}
          </p>
        </div>
        <button
          class="karaokeResultQueue"
          type="button"
          @click="queue(video, false)"
        >
          {{ t('Karaoke.Add To Queue') }}
        </button>
        <button
          class="karaokeResultPriority"
          type="button"
          @click="queue(video, true)"
        >
          {{ t('Karaoke.Play Next') }}
        </button>
      </div>
    </div>

    <FtKaraokeQueue @play="play" />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import FtLoader from '../../components/FtLoader/FtLoader.vue'
import FtKaraokeQueue from '../../components/FtKaraokeQueue/FtKaraokeQueue.vue'
import FtKaraokeSingers from '../../components/FtKaraokeSingers/FtKaraokeSingers.vue'

import store from '../../store'

import { showToast } from '../../helpers/utils'
import {
  buildKaraokeQuery,
  filterKaraokeResults,
  needsAnotherPage,
  videoSeconds
} from '../../helpers/karaoke.js'
import { getLocalSearchResults } from '../../helpers/api/local'
import { getInvidiousSearchResults } from '../../helpers/api/invidious'

const { t } = useI18n()
const router = useRouter()

const query = ref('')
const results = ref([])
const isLoading = ref(false)
const searched = ref(false)

const backendPreference = computed(() => store.getters.getBackendPreference)
const showFamilyFriendlyOnly = computed(() => store.getters.getShowFamilyFriendlyOnly)
const settings = computed(() => store.state.karaoke.settings)

const filterOn = computed({
  get: () => settings.value.filterOn,
  set: value => store.dispatch('karaokeSetSettings', { filterOn: value })
})

// The checkbox's label reads "Show unfiltered results", so it is bound to the
// inverse of the stored `filterOn` flag: unchecked by default (karaoke-only),
// checked shows unfiltered results.
const unfiltered = computed({
  get: () => !settings.value.filterOn,
  set: value => store.dispatch('karaokeSetSettings', { filterOn: !value })
})

const minSeconds = computed({
  get: () => settings.value.minSeconds,
  set: value => store.dispatch('karaokeSetSettings', { minSeconds: Number(value) || 90 })
})

const maxSeconds = computed({
  get: () => settings.value.maxSeconds,
  set: value => store.dispatch('karaokeSetSettings', { maxSeconds: Number(value) || 720 })
})

/** The filters YouTube itself takes; the karaoke rules are ours, above them. */
function searchSettings() {
  return { prioritize: 'relevance', time: '', type: 'video', duration: '', features: [] }
}

/**
 * @param {object} video
 * @returns {string}
 */
function thumbnailOf(video) {
  return video.videoThumbnails?.[0]?.url ?? video.thumbnail ?? ''
}

async function search() {
  const text = buildKaraokeQuery(query.value)

  isLoading.value = true
  results.value = []
  searched.value = true

  if (text === '') {
    isLoading.value = false

    return
  }

  const bounds = { minSeconds: settings.value.minSeconds, maxSeconds: settings.value.maxSeconds }

  try {
    let kept = []

    if (backendPreference.value === 'local') {
      // The local backend hands back no continuation ref at this stage, so this is
      // deliberately a single-page call: one request, no paging loop.
      const response = await getLocalSearchResults(text, searchSettings(), showFamilyFriendlyOnly.value)
      const usable = (response?.results ?? []).filter(video => video.type === 'video')
      kept = filterOn.value ? filterKaraokeResults(usable, bounds) : usable
    } else {
      let page = 1

      while (true) {
        const batch = await getInvidiousSearchResults(text, page, searchSettings())

        const usable = (batch ?? []).filter(video => video.type === 'video')
        kept = kept.concat(filterOn.value ? filterKaraokeResults(usable, bounds) : usable)

        if (!needsAnotherPage(kept.length, page)) {
          break
        }

        page += 1
      }
    }

    results.value = kept
  } catch (error) {
    console.error(error)
    showToast(t('Karaoke.Karaoke Search Failed'))
  } finally {
    isLoading.value = false
  }
}

/**
 * @param {object} video
 * @param {boolean} priority
 */
async function queue(video, priority) {
  const code = await store.dispatch('karaokeAdd', {
    videoId: video.videoId,
    title: video.title,
    channel: video.author ?? video.channelName ?? '',
    durationSeconds: videoSeconds(video),
    thumbnail: thumbnailOf(video),
    priority
  })

  if (code === 'E_DUPLICATE') {
    showToast(t('Karaoke.Already Queued'))
  } else if (code === 'E_PRIORITY_CAP') {
    showToast(t('Karaoke.Priority Limit Reached'))
  } else if (code !== null) {
    showToast(t('Karaoke.Cannot Queue'))
  }
}

/**
 * @param {object} item
 */
async function play(item) {
  await store.dispatch('karaokeStart', item.id)
  router.push({ path: `/watch/${item.videoId}` })
}

async function leave() {
  await store.dispatch('karaokeSetActive', false)
  router.push({ path: '/' })
}

onMounted(() => {
  store.dispatch('karaokeSetActive', true)
  store.commit('setAppTitle', t('Karaoke.Karaoke'))
})
</script>

<style scoped src="./Karaoke.css" />
