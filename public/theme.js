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
