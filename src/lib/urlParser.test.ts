import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCanonicalDouyinUrl,
  extractHtmlRedirectUrl,
  extractRawUrls,
  isShortUrl,
  parseAndResolveDouyinUrl,
  parseBatchInput,
  parseDouyinUrl,
  resolveParsedLinks,
  resolveShortUrlRedirect,
} from './urlParser';

test('extractRawUrls parses pasted Douyin share copy text, CJK-adjacent URLs, bare domains, and strips trailing punctuation', () => {
  const pasted = `
    4.82 复制打开抖音，看看【摄影日记】的作品 https://v.douyin.com/iRNBhojb/复制此链接，打开Dou音搜索，直接观看视频！
    https://www.douyin.com/user/MS4wLjABAAAA6O7EZyfDRYXxJrUTpf91K3tmB4rBROkAw-nYMfld8ss，
    v.douyin.com/abc12345/
    (https://www.douyin.com/collection/7234567890123456789)
    m.douyin.com/share/slides/7394812345678901111/
    douyin.com/note/7394812345678902222
  `;
  const urls = extractRawUrls(pasted);
  assert.deepEqual(urls, [
    'https://v.douyin.com/iRNBhojb/',
    'https://www.douyin.com/user/MS4wLjABAAAA6O7EZyfDRYXxJrUTpf91K3tmB4rBROkAw-nYMfld8ss',
    'https://v.douyin.com/abc12345/',
    'https://www.douyin.com/collection/7234567890123456789',
    'https://m.douyin.com/share/slides/7394812345678901111/',
    'https://douyin.com/note/7394812345678902222',
  ]);
});

test('parseDouyinUrl classifies all user homepage formats accurately', () => {
  const cases = [
    [
      'https://www.douyin.com/user/MS4wLjABAAAA_test_uid',
      'MS4wLjABAAAA_test_uid',
    ],
    [
      'https://www.douyin.com/user/MS4wLjABAAAA_test_uid?from_tab_name=main&relation=0',
      'MS4wLjABAAAA_test_uid',
    ],
    [
      'https://www.iesdouyin.com/share/user/MS4wLjABAAAA_share_uid/',
      'MS4wLjABAAAA_share_uid',
    ],
    [
      'https://iesdouyin.com/share/user/?sec_uid=MS4wLjABAAAA_query_uid&u_code=123',
      'MS4wLjABAAAA_query_uid',
    ],
    [
      'https://m.douyin.com/share/user/?sec_user_id=MS4wLjABAAAA_mobile_uid',
      'MS4wLjABAAAA_mobile_uid',
    ],
    [
      'https://www.douyin.com/profile/MS4wLjABAAAA_profile_uid',
      'MS4wLjABAAAA_profile_uid',
    ],
    ['https://www.douyin.com/user/self?showTab=post', 'self'],
  ] as const;

  for (const [url, expectedId] of cases) {
    const parsed = parseDouyinUrl(url);
    assert.equal(parsed.type, 'user', `expected user for ${url}`);
    assert.equal(parsed.targetId, expectedId, `expected id ${expectedId} for ${url}`);
    assert.equal(parsed.supported, true);
  }
});

test('parseDouyinUrl classifies all collection/mix formats accurately', () => {
  const cases = [
    [
      'https://www.douyin.com/collection/7234567890123456789',
      '7234567890123456789',
    ],
    [
      'https://www.douyin.com/collection/7234567890123456789/12',
      '7234567890123456789',
    ],
    [
      'https://www.douyin.com/mix/detail/7234567890123456789',
      '7234567890123456789',
    ],
    [
      'https://www.iesdouyin.com/share/mix/detail/7234567890123456789/?region=CN',
      '7234567890123456789',
    ],
    [
      'https://iesdouyin.com/share/mix/detail/7234567890123456789/',
      '7234567890123456789',
    ],
    [
      'https://www.douyin.com/share/collection/7234567890123456789',
      '7234567890123456789',
    ],
    [
      'https://www.douyin.com/user/MS4wLjABAAAA123?mix_id=7234567890123456789',
      '7234567890123456789',
    ],
    [
      'https://www.douyin.com/user/MS4wLjABAAAA123?collection_id=7234567890123456789',
      '7234567890123456789',
    ],
  ] as const;

  for (const [url, expectedId] of cases) {
    const parsed = parseDouyinUrl(url);
    assert.equal(parsed.type, 'collection', `expected collection for ${url}`);
    assert.equal(parsed.targetId, expectedId, `expected id ${expectedId} for ${url}`);
    assert.equal(parsed.supported, true);
  }
});

test('parseDouyinUrl classifies all gallery/photo-note formats accurately', () => {
  const cases = [
    ['https://www.douyin.com/note/7394812345678901111', '7394812345678901111'],
    ['https://www.douyin.com/slides/7394812345678901111', '7394812345678901111'],
    ['https://www.douyin.com/gallery/7394812345678901111', '7394812345678901111'],
    ['https://www.douyin.com/image/7394812345678901111', '7394812345678901111'],
    ['https://www.douyin.com/tuwen/7394812345678901111', '7394812345678901111'],
    [
      'https://www.iesdouyin.com/share/slides/7394812345678901111/',
      '7394812345678901111',
    ],
    [
      'https://iesdouyin.com/share/note/7394812345678901111/',
      '7394812345678901111',
    ],
    [
      'https://m.douyin.com/share/slides/7394812345678901111?region=CN',
      '7394812345678901111',
    ],
    [
      'https://www.douyin.com/note/7394812345678901111?modal_id=7394812345678901111',
      '7394812345678901111',
    ],
    [
      'https://www.douyin.com/discover?modal_id=7394812345678901111&is_note=1',
      '7394812345678901111',
    ],
  ] as const;

  for (const [url, expectedId] of cases) {
    const parsed = parseDouyinUrl(url);
    assert.equal(parsed.type, 'gallery', `expected gallery for ${url}`);
    assert.equal(parsed.targetId, expectedId, `expected id ${expectedId} for ${url}`);
    assert.equal(parsed.supported, true);
  }
});

test('parseDouyinUrl classifies videos, modal_id, music, live, and distinguishes short links from iesdouyin share URLs', () => {
  const video = parseDouyinUrl('https://www.douyin.com/video/7394812345678901234');
  assert.equal(video.type, 'video');
  assert.equal(video.targetId, '7394812345678901234');

  const modal = parseDouyinUrl(
    'https://www.douyin.com/user/MS4wLjABAAAA123?modal_id=7394812345678909999',
  );
  assert.equal(modal.type, 'video');
  assert.equal(modal.targetId, '7394812345678909999');

  const live = parseDouyinUrl('https://live.douyin.com/80017709309');
  assert.equal(live.type, 'live');
  assert.equal(live.targetId, '80017709309');

  const music = parseDouyinUrl('https://www.iesdouyin.com/share/music/7112233445566778899/');
  assert.equal(music.type, 'music');
  assert.equal(music.targetId, '7112233445566778899');

  assert.equal(isShortUrl('v.douyin.com/test123/'), true);
  assert.equal(isShortUrl('https://v.iesdouyin.com/abc999/'), true);
  assert.equal(isShortUrl('https://d.douyin.com/xyz789/'), true);
  assert.equal(isShortUrl('https://iesdouyin.com/abc12345/'), true);
  assert.equal(isShortUrl('https://iesdouyin.com/share/slides/7394812345678901111/'), false);
  assert.equal(isShortUrl('https://iesdouyin.com/share/user/MS4wLjABAAAA123/'), false);
});

test('parseDouyinUrl rejects lvdetail encrypted long videos and unknown hosts clearly', () => {
  const lv = parseDouyinUrl('https://www.douyin.com/lvdetail/7331203341890049058');
  assert.equal(lv.type, 'lvdetail');
  assert.equal(lv.supported, false);
  assert.match(lv.reason || '', /MPEG-CENC/);

  const unknown = parseDouyinUrl('https://example.com/video/123');
  assert.equal(unknown.type, 'unsupported');
  assert.equal(unknown.supported, false);
});

test('parseBatchInput deduplicates repeated URLs across casing and trailing slashes', () => {
  const result = parseBatchInput(
    'https://www.douyin.com/video/123456\nhttps://WWW.DOUYIN.COM/video/123456/\nhttps://www.douyin.com/note/999',
  );
  assert.equal(result.links.length, 2);
  assert.equal(result.duplicatesRemoved, 1);
});

test('resolveShortUrlRedirect follows multi-hop redirects and re-parses collection, gallery, and user links', async () => {
  const redirectMap = new Map<string, { status: number; location?: string; html?: string }>([
    [
      'https://v.douyin.com/mixHop1/',
      { status: 302, location: 'https://v.iesdouyin.com/mixHop2/' },
    ],
    [
      'https://v.iesdouyin.com/mixHop2/',
      {
        status: 301,
        location:
          'https://www.iesdouyin.com/share/mix/detail/7234567890123456789/?region=CN',
      },
    ],
    [
      'https://v.douyin.com/galleryShort/',
      {
        status: 302,
        location: 'https://www.iesdouyin.com/share/slides/7394812345678901111/',
      },
    ],
    [
      'https://v.douyin.com/userShort/',
      {
        status: 302,
        location:
          'https://www.iesdouyin.com/share/user/?sec_uid=MS4wLjABAAAA_from_short',
      },
    ],
    [
      'https://v.douyin.com/htmlRefresh/',
      {
        status: 200,
        html: '<html><head><meta http-equiv="refresh" content="0;url=https://www.douyin.com/note/7394812345678902222"></head></html>',
      },
    ],
    [
      'https://v.douyin.com/ssrfAttempt/',
      {
        status: 302,
        location: 'http://169.254.169.254/latest/meta-data/',
      },
    ],
  ]);

  const mockFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const entry = redirectMap.get(url);
    if (!entry) {
      return new Response('not found', { status: 404 });
    }
    const headers = new Headers();
    if (entry.location) headers.set('location', entry.location);
    if (entry.html) headers.set('content-type', 'text/html; charset=utf-8');
    return new Response(entry.html || '', {
      status: entry.status,
      headers,
    });
  }) as typeof fetch;

  const mixHop = await resolveShortUrlRedirect('https://v.douyin.com/mixHop1/', {
    fetchImpl: mockFetch,
  });
  assert.ok(mixHop);
  assert.equal(mixHop.hops, 2);
  assert.equal(
    mixHop.resolvedUrl,
    'https://www.iesdouyin.com/share/mix/detail/7234567890123456789/?region=CN',
  );

  const mixParsed = await parseAndResolveDouyinUrl('https://v.douyin.com/mixHop1/', {
    fetchImpl: mockFetch,
  });
  assert.equal(mixParsed.type, 'collection');
  assert.equal(mixParsed.targetId, '7234567890123456789');
  assert.equal(
    mixParsed.resolvedUrl,
    'https://www.douyin.com/collection/7234567890123456789',
  );

  const batch = parseBatchInput(
    'https://v.douyin.com/galleryShort/\nhttps://v.douyin.com/userShort/\nhttps://v.douyin.com/htmlRefresh/\nhttps://v.douyin.com/ssrfAttempt/',
  );
  const resolved = await resolveParsedLinks(batch.links, { fetchImpl: mockFetch });

  assert.equal(resolved[0].type, 'gallery');
  assert.equal(resolved[0].targetId, '7394812345678901111');
  assert.equal(resolved[0].resolvedUrl, 'https://www.douyin.com/note/7394812345678901111');

  assert.equal(resolved[1].type, 'user');
  assert.equal(resolved[1].targetId, 'MS4wLjABAAAA_from_short');
  assert.equal(
    resolved[1].resolvedUrl,
    'https://www.douyin.com/user/MS4wLjABAAAA_from_short',
  );

  assert.equal(resolved[2].type, 'gallery');
  assert.equal(resolved[2].targetId, '7394812345678902222');

  // SSRF redirect must be rejected cleanly and stay unresolved
  assert.equal(resolved[3].type, 'short');
  assert.equal(resolved[3].resolvedUrl, undefined);

  // Pure helpers check
  assert.equal(
    extractHtmlRedirectUrl(
      '<link rel="canonical" href="https://www.douyin.com/user/MS4wLjABAAAA_canon">',
      'https://v.douyin.com/x/',
    ),
    'https://www.douyin.com/user/MS4wLjABAAAA_canon',
  );
  assert.equal(
    buildCanonicalDouyinUrl('collection', '7234567890123456789'),
    'https://www.douyin.com/collection/7234567890123456789',
  );
});
