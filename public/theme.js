// The app moved to foxlator.niyazio.com: browsers on the old address go there, keeping the page they asked for.
// Installed desktop / Android apps of older versions stay on the old address (it still serves them) until they update.
try {
  if (location.hostname === "ledgerfox.niyazio.com" && !/Electron\//.test(navigator.userAgent) && !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) {
    location.replace("https://foxlator.niyazio.com" + location.pathname + location.search + location.hash);
  }
} catch {
  /* never block the page */
}
// Applies the saved appearance before the page paints (no flash): mode, accent colour and background style.
try {
  var t = localStorage.getItem("ledgerfox-theme");
  if (t === "dark" || ((!t || t === "auto") && window.matchMedia("(prefers-color-scheme: dark)").matches)) document.documentElement.classList.add("dark");
  var a = localStorage.getItem("ledgerfox-accent");
  if (a) document.documentElement.dataset.accent = a;
  var b = localStorage.getItem("ledgerfox-bg");
  if (b) document.documentElement.dataset.bg = b;
} catch {
  /* storage unavailable: fall back to the default light theme */
}
