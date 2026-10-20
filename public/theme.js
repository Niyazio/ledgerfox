/* global localStorage, window, document */
try {
  var t = localStorage.getItem("arthika-theme");
  if (t === "dark" || (!t && window.matchMedia("(prefers-color-scheme: dark)").matches)) document.documentElement.classList.add("dark");
} catch {
  /* storage unavailable: fall back to light theme */
}
