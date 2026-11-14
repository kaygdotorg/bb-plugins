/**
 * Settings previews only: loads a Google Fonts family straight from Google so the picker
 * can show a sample before you choose it. Fonts in use come from the local copy instead.
 */
export function loadGoogleFontPreview(family: string) {
  const id = `cf-font-${family.replace(/[^\w]/g, "-")}`;
  if (document.getElementById(id)) return;
  const name = encodeURIComponent(family).replace(/%20/g, "+");
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.dataset.bbPlugin = "calternal-frame";
  link.href = `https://fonts.googleapis.com/css2?family=${name}:wght@400;500;600;700&display=swap`;
  // Static families without all four weights refuse the range: fall back to the default.
  link.onerror = () => { link.onerror = null; link.href = `https://fonts.googleapis.com/css2?family=${name}&display=swap`; };
  document.head.appendChild(link);
}
