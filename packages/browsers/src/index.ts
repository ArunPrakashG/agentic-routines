// Every browser Browser Routines can connect to, in one place. `setup` reads it to register the
// native host, and the release scripts read it to know what to build. Adding a browser is one entry.

export type Engine = 'chromium' | 'gecko';
export type OS = 'darwin' | 'linux' | 'win32';

export interface Browser {
  id: string;
  name: string;
  engine: Engine;
  /** Where its data lives, per OS, under the home folder (Windows: under %LOCALAPPDATA%, or %APPDATA% for Gecko). Present means installed. */
  profile: Partial<Record<OS, string>>;
  /** The folder holding native messaging manifests, per OS, under the home folder. */
  hosts: Partial<Record<'darwin' | 'linux', string>>;
  /** Windows reads native messaging hosts from this key under HKEY_CURRENT_USER. */
  registry?: string;
  /** The store where people install the extension from. Filled in once it is listed. */
  store?: string;
}

const chromium = (b: Omit<Browser, 'engine'>): Browser => ({ engine: 'chromium', ...b });

export const BROWSERS: Browser[] = [
  chromium({
    id: 'chrome',
    name: 'Chrome',
    profile: { darwin: 'Library/Application Support/Google/Chrome', linux: '.config/google-chrome', win32: 'Google/Chrome/User Data' },
    hosts: { darwin: 'Library/Application Support/Google/Chrome/NativeMessagingHosts', linux: '.config/google-chrome/NativeMessagingHosts' },
    registry: 'Software\\Google\\Chrome\\NativeMessagingHosts',
  }),
  chromium({
    id: 'chromium',
    name: 'Chromium',
    profile: { darwin: 'Library/Application Support/Chromium', linux: '.config/chromium', win32: 'Chromium/User Data' },
    hosts: { darwin: 'Library/Application Support/Chromium/NativeMessagingHosts', linux: '.config/chromium/NativeMessagingHosts' },
    registry: 'Software\\Chromium\\NativeMessagingHosts',
  }),
  chromium({
    id: 'edge',
    name: 'Edge',
    profile: { darwin: 'Library/Application Support/Microsoft Edge', linux: '.config/microsoft-edge', win32: 'Microsoft/Edge/User Data' },
    hosts: { darwin: 'Library/Application Support/Microsoft Edge/NativeMessagingHosts', linux: '.config/microsoft-edge/NativeMessagingHosts' },
    registry: 'Software\\Microsoft\\Edge\\NativeMessagingHosts',
  }),
  chromium({
    id: 'brave',
    name: 'Brave',
    profile: { darwin: 'Library/Application Support/BraveSoftware/Brave-Browser', linux: '.config/BraveSoftware/Brave-Browser', win32: 'BraveSoftware/Brave-Browser/User Data' },
    hosts: { darwin: 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts', linux: '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts' },
    registry: 'Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
  }),
  chromium({
    id: 'vivaldi',
    name: 'Vivaldi',
    profile: { darwin: 'Library/Application Support/Vivaldi', linux: '.config/vivaldi', win32: 'Vivaldi/User Data' },
    hosts: { darwin: 'Library/Application Support/Vivaldi/NativeMessagingHosts', linux: '.config/vivaldi/NativeMessagingHosts' },
    // Vivaldi on Windows reads Chrome's key.
    registry: 'Software\\Google\\Chrome\\NativeMessagingHosts',
  }),
  chromium({
    id: 'arc',
    name: 'Arc',
    profile: { darwin: 'Library/Application Support/Arc/User Data' },
    hosts: { darwin: 'Library/Application Support/Arc/User Data/NativeMessagingHosts' },
  }),
  {
    id: 'firefox',
    name: 'Firefox',
    engine: 'gecko',
    profile: { darwin: 'Library/Application Support/Firefox', linux: '.mozilla/firefox', win32: 'Mozilla/Firefox' },
    hosts: { darwin: 'Library/Application Support/Mozilla/NativeMessagingHosts', linux: '.mozilla/native-messaging-hosts' },
    registry: 'Software\\Mozilla\\NativeMessagingHosts',
  },
];

/** Extension ids the native host accepts. The first is the unpacked build, whose id the manifest key pins. Store ids are added when each listing exists. */
export const EXTENSION_IDS: Record<Engine, string[]> = {
  chromium: ['fafmcnlaedchfncjiimcndjlfphdfkdo'],
  gecko: ['browser-routines@browser-routines.dev'],
};

/** The native messaging manifest for a browser. */
export function hostManifest(b: Browser, name: string, path: string) {
  return {
    name,
    description: 'Browser Routines',
    path,
    type: 'stdio' as const,
    ...(b.engine === 'gecko'
      ? { allowed_extensions: EXTENSION_IDS.gecko }
      : { allowed_origins: EXTENSION_IDS.chromium.map((id) => `chrome-extension://${id}/`) }),
  };
}
