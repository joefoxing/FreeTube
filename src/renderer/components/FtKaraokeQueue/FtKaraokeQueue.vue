<template>
  <div class="karaokeQueue">
    <div
      v-if="current"
      class="karaokeQueueCurrent"
    >
      <span class="karaokeQueueLabel">{{ t('Karaoke.Now Singing') }}</span>
      <span class="karaokeQueueTitle">{{ current.title }}</span>
      <span
        v-if="currentVotes > 0"
        class="karaokeQueueVotes"
      >
        {{ t('Karaoke.Vote Mark') }} {{ currentVotes }}
      </span>
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
        :class="{
          isPriority: item.priority,
          isDragging: index === dragFrom,
          isDropTarget: index === dragOver && index !== dragFrom
        }"
        :draggable="reorderable"
        @dragstart="dragStart(index, $event)"
        @dragover.prevent="dragOver = index"
        @dragend="clearDrag"
        @drop.prevent="dropOn(index)"
      >
        <span class="karaokeQueuePosition">{{ index + 1 }}</span>
        <span class="karaokeQueueTitle">{{ item.title }}</span>
        <span
          v-if="item.priority"
          class="karaokeQueueBadge"
        >
          {{ t('Karaoke.Priority') }}
        </span>
        <span
          v-if="voteCount(item.id) > 0"
          class="karaokeQueueVotes"
          :title="t('Karaoke.Votes')"
        >
          {{ t('Karaoke.Vote Mark') }} {{ voteCount(item.id) }}
        </span>
        <span
          v-if="topVotedId === item.id"
          class="karaokeQueueBadge topVoted"
        >
          {{ t('Karaoke.Top Voted') }}
        </span>
        <template v-if="!compact">
          <button
            class="karaokeQueueButton move"
            type="button"
            :title="t('Karaoke.Move Up')"
            :aria-label="t('Karaoke.Move Up')"
            :disabled="stepTarget(item, 'up') === null"
            @click="step(item, 'up')"
          >
            {{ t('Karaoke.Move Up Mark') }}
          </button>
          <button
            class="karaokeQueueButton move"
            type="button"
            :title="t('Karaoke.Move Down')"
            :aria-label="t('Karaoke.Move Down')"
            :disabled="stepTarget(item, 'down') === null"
            @click="step(item, 'down')"
          >
            {{ t('Karaoke.Move Down Mark') }}
          </button>
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
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useStore } from 'vuex'

import { dropToIndex, stepToIndex } from '../../helpers/karaoke-move.js'

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
const topVotedId = computed(() => store.getters.getKaraokeTopVotedId)
const currentVotes = computed(() => store.getters.getKaraokeVoteCount(current.value?.id))
// A one-row queue has nowhere to move to, and the watch page's three-row bar is a glance, not a
// reordering surface -- so drag is off there and on in the karaoke view.
const reorderable = computed(() => !props.compact && upcoming.value.length > 1)

// The drag in flight: which row is being dragged, and which one it is over. Kept in the component
// (not the store) because it is transient pointer state nothing else can observe.
const dragFrom = ref(null)
const dragOver = ref(null)

/**
 * @param {number} index
 * @param {DragEvent} event
 */
function dragStart(index, event) {
  dragFrom.value = index

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // Firefox refuses to start a drag whose dataTransfer carries nothing.
    event.dataTransfer.setData('text/plain', String(index))
  }
}

function clearDrag() {
  dragFrom.value = null
  dragOver.value = null
}

/**
 * The index a row would move to, or null when that move is impossible (the ends of the queue, a row
 * that is gone). The buttons read it to disable themselves, so the rule lives in one place.
 *
 * @param {object} item
 * @param {'up'|'down'} direction
 * @returns {number|null}
 */
function stepTarget(item, direction) {
  return stepToIndex(upcoming.value, item?.id, direction)
}

/**
 * @param {object} item
 * @param {'up'|'down'} direction
 */
function step(item, direction) {
  const toIndex = stepTarget(item, direction)

  if (toIndex !== null) {
    store.dispatch('karaokeMove', { id: item.id, toIndex })
  }
}

/**
 * @param {number} index the position the row was dropped at, in the displayed list
 */
function dropOn(index) {
  const from = dragFrom.value

  clearDrag()

  // Landing on its own slot is a dither, not an instruction: dispatching it would still commit a
  // new queue object (and a persistence write) for a no-op.
  if (from === null || from === index) return

  const toIndex = dropToIndex(from, index)

  if (toIndex !== null) {
    store.dispatch('karaokeMove', { id: shown.value[index].id, toIndex })
  }
}

/**
 * @param {string} id
 * @returns {number}
 */
function voteCount(id) {
  return store.getters.getKaraokeVoteCount(id)
}

/** @param {object} item */
function play(item) {
  emit('play', item)
}
</script>

<style scoped src="./FtKaraokeQueue.css" />
