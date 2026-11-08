// The one page a service worker may keep out of sight, which browsers allow only one of. Hooks use it where the build has them,
// and video is made there, because making it needs a canvas.

const hasHooks = () => !!(browser.runtime.getManifest() as { sandbox?: unknown }).sandbox;

export async function ensureOffscreen() {
  const off = (browser as unknown as { offscreen?: { hasDocument?: () => Promise<boolean>; createDocument: (o: object) => Promise<void> } }).offscreen;
  if (!off) throw new Error('This browser cannot make a video.');
  if (await off.hasDocument?.()) return;
  try {
    await off.createDocument({
      // The page cannot read the manifest itself, so it is told here whether to frame the sandbox.
      url: hasHooks() ? 'offscreen.html?hooks' : 'offscreen.html',
      reasons: hasHooks() ? ['IFRAME_SCRIPTING', 'BLOBS'] : ['BLOBS'],
      justification: 'Makes a video from pictures of a tab, and runs the hooks of a routine in a sandbox that cannot reach the network.',
    });
  } catch (e) {
    if (!/single|already/i.test((e as Error).message)) throw e;
  }
}
