<template>
  <div
    v-if="visible"
    class="transcriptOverlay"
  >
    <div class="transcriptHeader">
      <span class="transcriptTitle">
        {{ t('Video.Player.Transcribe.Transcribe') }}
      </span>
      <span class="transcriptWindow">
        {{ windowLabel }}
      </span>
      <FtIconButton
        :title="t('Video.Player.Transcribe.Close')"
        :icon="['fas', 'xmark']"
        theme="base"
        @click="$emit('close')"
      />
    </div>

    <div
      v-if="isBusy"
      class="transcriptBusy"
    >
      <FtLoader :fullscreen="false" />
      <p class="transcriptStage">
        {{ stageLabel }}<span v-if="progress > 0"> · {{ Math.round(progress * 100) }}%</span>
      </p>
      <FtButton
        :label="t('Video.Player.Transcribe.Cancel')"
        @click="$emit('cancel')"
      />
    </div>

    <div
      v-else-if="state === 'error'"
      class="transcriptError"
    >
      <p>{{ t(mapTranscribeError(errorCode)) }}</p>
      <FtButton
        :label="t('Video.Player.Transcribe.Retry')"
        @click="$emit('retry')"
      />
    </div>

    <template v-else>
      <div class="transcriptBody">
        <p
          v-if="segments.length === 0"
          class="transcriptEmpty"
        >
          {{ t('Video.Player.Transcribe.Empty') }}
        </p>
        <button
          v-for="segment in segments"
          :key="`${segment.start}-${segment.end}`"
          class="transcriptLine"
          @click="$emit('seek', segment.start)"
        >
          <span class="transcriptLineTime">{{ formatTimestamp(segment.start) }}</span>
          <span class="transcriptLineText">{{ segment.text }}</span>
        </button>
      </div>
      <div class="transcriptFooter">
        <FtButton
          :label="copied ? t('Video.Player.Transcribe.Copied') : t('Video.Player.Transcribe.Copy Transcript')"
          @click="$emit('copy')"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import FtButton from '../FtButton/FtButton.vue'
import FtIconButton from '../FtIconButton/FtIconButton.vue'
import FtLoader from '../FtLoader/FtLoader.vue'

import { formatTimestamp, mapTranscribeError } from '../../helpers/transcript'

const props = defineProps({
  visible: { type: Boolean, default: false },
  state: { type: String, default: 'idle' },
  stage: { type: String, default: 'queued' },
  progress: { type: Number, default: 0 },
  segments: { type: Array, default: () => [] },
  errorCode: { type: String, default: '' },
  windowStart: { type: Number, default: 0 },
  windowEnd: { type: Number, default: 0 },
  copied: { type: Boolean, default: false }
})

defineEmits(['close', 'retry', 'cancel', 'copy', 'seek'])

const { t } = useI18n()

const isBusy = computed(() => props.state === 'queued' || props.state === 'running')

const stageLabel = computed(() => {
  switch (props.stage) {
    case 'fetching':
      return t('Video.Player.Transcribe.Fetching audio')
    case 'decoding':
      return t('Video.Player.Transcribe.Decoding audio')
    case 'transcribing':
      return t('Video.Player.Transcribe.Transcribing')
    default:
      return t('Video.Player.Transcribe.Transcribing')
  }
})

const windowLabel = computed(() => `${formatTimestamp(props.windowStart)} – ${formatTimestamp(props.windowEnd)}`)
</script>

<style scoped src="./FtTranscript.css" />
