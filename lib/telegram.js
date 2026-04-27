// lib/telegram.js
// Telegram public-channel scraper. Uses the t.me/s/<channel> server-
// rendered preview page — no auth required for public channels, no
// phone-number / API-id tax. Trade-off: paginated to last ~20 posts
// per fetch and HTML structure could change.
//
// If we hit scale or rate-limit issues later, swap to GramJS
// (https://gram.js.org) which uses MTProto + a service-account session.
// That requires a phone-number-bound Telegram account + my.telegram.org
// API id/hash. Defer until needed.
//
// Each post in the preview HTML is wrapped in:
//   <div class="tgme_widget_message" data-post="channel/12345">
//     <a class="tgme_widget_message_date" href="https://t.me/channel/12345">
//       <time datetime="2026-04-27T..."/>
//     </a>
//     <div class="tgme_widget_message_text js-message_text">...post body HTML...</div>
//   </div>

'use strict';

const UA = 'Mozilla/5.0 (compatible; Sentinel/0.1; defensive monitoring; contact: david@parallaxadvisory.llc)';

async function fetchChannelPosts(channel, opts) {
  const o = opts || {};
  const url = `https://t.me/s/${encodeURIComponent(channel)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
  if (!r.ok) throw new Error(`telegram t.me/s/${channel} ${r.status}`);
  const html = await r.text();
  return parsePosts(html, channel, o.maxPosts || 20);
}

// Lightweight regex-based parser. tgme HTML is simple enough that we
// don't need a full DOM lib for this. Each message div is independent.
function parsePosts(html, channel, maxPosts) {
  const posts = [];
  // Match each tgme_widget_message div block. We split conservatively
  // and look at each chunk individually.
  const blockRe = /<div\s+class="tgme_widget_message[^"]*"[^>]*data-post="([^"]+)"[\s\S]*?(?=<div\s+class="tgme_widget_message[^"]*"\s+|$)/g;
  let m;
  while ((m = blockRe.exec(html)) !== null && posts.length < maxPosts) {
    const dataPost = m[1];                                // 'channel/12345'
    const block = m[0];

    // Extract datetime
    let datetime = null;
    const dtMatch = /<time[^>]+datetime="([^"]+)"/.exec(block);
    if (dtMatch) datetime = dtMatch[1];

    // Extract text body (strip HTML tags but preserve newlines from <br>)
    let text = '';
    const bodyMatch = /<div\s+class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);
    if (bodyMatch) {
      text = bodyMatch[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
    }

    // Author: in public channels, the channel itself is the author. Some
    // posts have a "via @..." attribution; we ignore that for v1.
    const author = channel;

    // Optional view count
    let views = null;
    const viewsMatch = /class="tgme_widget_message_views">([^<]+)</.exec(block);
    if (viewsMatch) views = viewsMatch[1].trim();

    posts.push({
      id: dataPost,                                       // channel/12345 — globally unique
      text,
      author,
      channel,
      permalink: `https://t.me/${dataPost}`,
      created_at: datetime ? new Date(datetime) : null,
      views,
      raw: { dataPost, datetime, views }
    });
  }
  return posts;
}

module.exports = { fetchChannelPosts, parsePosts, UA };
