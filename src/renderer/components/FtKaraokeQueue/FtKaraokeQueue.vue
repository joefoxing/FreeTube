<template>
  <div class="karaokeQueue">
    <div
      v-if="current"
      class="karaokeQueueCurrent"
    >
      <span class="karaokeQueueLabel">{{ t('Karaoke.Now Singing') }}</span>
      <span class="karaokeQueueTitle">{{ current.title }}</span>
    </div>

    <div
      v-if="upcoming.length === 0"
      class="karaokeQueueEmpty"
    >
      {{ t('Karaoke.Queue Empty') }}
    </div>

    <ol
      v-else
      class="karaokeQueueList"
    >
      <li
        v-for="(item, index) in shown"
        :key="item.id"
        class="karaokeQueueRow"
        :class="{ isPriority: item.priority }"
      >
        <span class="karaokeQueuePosition">{{ index + 1 }}</span>
        <span class="karaokeQueueTitle">{{ item.title }}</span>
        <span
          v-if="item.priority"
          class="karaokeQueueBadge"
        >
          {{ t('Karaoke.Priority') }}
        </span>
        <template v-if="!compact">
          <button
            class="karaokeQueueButton"
            type="button"
            @click="play(item)"
          >
            {{ t('Karaoke.Play Now') }}
          </button>
          <button
            class="karaokeQueueButton"
            type="button"
            @click="$store.dispatch('karaokePromote', item.id)"
          >
            {{ t('Karaoke.Play Next') }}
          </button>
          <button
            class="karaokeQueueButton"
            type="button"
            @click="$store.dispatch('karaokeRemove', item.id)"
          >
            {{ t('Karaoke.Remove') }}
          </button>
        </template>
      </li>
    </ol>

    <button
      v-if="!compact && upcoming.length > 0"
      class="karaokeQueueButton clear"
      type="button"
      @click="$store.dispatch('karaokeClear')"
    >
      {{ t('Karaoke.Clear Queue') }}
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useStore } from 'vuex'

const props = defineProps({
  compact: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['play'])

const { t } = useI18n()
const store = useStore()

const current = computed(() => store.getters.getKaraokeCurrent)
const upcoming = computed(() => store.getters.getKaraokeUpcoming)
// The bar on the watch page shows what is next, not the whole night.
const shown = computed(() => (props.compact ? upcoming.value.slice(0, 3) : upcoming.value))

/** @param {object} item */
function play(item) {
  emit('play', item)
}
</script>

<style scoped src="./FtKaraokeQueue.css" />
