// User settings, kept in chrome.storage.local only: the LLM key and Telegram token never sync.

export const DEFAULTS = {
  llmUrl: '',
  llmKey: '',
  llmModel: '',
  scoreThreshold: 7,
  interests: '',
  sourceDays: 2,
  telegramToken: '',
  telegramChatId: '',
  autoRun: false,
  runTimes: '08:00, 13:00, 20:00',
  remoteOpsUrl: 'https://gist.githubusercontent.com/namtao/e88f19c9790479f84d21da4392c896bd/raw/ops.json',
};

// Earlier default config URLs that no longer serve the file; a saved one moves to the current default.
const RETIRED_REMOTE_URLS = ['https://raw.githubusercontent.com/namtao/auto-social-networks/main/extension/ops.json'];

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...settings };
  if (RETIRED_REMOTE_URLS.includes(s.remoteOpsUrl)) s.remoteOpsUrl = DEFAULTS.remoteOpsUrl;
  return s;
}

export async function saveSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  s.llmUrl = String(s.llmUrl || '').trim().replace(/\/+$/, '');
  s.scoreThreshold = Math.min(10, Math.max(0, parseInt(s.scoreThreshold, 10) || DEFAULTS.scoreThreshold));
  s.sourceDays = Math.max(1, parseInt(s.sourceDays, 10) || DEFAULTS.sourceDays);
  await chrome.storage.local.set({ settings: s });
  return s;
}

// LLM scoring runs once the person has given an endpoint and a model; a local router often needs no key.
export const llmReady = (s) => !!(s.llmUrl && s.llmModel);
export const telegramReady = (s) => !!(s.telegramToken && s.telegramChatId);

export async function getSources() {
  const { sources } = await chrome.storage.local.get('sources');
  return sources || [];
}

export async function saveSources(sources) {
  await chrome.storage.local.set({ sources });
  return sources;
}
