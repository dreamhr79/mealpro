(() => {
  const KEY = 'mealpro-cache-reset-v1';
  if (sessionStorage.getItem(KEY)) return;
  sessionStorage.setItem(KEY, '1');
  const clear = async () => {
    try {
      const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
      await Promise.all(regs.map(r => r.unregister()));
      const keys = await caches?.keys?.() || [];
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch (_) {}
    location.reload();
  };
  if ('serviceWorker' in navigator || 'caches' in window) clear();
})();
