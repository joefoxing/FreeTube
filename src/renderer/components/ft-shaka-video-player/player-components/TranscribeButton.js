import shaka from 'shaka-player'

import i18n from '../../../i18n/index'
import { KeyboardShortcuts, PlayerIcons } from '../../../../constants'
import { addKeyboardShortcutToActionTitle } from '../../../helpers/utils'

export class TranscribeButton extends shaka.ui.Element {
  /**
   * @param {boolean} enabled
   * @param {EventTarget} events
   * @param {HTMLElement} parent
   * @param {shaka.ui.Controls} controls
   */
  constructor(enabled, events, parent, controls) {
    super(parent, controls)

    /** @private */
    this.enabled_ = enabled

    /** @private */
    this.button_ = document.createElement('button')
    this.button_.classList.add('transcribe-button', 'shaka-tooltip')

    // eslint-disable-next-line no-new
    new shaka.ui.Icon(this.button_, PlayerIcons.TRANSCRIBE)

    const label = document.createElement('label')
    label.classList.add(
      'shaka-overflow-button-label',
      'shaka-overflow-menu-only',
      'shaka-simple-overflow-button-label-inline'
    )

    /** @private */
    this.nameSpan_ = document.createElement('span')
    label.appendChild(this.nameSpan_)

    this.button_.appendChild(label)

    this.parent.appendChild(this.button_)

    this.eventManager.listen(this.button_, 'click', () => {
      if (this.enabled_) {
        events.dispatchEvent(new CustomEvent('transcribe'))
      }
    })

    this.eventManager.listen(events, 'localeChanged', () => {
      this.updateLocalisedStrings_()
    })

    this.updateLocalisedStrings_()
    this.checkAvailability()
  }

  /** @private */
  updateLocalisedStrings_() {
    const label = addKeyboardShortcutToActionTitle(
      i18n.global.t('Video.Player.Transcribe.Transcribe'),
      KeyboardShortcuts.VIDEO_PLAYER.GENERAL.TRANSCRIBE
    )
    this.nameSpan_.textContent = this.button_.ariaLabel = label
  }

  /** @override */
  checkAvailability() {
    // No IPC layer (web build) or no service configured means no button at all.
    if (!this.enabled_ || this.isSubMenuOpened) {
      this.button_.classList.add('shaka-hidden')
    } else {
      this.button_.classList.remove('shaka-hidden')
    }
  }
}
