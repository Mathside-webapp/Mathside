/* Persistent Android Supabase auth sessions.
 * A valid refresh token is saved in Capacitor's app-private Preferences storage,
 * not just transient Android WebView localStorage. This does not remember passwords.
 * Existing localStorage sessions are migrated once during the first Android launch.
 * The browser version continues using Supabase's normal localStorage behavior.
 */
(function (root) {
  'use strict';

  function nativePreferences() {
    const bridge = root.Capacitor;
    if (!bridge || typeof bridge.isNativePlatform !== 'function' || !bridge.isNativePlatform()) return null;
    return bridge.Plugins?.Preferences || null;
  }

  function localGet(key) {
    try { return root.localStorage?.getItem(key) ?? null; } catch { return null; }
  }
  function localSet(key, value) {
    try { root.localStorage?.setItem(key, value); } catch { /* Native Preferences remains source of truth */ }
  }
  function localRemove(key) {
    try { root.localStorage?.removeItem(key); } catch { /* May be unavailable */ }
  }

  const storage = {
    async getItem(key) {
      const preferences = nativePreferences();
      if (preferences) {
        try {
          const { value } = await preferences.get({ key });
          if (value != null) return value;
          // Previous APKs stored the session in WebView localStorage.
          // Preserve that session on the first launch of this version.
          const legacyValue = localGet(key);
          if (legacyValue != null) {
            await preferences.set({ key, value: legacyValue });
            return legacyValue;
          }
          return null;
        } catch (error) {
          root.console?.warn?.('[Mathside Auth] Native storage unavailable', error?.message || error);
        }
      }
      return localGet(key);
    },
    async setItem(key, value) {
      const preferences = nativePreferences();
      if (preferences) {
        try {
          await preferences.set({ key, value });
        } catch (error) {
          root.console?.warn?.('[Mathside Auth] Session saved only in temporary storage', error?.message || error);
        }
      }
      localSet(key, value);
    },
    async removeItem(key) {
      // On explicit sign-out remove both stores so a former session cannot return.
      const preferences = nativePreferences();
      try {
        if (preferences) await preferences.remove({ key });
      } finally {
        localRemove(key);
      }
    }
  };

  root.MathsideAuthStorage = {
    storage,
    isNative: () => Boolean(nativePreferences())
  };
})(window);
