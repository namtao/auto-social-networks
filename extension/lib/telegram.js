// Optional Telegram delivery: digest of the best posts and alerts from scheduled runs.

import { telegramReady } from './settings.js';

const MAX_MESSAGE = 4000; // Telegram limit is 4096 characters

const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function send(s, html) {
  const res = await fetch(`https://api.telegram.org/bot${s.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: s.telegramChatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(30e3),
  });
  if (!res.ok) throw new Error(`Telegram trả lỗi HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Best effort: a failing alert must not hide the error that triggered it.
export async function alert(s, text) {
  if (!telegramReady(s)) return;
  try {
    await send(s, `⚠️ <b>FB digest</b>: ${escape(text)}`);
  } catch (err) {
    console.warn('Could not send alert', text, err);
  }
}

function formatPost(row) {
  const tags = (row.tags || []).map((t) => `#${t.replace(/ /g, '_')}`).join(' ');
  const author = escape(row.author || '?');
  const title = row.link ? `<a href="${escape(row.link)}">${author}</a>` : `<b>${author}</b>`;
  return `<b>[${row.score}]</b> ${title}\n${escape(row.summary || '')}\n${escape(tags)}`.trim();
}

// Pack posts into as few messages as fit under Telegram's size limit.
export async function sendDigest(s, rows) {
  const chunks = [];
  let current = `📰 <b>FB digest</b> (${rows.length} bài)`;
  for (const row of rows) {
    const entry = formatPost(row);
    if (current.length + entry.length + 2 > MAX_MESSAGE) {
      chunks.push(current);
      current = entry;
    } else {
      current += `\n\n${entry}`;
    }
  }
  chunks.push(current);
  for (const chunk of chunks) await send(s, chunk);
}
