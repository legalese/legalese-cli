// The page the browser shows after browser sign-in, styled like Legalese
// Cloud's AuthKit sign-in page: its logo, Merriweather and its light and dark
// colours. Everything is inline or on Google Fonts, because the callback
// server closes as soon as it has sent the page.

/** AuthKit's branding logo (a black §), 96 px to show at 48 px. */
const LOGO =
  "data:image/png;base64,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";

const FONT =
  "https://fonts.googleapis.com/css2?family=Merriweather:opsz,wdth,wght@18..144,87..112,300..900&amp;display=swap";

export function callbackPage(ok: boolean): string {
  const title = ok ? "Signed in" : "Sign-in failed";
  const note = ok
    ? "You can close this tab and return to the terminal."
    : "Return to the terminal to see what went wrong.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Legalese CLI</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONT}">
<style>
  :root { color-scheme: light dark; --bg: #fcfcfc; --text: #202020; --muted: #646464; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #000; --text: #eee; --muted: #9e9e9e; }
    img { filter: invert(1); }
  }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center; padding: 16px; box-sizing: border-box;
    background: var(--bg); color: var(--text); text-align: center;
    font-family: Merriweather, Georgia, serif;
  }
  main { display: flex; flex-direction: column; align-items: center; gap: 16px; }
  img { width: 48px; height: 48px; }
  h1 { margin: 0; font-size: 24px; line-height: 30px; font-weight: 600; }
  p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.6; }
</style>
</head>
<body>
<main>
  <img src="${LOGO}" alt="Legalese">
  <h1>${title}</h1>
  <p>${note}</p>
</main>
</body>
</html>`;
}
