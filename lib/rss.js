// lib/rss.js
// RSS fetcher for v1: per-target queries via Google News RSS. This
// gives us dynamic news coverage of every target without per-customer
// feed config — paste the target name, get an RSS feed.
//
// URL pattern:
//   https://news.google.com/rss/search?q=<encoded>&hl=en-US&gl=US&ceid=US:en
//
// Items contain title, link (Google News redirect), pubDate, description
// (HTML snippet incl. publisher), source (publisher tag), and a guid.
// source_id = guid (falls back to link).
//
// For richer per-customer feeds (state papers, candidate-specific
// blogs) we'll add an `rss_feeds` table in v2.

'use strict';

const { XMLParser } = require('fast-xml-parser');

const UA = 'Sentinel/0.1 (defensive monitoring; contact: david@parallaxadvisory.llc)';
const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });

function googleNewsUrlForQuery(q) {
  const encoded = encodeURIComponent(q);
  return `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;
}

async function fetchGoogleNews(query) {
  const url = googleNewsUrlForQuery(query);
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml' } });
  if (!r.ok) throw new Error(`google news rss ${r.status}`);
  const xml = await r.text();
  const j = parser.parse(xml);
  // Single-item channels return an object, multi-item return an array.
  let items = j?.rss?.channel?.item || [];
  if (!Array.isArray(items)) items = [items];
  return items.map(it => normalizeItem(it));
}

function normalizeItem(it) {
  const id = it.guid?.['#text'] || it.guid || it.link || '';
  const description = stripHtml(String(it.description || ''));
  return {
    id: String(id),
    title: String(it.title || ''),
    body: description,
    link: String(it.link || ''),
    source_publisher: String(it.source?.['#text'] || it.source || ''),
    pub_date: it.pubDate ? new Date(it.pubDate) : null,
    raw: it
  };
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { fetchGoogleNews, googleNewsUrlForQuery, UA };
