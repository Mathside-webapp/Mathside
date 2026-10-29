/* Mathside Android push registration. Never send FCM messages from this browser file.
 * Device tokens are associated with authenticated Supabase users by an RPC.
 * See supabase/sql/08-firebase-push-devices.sql.
 */
(function (root) {
  'use strict';
  let database = null;
  let userId = null;
  let registeredToken = null;
  let listenersReady = false;
  let listening = null;
  let registrationBusy = false;
  let permissionDenied = false;
  const boundButtons = new WeakSet();

  function nativePlugin() {
    const bridge = root.Capacitor;
    if (!bridge || typeof bridge.isNativePlatform !== 'function' || !bridge.isNativePlatform()) return null;
    if (typeof bridge.getPlatform === 'function' && bridge.getPlatform() !== 'android') return null;
    return bridge.Plugins && bridge.Plugins.PushNotifications || null;
  }

  function report(error, context) {
    // Missing SQL or denied permission must never block Mathside login.
    root.console?.warn?.('[Mathside Push] ' + context, error?.message || error);
  }

  async function saveToken(token) {
    const destination = userId;
    const db = database;
    if (!db || !destination || !token) return;
    const { error } = await db.rpc('mathside_register_push_device', {
      p_token: token,
      p_platform: 'android'
    });
    if (error) throw error;
  }

  function showForegroundNotification(notification) {
    // The native plugin handles background notifications; a quiet banner is enough in-app.
    if (!root.document?.body) return;
    const old = root.document.getElementById('mathside-push-banner');
    old?.remove();
    const banner = root.document.createElement('div');
    banner.id = 'mathside-push-banner';
    banner.setAttribute('role', 'status');
    const strong = root.document.createElement('strong');
    strong.textContent = String(notification?.title || 'Mathside notification').slice(0, 120);
    const body = root.document.createElement('span');
    body.textContent = String(notification?.body || '').slice(0, 220);
    const close = root.document.createElement('button');
    close.type = 'button';
    close.textContent = '\u00d7';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.addEventListener('click', () => banner.remove());
    banner.append(strong, body, close);
    root.document.body.appendChild(banner);
    root.setTimeout?.(() => banner.remove(), 6500);
  }

  async function attachListeners(plugin) {
    if (listenersReady) return;
    if (listening) return listening;
    listening = (async () => {
      await plugin.addListener('registration', async info => {
        const token = String(info?.value || '').trim();
        if (!token) return;
        registeredToken = token;
        try { await saveToken(token); } catch (error) { report(error, 'Cannot save device token. Run 08-firebase-push-devices.sql.'); }
      });
      await plugin.addListener('registrationError', error => report(error, 'Firebase registration failed'));
      await plugin.addListener('pushNotificationReceived', showForegroundNotification);
      await plugin.addListener('pushNotificationActionPerformed', () => {
        // Capacitor opens the app; do not navigate to untrusted URLs in push payloads.
      });
      listenersReady = true;
    })();
    try { await listening; } finally { listening = null; }
  }

  async function enable() {
    const plugin = nativePlugin();
    if (!plugin || !userId || !database || registrationBusy) return false;
    registrationBusy = true;
    try {
      await attachListeners(plugin);
      let permission = await plugin.checkPermissions();
      if (permission.receive !== 'granted') permission = await plugin.requestPermissions();
      if (permission.receive !== 'granted') {
        permissionDenied = true;
        return false;
      }
      permissionDenied = false;
      if (registeredToken) await saveToken(registeredToken);
      await plugin.register(); // asynchronously fires 'registration' with an FCM token
      return true;
    } catch (error) {
      report(error, 'Could not enable Android notifications');
      return false;
    } finally {
      registrationBusy = false;
    }
  }

  async function signIn(db, id) {
    database = db;
    userId = String(id || '') || null;
    const plugin = nativePlugin();
    if (!plugin || !userId) return false;
    root.document?.documentElement?.classList.add('mathside-native-android');
    root.document?.querySelectorAll('[data-mathside-push-enable]')?.forEach(button => {
      if (boundButtons.has(button)) return;
      boundButtons.add(button);
      button.addEventListener('click', async () => {
        if (registrationBusy) return;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        try { await enable(); }
        finally {
          button.disabled = false;
          button.removeAttribute('aria-busy');
        }
      });
    });
    // Crucial: don't request Android notification permission during login,
    // dashboard restore, or app startup. Permission is explicitly requested
    // only when the user taps "Enable notifications" in the dashboard.
    return true;
  }

  async function signOut() {
    // Deactivate this phone before ending the Supabase session.
    if (database && registeredToken && userId) {
      try {
        const { error } = await database.rpc('mathside_unregister_push_device', { p_token: registeredToken });
        if (error) throw error;
      } catch (error) { report(error, 'Could not unregister this phone'); }
    }
    localSignOut();
  }

  function localSignOut() {
    database = null;
    userId = null;
    root.document?.getElementById('mathside-push-banner')?.remove();
  }

  root.MathsidePush = { signIn, signOut, localSignOut, enable, available: () => Boolean(nativePlugin()), permissionDenied: () => permissionDenied };
})(window);
