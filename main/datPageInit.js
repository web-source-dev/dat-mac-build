'use strict';

/**
 * Builds the script that runs in a DAT page's MAIN world at document-start to:
 *   1. seed the account's localStorage/sessionStorage (only missing keys), and
 *   2. pin the account's device fingerprint (navigator.*, userAgentData, WebGL, timezone).
 *
 * It is injected with CDP `Page.addScriptToEvaluateOnNewDocument` (see tabManager), which
 * is the only way to reach DAT's own world before its scripts run: a sandboxed, context-
 * isolated preload runs in an isolated world DAT never sees, and DAT's Content-Security-
 * Policy blocks an injected inline <script>. The CDP script is immune to CSP and runs in
 * the main world, so DAT reads the pinned values and the seeded session.
 *
 * The function below is serialized to source and called with the account's profile and
 * storage, so it must stay self-contained (no closure references).
 */
function pageInit(P, LS, SS) {
  // --- 1. Seed storage (only keys that are missing, so a renewed session is kept) ---
  try {
    var seedStore = function (store, data) {
      for (var key in data) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
        try {
          if (store.getItem(key) === null) store.setItem(key, data[key]);
        } catch (e) {
          /* ignore quota / access errors per key */
        }
      }
    };
    if (LS) seedStore(window.localStorage, LS);
    if (SS) seedStore(window.sessionStorage, SS);
  } catch (e) {
    /* never break the page because of seeding */
  }

  // --- 2. Device fingerprint ---
  try {
  if (P && typeof P === 'object') {
    // Redefine where the property actually lives. Several navigator getters (deviceMemory,
    // userAgentData, …) sit on Navigator.prototype and are non-configurable on the instance,
    // so defining on the instance silently fails — we must redefine on the prototype.
    var define = function (obj, prop, getter) {
      var desc = { get: getter, configurable: true, enumerable: true };
      var target = obj;
      while (target && !Object.getOwnPropertyDescriptor(target, prop)) {
        target = Object.getPrototypeOf(target);
      }
      if (target) {
        try {
          Object.defineProperty(target, prop, desc);
          return true;
        } catch (e) {
          /* fall through to instance */
        }
      }
      try {
        Object.defineProperty(obj, prop, desc);
        return true;
      } catch (e) {
        return false;
      }
    };

    var nativeToString = Function.prototype.toString;
    var spoofed = new WeakMap();
    var markNative = function (fn, name) {
      try {
        spoofed.set(fn, 'function ' + (name || fn.name || '') + '() { [native code] }');
      } catch (e) {
        /* ignore */
      }
      return fn;
    };
    try {
      var patchedToString = function toString() {
        if (spoofed.has(this)) return spoofed.get(this);
        return nativeToString.call(this);
      };
      markNative(patchedToString, 'toString');
      Function.prototype.toString = patchedToString;
    } catch (e) {
      /* ignore */
    }

    var nav = window.navigator;

    try {
      define(nav, 'webdriver', function () { return false; });
    } catch (e) {
      /* ignore */
    }

    if (P.platform) define(nav, 'platform', function () { return P.platform; });
    if (P.hardwareConcurrency) {
      define(nav, 'hardwareConcurrency', function () { return P.hardwareConcurrency; });
    }
    if (P.deviceMemory) define(nav, 'deviceMemory', function () { return P.deviceMemory; });
    if (P.languages && P.languages.length) {
      define(nav, 'languages', function () { return P.languages.slice(); });
    }
    if (P.language) define(nav, 'language', function () { return P.language; });

    try {
      if (P.uaBrands && P.uaBrands.length) {
        var brands = P.uaBrands.map(function (b) {
          return { brand: b.brand, version: String(b.version) };
        });
        var fullList = P.uaBrands.map(function (b) {
          return { brand: b.brand, version: String(b.version) + '.0.0.0' };
        });
        var highEntropy = {
          architecture: 'x86',
          bitness: '64',
          brands: brands,
          fullVersionList: fullList,
          mobile: !!P.uaMobile,
          model: '',
          platform: P.uaPlatform || 'Windows',
          platformVersion: '15.0.0',
          uaFullVersion: String(P.chromeMajor || '') + '.0.0.0',
          wow64: false
        };
        var uaData = {
          brands: brands,
          mobile: !!P.uaMobile,
          platform: P.uaPlatform || 'Windows',
          getHighEntropyValues: markNative(function (hints) {
            var out = {};
            (hints || []).forEach(function (h) {
              if (h in highEntropy) out[h] = highEntropy[h];
            });
            out.brands = brands;
            out.mobile = !!P.uaMobile;
            out.platform = P.uaPlatform || 'Windows';
            return Promise.resolve(out);
          }, 'getHighEntropyValues'),
          toJSON: markNative(function () {
            return { brands: brands, mobile: !!P.uaMobile, platform: P.uaPlatform || 'Windows' };
          }, 'toJSON')
        };
        define(nav, 'userAgentData', function () { return uaData; });
      }
    } catch (e) {
      /* ignore */
    }

    try {
      var UNMASKED_VENDOR = 0x9245;
      var UNMASKED_RENDERER = 0x9246;
      var GL_VENDOR = 0x1f00;
      var GL_RENDERER = 0x1f01;
      var patchGetParameter = function (proto) {
        if (!proto || !proto.getParameter) return;
        var original = proto.getParameter;
        var wrapped = function getParameter(param) {
          if (param === UNMASKED_VENDOR && P.webglVendor) return P.webglVendor;
          if (param === UNMASKED_RENDERER && P.webglRenderer) return P.webglRenderer;
          if (param === GL_VENDOR) return 'WebKit';
          if (param === GL_RENDERER) return 'WebKit WebGL';
          return original.call(this, param);
        };
        markNative(wrapped, 'getParameter');
        proto.getParameter = wrapped;
      };
      if (window.WebGLRenderingContext) patchGetParameter(window.WebGLRenderingContext.prototype);
      if (window.WebGL2RenderingContext) patchGetParameter(window.WebGL2RenderingContext.prototype);
    } catch (e) {
      /* ignore */
    }

    try {
      if (P.timezone) {
        var OrigDTF = Intl.DateTimeFormat;
        var zoneOffset = function (tz, date) {
          try {
            var dtf = new OrigDTF('en-US', {
              timeZone: tz,
              hourCycle: 'h23',
              year: 'numeric', month: '2-digit', day: '2-digit',
              hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
            var p = {};
            dtf.formatToParts(date).forEach(function (part) { p[part.type] = part.value; });
            var asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
            return -Math.round((asUTC - date.getTime()) / 60000);
          } catch (e) {
            return date.getTimezoneOffset();
          }
        };

        var PatchedDTF = function DateTimeFormat(locale, options) {
          var opts = Object.assign({}, options);
          if (!opts.timeZone) opts.timeZone = P.timezone;
          return new OrigDTF(locale, opts);
        };
        PatchedDTF.prototype = OrigDTF.prototype;
        PatchedDTF.supportedLocalesOf = function (l, o) {
          return OrigDTF.supportedLocalesOf(l, o);
        };
        markNative(PatchedDTF, 'DateTimeFormat');
        try {
          Object.defineProperty(Intl, 'DateTimeFormat', {
            value: PatchedDTF,
            writable: true,
            configurable: true
          });
        } catch (e) {
          try {
            Intl.DateTimeFormat = PatchedDTF;
          } catch (e2) {
            /* ignore */
          }
        }

        var origGetOffset = Date.prototype.getTimezoneOffset;
        var wrappedGetOffset = function getTimezoneOffset() {
          var off = zoneOffset(P.timezone, this);
          return typeof off === 'number' && isFinite(off) ? off : origGetOffset.call(this);
        };
        markNative(wrappedGetOffset, 'getTimezoneOffset');
        Date.prototype.getTimezoneOffset = wrappedGetOffset;
      }
    } catch (e) {
      /* ignore */
    }
  }
  } catch (eSection2) {
    /* never let a fingerprint failure stop the page */
  }
}

/** Build the injectable source string for an account's profile + storage. */
function buildInjection(profile, localStorage, sessionStorage) {
  return (
    '(' + pageInit.toString() + ')(' +
    JSON.stringify(profile || null) + ',' +
    JSON.stringify(localStorage || {}) + ',' +
    JSON.stringify(sessionStorage || {}) +
    ');'
  );
}

module.exports = { buildInjection, pageInit };
