// Is this page a bot check or a refusal rather than the page that was asked for? Only ever reported and handed to the
// person: nothing here or anywhere else tries to get past one.

const MARKS: [string, string][] = [
  ['Cloudflare', '#challenge-form, #challenge-running, #cf-challenge-running, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]'],
  ['reCAPTCHA', 'iframe[src*="recaptcha"][src*="anchor"]:not([src*="size=invisible"]), .g-recaptcha:not([data-size="invisible"])'],
  ['hCaptcha', 'iframe[src*="hcaptcha.com"]:not([src*="size=invisible"]), .h-captcha:not([data-size="invisible"])'],
  ['DataDome', 'iframe[src*="captcha-delivery.com"]'],
  ['PerimeterX', '#px-captcha'],
  ['Akamai', '#sec-if-cpt-container, #sec-overlay'],
  ['Imperva', 'iframe[src*="_Incapsula_Resource"]'],
  ['AWS WAF', '#captcha-container[class*="aws"], awswaf-captcha, script[src*="awswaf.com"][src*="captcha"]'],
];
// A title like this on a page with next to nothing on it. An article can have the same words in its title and much more below.
const REFUSALS = /^(access denied|403 forbidden|forbidden|attention required|just a moment|pardon our interruption|verify you are (a )?human|are you a robot|are you human|security check|request blocked|you have been blocked)\b/i;
const LITTLE = 2000;

export function challengeHere(): string | undefined {
  for (const [kind, css] of MARKS) {
    const e = document.querySelector(css);
    if (e && (e.tagName === 'SCRIPT' || (e as HTMLElement).getClientRects().length)) return kind;
  }
  const title = document.title.trim();
  if (REFUSALS.test(title) && (document.body?.innerText.length ?? 0) < LITTLE) return /denied|forbidden|blocked/i.test(title) ? 'access denied' : 'bot check';
}
