/**
 * DAT page CSS: always-hide nav items + DAT multitab limits.
 * Add-button enabling matches DAT GO (interval) because Angular
 * renders late and re-disables the + control.
 */

function tabLabelSelectors(suffix) {
  return ['.mat-tab-labels', '.mat-mdc-tab-labels']
    .map((root) => `${root}${suffix}`)
    .join(',\n      ');
}

function buildUiHideCss() {
  return `
    body {
      visibility: visible !important;
      opacity: 1 !important;
    }
    dat-general-banner,
    .dat-general-banner,
    #dat-general-banner {
      display: none !important;
    }
    .details.dropdown-menu hr ~ *,
    .details.dropdown-menu hr {
      display: none !important;
    }
    .searchLoads nav {
      display: none !important;
    }
    .app-message-box {
      display: none !important;
    }
    .stn-wdgt,
    .stn-wdgt-content {
      display: none !important;
    }
    .nav-logo-clickable {
      pointer-events: none !important;
      cursor: not-allowed !important;
    }

    /* Always hide: Private Network */
    a[href="/private-network"] {
      display: none !important;
      pointer-events: none !important;
    }

    /* Always hide: My Loads */
    a[href="/my-loads/list/carrier"],
    a[href^="/my-loads"] {
      display: none !important;
      pointer-events: none !important;
    }

    /* Always hide: My Trucks */
    a[href="/my-trucks"],
    a[href^="/my-trucks"] {
      display: none !important;
      pointer-events: none !important;
    }

    /* Always hide: My Company Profile */
    .link-my-company-profile,
    a[href="/my-company-profile"],
    a[href^="/my-company-profile"] {
      display: none !important;
      pointer-events: none !important;
    }

    /* Always hide: Notifications */
    .nav-notification-inbox,
    .button-notification-inbox-mobile {
      display: none !important;
      pointer-events: none !important;
    }

    /* Always hide: Profile panel */
    .mat-expansion-panel:not([class*=mat-elevation-z]) {
      display: none !important;
      pointer-events: none !important;
    }
  `;
}

function buildDatMultitabCss(permissions = {}) {
  const datMultitab = !!permissions.datMultitab;
  const datMultitabNumbers = Math.min(
    10,
    Math.max(1, Number(permissions.datMultitabNumbers) || 1)
  );

  if (datMultitab) {
    return `
      ${tabLabelSelectors(` > div:nth-child(${datMultitabNumbers + 1}) .add-button`)} {
        display: none !important;
      }
      ${tabLabelSelectors(
        ` > div:nth-child(n+${datMultitabNumbers + 1}):nth-child(-n+10):not(:last-child)`
      )} {
        display: none !important;
      }
    `;
  }

  return `
    ${tabLabelSelectors(' .add-button')} {
      display: none !important;
    }
    ${tabLabelSelectors(' > div:nth-child(n+2):nth-child(-n+10)')} {
      display: none !important;
    }
  `;
}

function buildPermissionCss(permissions = {}) {
  return `${buildUiHideCss()}\n${buildDatMultitabCss(permissions)}`;
}

/**
 * DAT GO-style: keep DAT's in-page + enabled. Angular SPA renders the
 * tab strip after did-finish-load and re-disables the button.
 *
 * Runs only when the DOM actually changes (MutationObserver, throttled),
 * instead of a forever 1s interval. Writes only when a button is disabled,
 * so its own changes never re-trigger work.
 */
const DAT_ADD_BUTTON_ENHANCE_SCRIPT = `(() => {
  try {
    const DISABLED_CLASSES = ['mat-button-disabled', 'mat-mdc-button-disabled'];
    const enableAddButtons = () => {
      document.querySelectorAll('.add-button').forEach((button) => {
        if (button.hasAttribute('disabled')) button.removeAttribute('disabled');
        if (button.hasAttribute('aria-disabled')) button.removeAttribute('aria-disabled');
        if (DISABLED_CLASSES.some((c) => button.classList.contains(c))) {
          button.classList.remove(...DISABLED_CLASSES);
        }
        if (button.style.pointerEvents !== 'auto') button.style.pointerEvents = 'auto';
        if (button.style.opacity !== '1') button.style.opacity = '1';
      });
    };
    enableAddButtons();

    if (window.__datDesktopEnhanceObserver) return;
    let scheduled = null;
    const schedule = () => {
      if (scheduled) return;
      scheduled = setTimeout(() => {
        scheduled = null;
        enableAddButtons();
      }, 300);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'class']
    });
    window.__datDesktopEnhanceObserver = observer;
  } catch (e) {}
})();`;

module.exports = {
  buildPermissionCss,
  buildUiHideCss,
  buildDatMultitabCss,
  DAT_ADD_BUTTON_ENHANCE_SCRIPT
};
