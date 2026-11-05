import type { APIRoute } from 'astro';

import { pages as docs } from '../lib/docs';

const pages = ['/', '/directory', '/docs', ...docs.map((d) => `/docs/${d.slug}`), '/guidelines', '/privacy'];

export const GET: APIRoute = ({ site }) => {
  const urls = pages.map((p) => `  <url><loc>${new URL(p, site).toString()}</loc></url>`).join('\n');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, {
    headers: { 'Content-Type': 'application/xml' },
  });
};
